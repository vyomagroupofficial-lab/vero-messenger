-- ============================================================================
-- Vero Messenger - 009: contact discovery, device linking, chat transfer
-- ============================================================================
-- Applies on top of 001 only.
--
-- Contact discovery (opt-in, k-anonymous):
--   * A user may opt in to be found by their VERIFIED email and/or VERIFIED
--     phone number (auth.users.email_confirmed_at / phone_confirmed_at).
--   * The server stores only SHA-256 hashes of those identifiers
--     (discovery_identifiers), maintained by SECURITY DEFINER functions from
--     auth.users - never written by clients.
--   * Clients hash their address book locally and send only short hash
--     PREFIXES to discovery_lookup(); it returns every listed (hash, user)
--     sharing those prefixes and the client matches full hashes locally, so the
--     server never learns which exact contacts a user has.
--   * Lookups are rate-limited per user per day.
--   Honest limitation: phone numbers have little entropy; anyone who collects
--   hashes of discoverable users (slowly, within the rate limit) can brute
--   force them. Discovery is therefore opt-in and off by default.
--
-- Device linking / chat transfer (device_link_requests):
--   * purpose 'link': a signed-OUT device (web/desktop) creates a request via
--     the device-link Edge Function, storing sha256(claimKey) where claimKey
--     is derived from a random secret shown only in its QR code. A signed-in
--     device that scans the QR approves it (Edge Function, verified JWT); the
--     new device then presents claimKey ONCE to receive a magic-link token
--     hash for the same account. Single-use, 2-minute expiry.
--   * purpose 'transfer': a signed-in new phone shows a QR; the old phone
--     approves and uploads its local history encrypted to the QR's ephemeral
--     X25519 key (+ the QR secret) into device_transfer_chunks.
--   * The server only ever handles ciphertext; private keys are never moved.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- DISCOVERY
-- ─────────────────────────────────────────────────────────────────────────────

create table public.discovery_settings (
  user_id               uuid primary key references public.profiles (id) on delete cascade,
  discoverable_by_email boolean not null default false,
  discoverable_by_phone boolean not null default false,
  updated_at            timestamptz not null default now()
);

create trigger discovery_settings_updated_at
  before update on public.discovery_settings
  for each row execute function public.set_updated_at();

alter table public.discovery_settings enable row level security;

create policy "users read their own discovery settings"
  on public.discovery_settings for select to authenticated
  using (user_id = (select auth.uid()));

-- Writes go through set_discoverability().
revoke insert, update, delete on public.discovery_settings from anon, authenticated;

-- Hashes of identifiers of users who opted in. Nobody but SECURITY DEFINER
-- functions can read or write this table.
create table public.discovery_identifiers (
  user_id         uuid not null references public.profiles (id) on delete cascade,
  kind            text not null check (kind in ('email', 'phone')),
  identifier_hash text collate "C" not null check (identifier_hash ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz not null default now(),
  primary key (user_id, kind)
);

-- C collation lets "identifier_hash like 'abcd%'" use this index.
create index discovery_identifiers_hash_idx on public.discovery_identifiers (identifier_hash);

alter table public.discovery_identifiers enable row level security;
revoke all on public.discovery_identifiers from anon, authenticated;

create table public.discovery_lookup_usage (
  user_id       uuid not null references auth.users (id) on delete cascade,
  day           date not null,
  request_count integer not null default 0,
  prefix_count  integer not null default 0,
  primary key (user_id, day)
);

alter table public.discovery_lookup_usage enable row level security;

create policy "users read their own lookup usage"
  on public.discovery_lookup_usage for select to authenticated
  using (user_id = (select auth.uid()));

revoke insert, update, delete on public.discovery_lookup_usage from anon, authenticated;

-- Canonical hash shared with the client (src/features/discovery/hashing.ts):
--   sha256_hex("vero-discovery-v1|" || kind || "|" || normalised identifier)
-- email: lower-cased, trimmed.  phone: E.164 ("+" followed by digits).
create or replace function public.discovery_hash(p_kind text, p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to('vero-discovery-v1|' || p_kind || '|' || p_value, 'UTF8')), 'hex');
$$;

