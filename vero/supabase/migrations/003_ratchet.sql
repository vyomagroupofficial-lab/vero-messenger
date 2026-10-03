-- ============================================================================
-- Vero Messenger - Forward secrecy: X3DH prekeys for the Double Ratchet layer
-- ============================================================================
-- Security model (client code: src/core/crypto/ratchet/)
--   * Every device keeps its X25519 identity key (devices.identity_public_key,
--     immutable) and adds an Ed25519 SIGNING key. The signing key signs the
--     identity key ("identity binding") and every signed prekey. Clients pin
--     the signing key on first use and include it in safety numbers; they
--     verify every signature themselves - the server never can (or needs to).
--   * signed_prekeys: ONE current signed prekey per device (rotated weekly by
--     the client; the client keeps old private halves for in-flight messages).
--   * one_time_prekeys: a pool per device. claim_prekey_bundle() hands out and
--     DELETES one per device atomically (FOR UPDATE SKIP LOCKED: concurrent
--     claimers never get the same key and never block each other). When the
--     pool is empty the bundle has no one-time prekey and X3DH runs without
--     it (still secure, slightly weaker against replay of the first message).
--   * Bundles are served only for devices of users the caller shares (or has
--     shared) a conversation with - the same rule as get_device_keys(); that
--     includes story contacts, who by definition share a direct chat.
--   * Draining protection: a caller can consume at most 1000 one-time
--     prekeys per hour; beyond that bundles come without one.
--   * Nothing here is readable or writable directly; all access is via the
--     SECURITY DEFINER functions below.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- DEVICE SIGNING KEYS
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.devices
  add column signing_public_key text
    check (signing_public_key is null or char_length(signing_public_key) between 40 and 64),
  add column identity_signature text
    check (identity_signature is null or char_length(identity_signature) between 80 and 100),
  add constraint devices_signing_key_complete
    check ((signing_public_key is null) = (identity_signature is null));

-- ─────────────────────────────────────────────────────────────────────────────
-- PREKEYS
-- ─────────────────────────────────────────────────────────────────────────────

create table public.signed_prekeys (
  device_id   uuid primary key references public.devices (id) on delete cascade,
  key_id      integer not null check (key_id between 0 and 2147483647),
  public_key  text not null check (char_length(public_key) between 40 and 64),
  signature   text not null check (char_length(signature) between 80 and 100),
  created_at  timestamptz not null default now()
);

create table public.one_time_prekeys (
  device_id   uuid not null references public.devices (id) on delete cascade,
  key_id      integer not null check (key_id between 0 and 2147483647),
  public_key  text not null check (char_length(public_key) between 40 and 64),
  created_at  timestamptz not null default now(),
  primary key (device_id, key_id)
);

create index one_time_prekeys_fifo_idx on public.one_time_prekeys (device_id, created_at, key_id);

-- Per-caller hourly counter for one-time prekey consumption.
create table public.prekey_claim_usage (
  user_id       uuid not null references auth.users (id) on delete cascade,
  window_start  timestamptz not null,
  claimed       integer not null default 0,
  primary key (user_id, window_start)
);

alter table public.signed_prekeys enable row level security;
alter table public.one_time_prekeys enable row level security;
alter table public.prekey_claim_usage enable row level security;
-- No policies: RPC-only.
revoke all on public.signed_prekeys, public.one_time_prekeys, public.prekey_claim_usage from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- True if p_device_id is an active device of the caller.
create or replace function public.is_own_active_device(p_device_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.devices
    where id = p_device_id and user_id = auth.uid() and revoked_at is null
  );
$$;