create or replace function public.discovery_normalize_phone(p_phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- auth.users.phone is stored without the leading '+'.
  select case
    when p_phone is null then null
    when regexp_replace(p_phone, '[^0-9]', '', 'g') ~ '^[1-9][0-9]{6,14}$'
      then '+' || regexp_replace(p_phone, '[^0-9]', '', 'g')
    else null
  end;
$$;

-- Rebuilds a user's listed hashes from auth.users and their settings.
-- Only verified identifiers are ever listed.
create or replace function public.refresh_discovery_identifiers(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.discovery_settings;
  v_email    text;
  v_email_ok boolean;
  v_phone    text;
  v_phone_ok boolean;
begin
  delete from public.discovery_identifiers where user_id = p_user_id;

  select * into v_settings from public.discovery_settings where user_id = p_user_id;
  if not found then
    return;
  end if;

  select lower(btrim(u.email)), u.email_confirmed_at is not null,
         public.discovery_normalize_phone(u.phone), u.phone_confirmed_at is not null
    into v_email, v_email_ok, v_phone, v_phone_ok
  from auth.users u
  where u.id = p_user_id;

  if v_settings.discoverable_by_email and v_email_ok and coalesce(v_email, '') like '%@%' then
    insert into public.discovery_identifiers (user_id, kind, identifier_hash)
    values (p_user_id, 'email', public.discovery_hash('email', v_email));
  end if;

  if v_settings.discoverable_by_phone and v_phone_ok and v_phone is not null then
    insert into public.discovery_identifiers (user_id, kind, identifier_hash)
    values (p_user_id, 'phone', public.discovery_hash('phone', v_phone));
  end if;
end;
$$;

-- Keeps the hashes in sync when the user changes or (re)verifies email/phone.
create or replace function public.handle_auth_user_discovery_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email
     or new.email_confirmed_at is distinct from old.email_confirmed_at
     or new.phone is distinct from old.phone
     or new.phone_confirmed_at is distinct from old.phone_confirmed_at then
    if exists (select 1 from public.discovery_settings where user_id = new.id) then
      perform public.refresh_discovery_identifiers(new.id);
    end if;
  end if;
  return null;
end;
$$;

create trigger on_auth_user_discovery_change
  after update on auth.users
  for each row execute function public.handle_auth_user_discovery_change();

-- Current state for the settings screen.
create or replace function public.get_discoverability()
returns table (
  discoverable_by_email boolean,
  discoverable_by_phone boolean,
  email_listed          boolean,
  phone_listed          boolean,
  email_verified        boolean,
  phone_verified        boolean,
  phone_hint            text
)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(s.discoverable_by_email, false),
         coalesce(s.discoverable_by_phone, false),
         exists (select 1 from public.discovery_identifiers i where i.user_id = u.id and i.kind = 'email'),
         exists (select 1 from public.discovery_identifiers i where i.user_id = u.id and i.kind = 'phone'),
         u.email_confirmed_at is not null,
         u.phone_confirmed_at is not null and coalesce(u.phone, '') <> '',
         case when coalesce(u.phone, '') <> '' then '•••' || right(u.phone, 4) end
  from auth.users u
  left join public.discovery_settings s on s.user_id = u.id
  where u.id = auth.uid();
$$;

create or replace function public.set_discoverability(p_by_email boolean, p_by_phone boolean)
returns table (
  discoverable_by_email boolean,
  discoverable_by_phone boolean,
  email_listed          boolean,
  phone_listed          boolean,
  email_verified        boolean,
  phone_verified        boolean,
  phone_hint            text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  insert into public.discovery_settings (user_id, discoverable_by_email, discoverable_by_phone)
  values (v_me, coalesce(p_by_email, false), coalesce(p_by_phone, false))
  on conflict on constraint discovery_settings_pkey do update
    set discoverable_by_email = excluded.discoverable_by_email,
        discoverable_by_phone = excluded.discoverable_by_phone;

  perform public.refresh_discovery_identifiers(v_me);

  return query select * from public.get_discoverability();
end;
$$;

-- k-anonymous lookup. p_prefixes: lower-case hex prefixes (3-5 chars) of the
-- caller's locally computed identifier hashes. Returns ALL listed identities
-- in those buckets; the caller matches full hashes on the device.
create or replace function public.discovery_lookup(p_prefixes text[])
returns table (identifier_hash text, user_id uuid, username text, display_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_per_call    constant integer := 2000;
  c_max_prefix_day  constant integer := 5000;
  c_max_request_day constant integer := 30;
  v_me       uuid := auth.uid();
  v_prefixes text[];
  v_usage    public.discovery_lookup_usage;
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct p), '{}') into v_prefixes
  from unnest(coalesce(p_prefixes, '{}')) as p;

  if exists (select 1 from unnest(v_prefixes) p where p is null or p !~ '^[0-9a-f]{3,5}$') then
    raise exception 'prefixes must be 3-5 lower-case hex characters' using errcode = '22023';
  end if;
  if cardinality(v_prefixes) = 0 then
    return;
  end if;
  if cardinality(v_prefixes) > c_max_per_call then
    raise exception 'too many prefixes in one request (max %)', c_max_per_call using errcode = '22023';
  end if;

  insert into public.discovery_lookup_usage as u (user_id, day, request_count, prefix_count)
  values (v_me, (now() at time zone 'utc')::date, 1, cardinality(v_prefixes))
  on conflict on constraint discovery_lookup_usage_pkey do update
    set request_count = u.request_count + 1,
        prefix_count  = u.prefix_count + excluded.prefix_count
  returning * into v_usage;

  if v_usage.request_count > c_max_request_day or v_usage.prefix_count > c_max_prefix_day then
    -- PostgREST maps SQLSTATE PTxxx to HTTP status xxx.
    raise exception 'contact discovery rate limit reached, try again tomorrow' using errcode = 'PT429';
  end if;

  return query
  select i.identifier_hash::text, p.id, p.username, p.display_name
  from unnest(v_prefixes) as pre
  join public.discovery_identifiers i on i.identifier_hash like pre || '%'
  join public.discovery_settings s on s.user_id = i.user_id
  join public.profiles p on p.id = i.user_id
  where i.user_id <> v_me
    and ((i.kind = 'email' and s.discoverable_by_email) or (i.kind = 'phone' and s.discoverable_by_phone))
    and not public.is_blocked_between(v_me, i.user_id);
end;
$$;

-- Exact username -> profile (QR codes / vero://u/<username> links).
create or replace function public.resolve_username(p_username text)
returns table (id uuid, username text, display_name text, avatar_reference text, about text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.username, p.display_name, p.avatar_reference, p.about
  from public.profiles p
  where p.username = lower(btrim(p_username))
    and auth.uid() is not null
    and not public.is_blocked_between(auth.uid(), p.id);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- DEVICE LINKING & CHAT TRANSFER
-- ─────────────────────────────────────────────────────────────────────────────

create table public.device_link_requests (
  id                    uuid primary key default gen_random_uuid(),
  purpose               text not null check (purpose in ('link', 'transfer')),
  -- link: sha256 hex of the claim key derived from the QR secret (never the secret itself)
  secret_hash           text check (secret_hash is null or secret_hash ~ '^[0-9a-f]{64}$'),
  -- link: sha256 of the requesting client's IP, only for rate limiting
  client_key_hash       text check (client_key_hash is null or client_key_hash ~ '^[0-9a-f]{64}$'),
  -- X25519 public key of the RECEIVING device (also in its QR code)
  ephemeral_public_key  text not null check (char_length(ephemeral_public_key) between 40 and 64),
  device_label          text check (device_label is null or char_length(device_label) between 1 and 64),
  -- Account the request belongs to: set on approval (link) or creation (transfer)
  user_id               uuid references auth.users (id) on delete cascade,
  status                text not null default 'pending'
                        check (status in ('pending', 'approved', 'claimed', 'completed', 'cancelled')),
  approved_by_device_id uuid references public.devices (id) on delete set null,
  -- X25519 public key of the SENDING device's ephemeral key pair
  sender_public_key     text check (sender_public_key is null or char_length(sender_public_key) between 40 and 64),
  total_chunks          integer check (total_chunks is null or total_chunks between 0 and 1024),
  created_at            timestamptz not null default now(),
  -- deadline for approval (and, once approved, for claiming)
  expires_at            timestamptz not null default now() + interval '2 minutes',
  -- deadline for the encrypted history to be uploaded and downloaded
  data_expires_at       timestamptz not null default now() + interval '1 hour',
  approved_at           timestamptz,
  claimed_at            timestamptz,
  uploaded_at           timestamptz,
  completed_at          timestamptz,
  check (purpose = 'transfer' or secret_hash is not null),
  check (purpose = 'link' or user_id is not null),
  check (status in ('pending', 'cancelled') or user_id is not null)
);

create index device_link_requests_user_idx on public.device_link_requests (user_id, created_at desc);
create index device_link_requests_client_idx on public.device_link_requests (client_key_hash, created_at desc)
  where client_key_hash is not null;
create index device_link_requests_expiry_idx on public.device_link_requests (data_expires_at);

alter table public.device_link_requests enable row level security;

-- The account's own devices can follow their requests. Hashes are not exposed.
create policy "users see their own link and transfer requests"
  on public.device_link_requests for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.device_link_requests from anon, authenticated;
grant select (id, purpose, ephemeral_public_key, device_label, user_id, status, approved_by_device_id,
              sender_public_key, total_chunks, created_at, expires_at, data_expires_at, approved_at,
              claimed_at, uploaded_at, completed_at)
  on public.device_link_requests to authenticated;

-- Encrypted history (opaque to the server).
create table public.device_transfer_chunks (
  request_id uuid not null references public.device_link_requests (id) on delete cascade,
  idx        integer not null check (idx between 0 and 1023),
  ciphertext text not null check (char_length(ciphertext) between 1 and 400000),
  created_at timestamptz not null default now(),
  primary key (request_id, idx)
);

alter table public.device_transfer_chunks enable row level security;

create or replace function public.can_access_transfer(p_request_id uuid, p_write boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.device_link_requests r
    where r.id = p_request_id
      and r.user_id = auth.uid()
      and r.data_expires_at > now()
      and (
        (not p_write and r.status in ('approved', 'claimed'))
        or (p_write and r.status in ('approved', 'claimed') and r.uploaded_at is null)
      )
  );
$$;

create policy "account devices read transfer chunks"
  on public.device_transfer_chunks for select to authenticated
  using (public.can_access_transfer(request_id, false));

create policy "account devices upload transfer chunks"
  on public.device_transfer_chunks for insert to authenticated
  with check (public.can_access_transfer(request_id, true));

revoke all on public.device_transfer_chunks from anon, authenticated;
-- No update/delete: a retried upload of an existing chunk is simply a no-op
-- conflict, and complete_transfer()/cancel_transfer() delete the ciphertext.
grant select, insert on public.device_transfer_chunks to authenticated;

-- ── link: service-role functions used by the device-link Edge Function ──────

create or replace function public.device_link_create(
  p_secret_hash text,
  p_ephemeral_public_key text,
  p_device_label text default null,
  p_client_key text default null
)
returns table (id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client text := case when coalesce(p_client_key, '') <> ''
                        then encode(sha256(convert_to(p_client_key, 'UTF8')), 'hex') end;
begin
  if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid secret hash' using errcode = '22023';
  end if;
  if p_ephemeral_public_key is null or p_ephemeral_public_key !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'invalid public key' using errcode = '22023';
  end if;

  if v_client is not null and (
    select count(*) from public.device_link_requests r
    where r.client_key_hash = v_client and r.created_at > now() - interval '10 minutes'
  ) >= 20 then
    raise exception 'too many link requests, try again later' using errcode = 'PT429';
  end if;
  if (select count(*) from public.device_link_requests r
      where r.purpose = 'link' and r.status = 'pending' and r.expires_at > now()) >= 10000 then
    raise exception 'too many pending link requests' using errcode = 'PT429';
  end if;

  return query
  insert into public.device_link_requests (purpose, secret_hash, client_key_hash, ephemeral_public_key, device_label)
  values ('link', p_secret_hash, v_client, p_ephemeral_public_key,
          nullif(left(btrim(coalesce(p_device_label, '')), 64), ''))
  returning device_link_requests.id, device_link_requests.expires_at;
end;
$$;

-- What the approving phone shows before the user confirms.
create or replace function public.device_link_inspect(p_id uuid)
returns table (device_label text, created_at timestamptz, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select r.device_label, r.created_at, r.expires_at
  from public.device_link_requests r
  where r.id = p_id and r.purpose = 'link' and r.status = 'pending' and r.expires_at > now();
$$;

create or replace function public.device_link_approve(
  p_id uuid,
  p_user_id uuid,
  p_device_id uuid,
  p_ephemeral_public_key text,
  p_sender_public_key text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires timestamptz;
begin
  if p_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.devices d
    where d.id = p_device_id and d.user_id = p_user_id and d.revoked_at is null
  ) then
    raise exception 'approving device is not an active device of this account' using errcode = '42501';
  end if;
  if p_sender_public_key is null or p_sender_public_key !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'invalid sender key' using errcode = '22023';
  end if;

  update public.device_link_requests r
     set status = 'approved',
         user_id = p_user_id,
         approved_by_device_id = p_device_id,
         sender_public_key = p_sender_public_key,
         approved_at = now(),
         -- the new device has two minutes from approval to claim the sign-in
         expires_at = now() + interval '2 minutes',
         data_expires_at = now() + interval '1 hour'
   where r.id = p_id
     and r.purpose = 'link'
     and r.status = 'pending'
     and r.expires_at > now()
     and r.ephemeral_public_key = p_ephemeral_public_key
  returning r.expires_at into v_expires;

  if v_expires is null then
    raise exception 'link request not found, expired or already used' using errcode = 'P0002';
  end if;
  return v_expires;
end;
$$;

-- Called with the claim key presented by the new device. Single use: only the
-- first successful call returns the user id (the Edge Function then mints a
-- one-time sign-in token for that user and returns it to the caller).
--   status: 'pending' | 'approved' (now claimed) | 'expired' | 'used' | 'invalid'
create or replace function public.device_link_claim(p_id uuid, p_claim_key text)
returns table (status text, user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.device_link_requests;
begin
  select * into v_req from public.device_link_requests r
  where r.id = p_id and r.purpose = 'link'
  for update;

  if not found
     or coalesce(p_claim_key, '') = ''
     or v_req.secret_hash is distinct from encode(sha256(convert_to(p_claim_key, 'UTF8')), 'hex') then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  if v_req.status in ('claimed', 'completed') then
    return query select 'used'::text, null::uuid;
    return;
  end if;
  if v_req.status = 'cancelled' or v_req.expires_at <= now() then
    return query select 'expired'::text, null::uuid;
    return;
  end if;
  if v_req.status = 'pending' then
    return query select 'pending'::text, null::uuid;
    return;
  end if;

  update public.device_link_requests r
     set status = 'claimed', claimed_at = now()
   where r.id = p_id and r.status = 'approved';

  return query select 'approved'::text, v_req.user_id;
end;
$$;

-- The new device gives up (closes the QR screen).
create or replace function public.device_link_cancel(p_id uuid, p_claim_key text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.device_link_requests r
     set status = 'cancelled'
   where r.id = p_id
     and r.purpose = 'link'
     and r.status in ('pending', 'approved')
     and r.secret_hash = encode(sha256(convert_to(coalesce(p_claim_key, ''), 'UTF8')), 'hex');
$$;

-- ── transfer: called by signed-in devices of the same account ───────────────

create or replace function public.create_transfer_request(p_ephemeral_public_key text)
returns table (id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_ephemeral_public_key is null or p_ephemeral_public_key !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'invalid public key' using errcode = '22023';
  end if;
  if (select count(*) from public.device_link_requests r
      where r.user_id = v_me and r.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'too many transfer requests, try again later' using errcode = 'PT429';
  end if;

  return query
  insert into public.device_link_requests (purpose, ephemeral_public_key, user_id, expires_at)
  values ('transfer', p_ephemeral_public_key, v_me, now() + interval '10 minutes')
  returning device_link_requests.id, device_link_requests.expires_at;
end;
$$;

create or replace function public.approve_transfer_request(
  p_id uuid,
  p_ephemeral_public_key text,
  p_device_id uuid,
  p_sender_public_key text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.devices d where d.id = p_device_id and d.user_id = v_me and d.revoked_at is null
  ) then
    raise exception 'approving device is not an active device of this account' using errcode = '42501';
  end if;
  if p_sender_public_key is null or p_sender_public_key !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'invalid sender key' using errcode = '22023';
  end if;

  update public.device_link_requests r
     set status = 'approved',
         approved_by_device_id = p_device_id,
         sender_public_key = p_sender_public_key,
         approved_at = now(),
         data_expires_at = now() + interval '1 hour'
   where r.id = p_id
     and r.purpose = 'transfer'
     and r.user_id = v_me
     and r.status = 'pending'
     and r.expires_at > now()
     and r.ephemeral_public_key = p_ephemeral_public_key;

  if not found then
    raise exception 'transfer request not found, expired or already used' using errcode = 'P0002';
  end if;
end;
$$;

-- The sender declares the upload complete once every chunk 0..n-1 is present.
create or replace function public.finish_transfer_upload(p_id uuid, p_total_chunks integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.can_access_transfer(p_id, true) then
    raise exception 'transfer not found or not writable' using errcode = '42501';
  end if;
  if p_total_chunks is null or p_total_chunks < 1 or p_total_chunks > 1024 then
    raise exception 'invalid chunk count' using errcode = '22023';
  end if;

  select count(*) into v_count from public.device_transfer_chunks
  where request_id = p_id and idx < p_total_chunks;
  if v_count <> p_total_chunks
     or exists (select 1 from public.device_transfer_chunks where request_id = p_id and idx >= p_total_chunks) then
    raise exception 'missing or extra chunks' using errcode = '22023';
  end if;

  update public.device_link_requests
     set total_chunks = p_total_chunks, uploaded_at = now()
   where id = p_id;
end;
$$;

-- The receiver confirms the import; the ciphertext is deleted straight away.
create or replace function public.complete_transfer(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.device_link_requests r
     set status = 'completed', completed_at = now()
   where r.id = p_id and r.user_id = auth.uid() and r.status in ('approved', 'claimed');
  delete from public.device_transfer_chunks c
   where c.request_id = p_id
     and exists (select 1 from public.device_link_requests r where r.id = p_id and r.user_id = auth.uid());
end;
$$;

create or replace function public.cancel_transfer(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.device_link_requests r
     set status = 'cancelled'
   where r.id = p_id and r.user_id = auth.uid() and r.status in ('pending', 'approved', 'claimed');
  delete from public.device_transfer_chunks c
   where c.request_id = p_id
     and exists (select 1 from public.device_link_requests r where r.id = p_id and r.user_id = auth.uid());
end;
$$;

-- Housekeeping: expired requests/ciphertext and old rate-limit counters.
create or replace function public.cleanup_discovery_linking()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.device_link_requests
  where data_expires_at < now()
     or (status = 'pending' and expires_at < now() - interval '10 minutes')
     or (status in ('completed', 'cancelled') and created_at < now() - interval '1 day');
  get diagnostics v_count = row_count;

  delete from public.discovery_lookup_usage where day < (now() at time zone 'utc')::date - 2;
  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Function privileges
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function public.discovery_hash(text, text) from public, anon, authenticated;
revoke execute on function public.discovery_normalize_phone(text) from public, anon, authenticated;
revoke execute on function public.refresh_discovery_identifiers(uuid) from public, anon, authenticated;
revoke execute on function public.handle_auth_user_discovery_change() from public, anon, authenticated;
revoke execute on function public.get_discoverability() from public, anon;
revoke execute on function public.set_discoverability(boolean, boolean) from public, anon;
revoke execute on function public.discovery_lookup(text[]) from public, anon;
revoke execute on function public.resolve_username(text) from public, anon;
revoke execute on function public.can_access_transfer(uuid, boolean) from public, anon;
revoke execute on function public.device_link_create(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.device_link_inspect(uuid) from public, anon, authenticated;
revoke execute on function public.device_link_approve(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.device_link_claim(uuid, text) from public, anon, authenticated;
revoke execute on function public.device_link_cancel(uuid, text) from public, anon, authenticated;
revoke execute on function public.create_transfer_request(text) from public, anon;
revoke execute on function public.approve_transfer_request(uuid, text, uuid, text) from public, anon;
revoke execute on function public.finish_transfer_upload(uuid, integer) from public, anon;
revoke execute on function public.complete_transfer(uuid) from public, anon;
revoke execute on function public.cancel_transfer(uuid) from public, anon;
revoke execute on function public.cleanup_discovery_linking() from public, anon, authenticated;

grant execute on function public.get_discoverability() to authenticated;
grant execute on function public.set_discoverability(boolean, boolean) to authenticated;
grant execute on function public.discovery_lookup(text[]) to authenticated;
grant execute on function public.resolve_username(text) to authenticated;
grant execute on function public.can_access_transfer(uuid, boolean) to authenticated;
grant execute on function public.create_transfer_request(text) to authenticated;
grant execute on function public.approve_transfer_request(uuid, text, uuid, text) to authenticated;
grant execute on function public.finish_transfer_upload(uuid, integer) to authenticated;
grant execute on function public.complete_transfer(uuid) to authenticated;
grant execute on function public.cancel_transfer(uuid) to authenticated;

grant execute on function public.device_link_create(text, text, text, text) to service_role;
grant execute on function public.device_link_inspect(uuid) to service_role;
grant execute on function public.device_link_approve(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.device_link_claim(uuid, text) to service_role;
grant execute on function public.device_link_cancel(uuid, text) to service_role;
grant execute on function public.cleanup_discovery_linking() to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEDULED CLEANUP (only if pg_cron is enabled on the project)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vero-cleanup-linking', '*/10 * * * *', 'select public.cleanup_discovery_linking()');
  end if;
end;
$$;