-- Publishes the caller's device signing key + identity binding signature.
-- Set once: a different key for the same device is refused (a new signing key
-- means a new device). Re-publishing the same key is a no-op.
create or replace function public.publish_device_signing_key(
  p_device_id          uuid,
  p_signing_key        text,
  p_identity_signature text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_current text;
begin
  if not public.is_own_active_device(p_device_id) then
    raise exception 'not your active device' using errcode = '42501';
  end if;
  if p_signing_key is null or p_signing_key !~ '^[A-Za-z0-9_-]{43}$'
     or p_identity_signature is null or p_identity_signature !~ '^[A-Za-z0-9_-]{86}$' then
    raise exception 'malformed signing key or signature' using errcode = '22023';
  end if;

  select signing_public_key into v_current from public.devices where id = p_device_id for update;
  if v_current is not null and v_current <> p_signing_key then
    raise exception 'this device already has a different signing key' using errcode = '42501';
  end if;
  update public.devices
     set signing_public_key = p_signing_key,
         identity_signature = p_identity_signature
   where id = p_device_id;
end;
$$;

-- Uploads (replaces) the signed prekey and/or adds one-time prekeys for one of
-- the caller's devices. p_signed_prekey = {"id": int, "public_key": text,
-- "signature": text} or null; p_one_time_prekeys = [{"id": int, "public_key": text}].
-- At most 100 one-time prekeys per call and 200 stored per device.
-- Returns the device's number of stored one-time prekeys.
create or replace function public.upload_prekeys(
  p_device_id         uuid,
  p_signed_prekey     jsonb,
  p_one_time_prekeys  jsonb
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item  jsonb;
  v_count integer;
begin
  if not public.is_own_active_device(p_device_id) then
    raise exception 'not your active device' using errcode = '42501';
  end if;
  if not exists (select 1 from public.devices where id = p_device_id and signing_public_key is not null) then
    raise exception 'publish the device signing key first' using errcode = '22023';
  end if;

  if p_signed_prekey is not null and jsonb_typeof(p_signed_prekey) <> 'null' then
    if jsonb_typeof(p_signed_prekey) <> 'object'
       or jsonb_typeof(p_signed_prekey -> 'id') <> 'number'
       or coalesce(p_signed_prekey ->> 'public_key', '') !~ '^[A-Za-z0-9_-]{43}$'
       or coalesce(p_signed_prekey ->> 'signature', '') !~ '^[A-Za-z0-9_-]{86}$' then
      raise exception 'malformed signed prekey' using errcode = '22023';
    end if;
    insert into public.signed_prekeys (device_id, key_id, public_key, signature)
    values (p_device_id, (p_signed_prekey ->> 'id')::integer, p_signed_prekey ->> 'public_key', p_signed_prekey ->> 'signature')
    on conflict (device_id) do update
      set key_id = excluded.key_id,
          public_key = excluded.public_key,
          signature = excluded.signature,
          created_at = now();
  end if;

  if p_one_time_prekeys is not null and jsonb_typeof(p_one_time_prekeys) <> 'null' then
    if jsonb_typeof(p_one_time_prekeys) <> 'array' or jsonb_array_length(p_one_time_prekeys) > 100 then
      raise exception 'one-time prekeys must be an array of at most 100' using errcode = '22023';
    end if;
    for v_item in select * from jsonb_array_elements(p_one_time_prekeys) loop
      if jsonb_typeof(v_item) <> 'object'
         or jsonb_typeof(v_item -> 'id') <> 'number'
         or coalesce(v_item ->> 'public_key', '') !~ '^[A-Za-z0-9_-]{43}$' then
        raise exception 'malformed one-time prekey' using errcode = '22023';
      end if;
      insert into public.one_time_prekeys (device_id, key_id, public_key)
      values (p_device_id, (v_item ->> 'id')::integer, v_item ->> 'public_key')
      on conflict (device_id, key_id) do nothing;
    end loop;
  end if;

  select count(*) into v_count from public.one_time_prekeys where device_id = p_device_id;
  if v_count > 200 then
    raise exception 'too many one-time prekeys stored for this device' using errcode = '54000';
  end if;
  return v_count;
end;
$$;

-- How many one-time prekeys the server still holds for one of the caller's
-- devices, and which signed prekey it serves.
create or replace function public.get_prekey_status(p_device_id uuid)
returns table (one_time_count integer, signed_prekey_id integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_own_active_device(p_device_id) then
    raise exception 'not your active device' using errcode = '42501';
  end if;
  return query
    select (select count(*)::integer from public.one_time_prekeys where device_id = p_device_id),
           (select key_id from public.signed_prekeys where device_id = p_device_id);
end;
$$;

-- Signing keys of specific devices (for pinning / safety numbers). Same
-- authorisation as get_device_keys().
create or replace function public.get_device_signing_keys(p_device_ids uuid[])
returns table (device_id uuid, user_id uuid, identity_public_key text, signing_public_key text, identity_signature text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.user_id, d.identity_public_key, d.signing_public_key, d.identity_signature
  from public.devices d
  where d.id = any (p_device_ids)
    and cardinality(p_device_ids) <= 1000
    and d.signing_public_key is not null
    and public.has_shared_conversation(d.user_id);
$$;

-- X3DH prekey bundles for the given devices. Consumes (deletes) one one-time
-- prekey per device; concurrent callers skip each other's locked rows.
-- Devices that are revoked, unknown, not shared with the caller, or have no
-- signing key / signed prekey yet are silently left out.
create or replace function public.claim_prekey_bundle(p_device_ids uuid[])
returns table (
  device_id               uuid,
  user_id                 uuid,
  identity_public_key     text,
  signing_public_key      text,
  identity_signature      text,
  signed_prekey_id        integer,
  signed_prekey           text,
  signed_prekey_signature text,
  one_time_prekey_id      integer,
  one_time_prekey         text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_window timestamptz := date_trunc('hour', now());
  v_used   integer;
  v_limit  constant integer := 1000;
  v_dev    record;
  v_opk_id integer;
  v_opk    text;
begin
  if v_me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_device_ids is null or cardinality(p_device_ids) = 0 then
    return;
  end if;
  if cardinality(p_device_ids) > 500 then
    raise exception 'too many devices in one claim' using errcode = '22023';
  end if;

  insert into public.prekey_claim_usage (user_id, window_start) values (v_me, v_window)
  on conflict do nothing;
  select claimed into v_used from public.prekey_claim_usage
   where prekey_claim_usage.user_id = v_me and window_start = v_window
   for update;
  delete from public.prekey_claim_usage
   where prekey_claim_usage.user_id = v_me and window_start < v_window;

  for v_dev in
    select d.id, d.user_id, d.identity_public_key, d.signing_public_key, d.identity_signature,
           s.key_id as spk_id, s.public_key as spk, s.signature as spk_sig
    from public.devices d
    join public.signed_prekeys s on s.device_id = d.id
    where d.id = any (p_device_ids)
      and d.revoked_at is null
      and d.signing_public_key is not null
      and public.has_shared_conversation(d.user_id)
    order by d.id
  loop
    v_opk_id := null;
    v_opk := null;
    if v_used < v_limit then
      delete from public.one_time_prekeys o
       where (o.device_id, o.key_id) = (
         select c.device_id, c.key_id
           from public.one_time_prekeys c
          where c.device_id = v_dev.id
          order by c.created_at, c.key_id
          limit 1
          for update skip locked
       )
      returning o.key_id, o.public_key into v_opk_id, v_opk;
      if v_opk_id is not null then
        v_used := v_used + 1;
      end if;
    end if;

    device_id := v_dev.id;
    user_id := v_dev.user_id;
    identity_public_key := v_dev.identity_public_key;
    signing_public_key := v_dev.signing_public_key;
    identity_signature := v_dev.identity_signature;
    signed_prekey_id := v_dev.spk_id;
    signed_prekey := v_dev.spk;
    signed_prekey_signature := v_dev.spk_sig;
    one_time_prekey_id := v_opk_id;
    one_time_prekey := v_opk;
    return next;
  end loop;

  update public.prekey_claim_usage set claimed = v_used
   where prekey_claim_usage.user_id = v_me and window_start = v_window;
end;
$$;

-- A revoked device's prekeys are useless; drop them so they can't be claimed.
create or replace function public.devices_drop_prekeys_on_revoke()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    delete from public.one_time_prekeys where device_id = new.id;
    delete from public.signed_prekeys where device_id = new.id;
  end if;
  return new;
end;
$$;

create trigger devices_drop_prekeys_on_revoke
  after update of revoked_at on public.devices
  for each row execute function public.devices_drop_prekeys_on_revoke();

-- ─────────────────────────────────────────────────────────────────────────────
-- Function privileges
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function public.is_own_active_device(uuid) from public, anon, authenticated;
revoke execute on function public.publish_device_signing_key(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.upload_prekeys(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.get_prekey_status(uuid) from public, anon, authenticated;
revoke execute on function public.get_device_signing_keys(uuid[]) from public, anon, authenticated;
revoke execute on function public.claim_prekey_bundle(uuid[]) from public, anon, authenticated;
revoke execute on function public.devices_drop_prekeys_on_revoke() from public, anon, authenticated;

grant execute on function public.publish_device_signing_key(uuid, text, text) to authenticated;
grant execute on function public.upload_prekeys(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.get_prekey_status(uuid) to authenticated;
grant execute on function public.get_device_signing_keys(uuid[]) to authenticated;
grant execute on function public.claim_prekey_bundle(uuid[]) to authenticated;
