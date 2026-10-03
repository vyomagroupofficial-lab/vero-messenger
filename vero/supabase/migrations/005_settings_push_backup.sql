-- ============================================================================
-- Vero Messenger - 005: privacy settings, push notifications, mutes,
--                       last seen / presence, encrypted backups
-- ============================================================================
-- Applies on top of 001 only (does not depend on 002-004).
--
-- Push pipeline (no Edge Function secrets needed):
--   messages INSERT --trigger--> net.http_post(<project_url>/functions/v1/send-push,
--                                              header x-webhook-secret: <vault secret>)
--   send-push verifies the header with verify_push_webhook_secret() (service
--   role only) and asks get_message_push_targets() whom to wake.
--   Both values live in Supabase Vault:
--     push_webhook_secret  created here with a random value
--     project_url          set by the operator:  select public.vero_set_project_url('https://<ref>.supabase.co');
--   Until project_url is set the trigger is a silent no-op.
--
-- Privacy:
--   * user_settings is readable/writable by its owner only.
--   * profiles.last_seen_at and conversation_members.muted_until are hidden
--     from clients by column privileges; last seen is read through
--     get_last_seen(), which applies the owner's visibility setting.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Platform extensions (present on Supabase; stubbed by the local test harness)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net')
     and not exists (select 1 from pg_extension where extname = 'pg_net') then
    create extension pg_net with schema extensions;
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Vault helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- Reads a Vault secret. Only callable by the database owner / service role.
create or replace function public.vero_read_secret(p_name text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_value text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
    into v_value using p_name;
  return nullif(v_value, '');
end;
$$;

-- Creates or replaces a named Vault secret.
create or replace function public.vero_upsert_secret(p_name text, p_value text, p_description text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if to_regclass('vault.secrets') is null then
    raise exception 'Supabase Vault is not available' using errcode = '0A000';
  end if;
  execute 'select id from vault.secrets where name = $1 limit 1' into v_id using p_name;
  if v_id is null then
    execute 'select vault.create_secret($1, $2, $3)' using p_value, p_name, p_description;
  else
    execute 'select vault.update_secret($1, $2)' using v_id, p_value;
  end if;
end;
$$;

-- Operator entry point: the base URL used to reach Edge Functions.
create or replace function public.vero_set_project_url(p_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := rtrim(btrim(coalesce(p_url, '')), '/');
begin
  if v_url !~ '^https?://[A-Za-z0-9.:-]+$' then
    raise exception 'expected a base URL like https://<ref>.supabase.co' using errcode = '22023';
  end if;
  perform public.vero_upsert_secret('project_url', v_url, 'Base URL of this Supabase project (used by database triggers to call Edge Functions)');
end;
$$;

-- Shared secret between the push trigger and the send-push function.
do $$
begin
  if to_regclass('vault.secrets') is not null then
    if public.vero_read_secret('push_webhook_secret') is null then
      perform public.vero_upsert_secret(
        'push_webhook_secret',
        encode(extensions.gen_random_bytes(32), 'hex'),
        'Authenticates database -> send-push calls (x-webhook-secret header)'
      );
    end if;
  end if;
end
$$;

-- send-push calls this (service role) to check the x-webhook-secret header.
-- Compares digests so the comparison time does not depend on the secret.
create or replace function public.verify_push_webhook_secret(p_secret text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_expected text := public.vero_read_secret('push_webhook_secret');
begin
  if v_expected is null or p_secret is null or char_length(p_secret) < 32 then
    return false;
  end if;
  return sha256(convert_to(p_secret, 'UTF8')) = sha256(convert_to(v_expected, 'UTF8'));
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- USER SETTINGS (privacy preferences, synced across the user's devices)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.user_settings (
  user_id                      uuid primary key default auth.uid() references public.profiles (id) on delete cascade,
  read_receipts                boolean not null default true,
  typing_indicators            boolean not null default true,
  last_seen                    text not null default 'everyone'
                               check (last_seen in ('everyone', 'contacts', 'nobody')),
  show_online                  boolean not null default true,
  default_disappearing_seconds integer not null default 0
                               check (default_disappearing_seconds between 0 and 31536000),
  -- Show the sender's name in push notifications (never content). Off by default.
  notification_previews        boolean not null default false,
  updated_at                   timestamptz not null default now()
);

create trigger user_settings_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

alter table public.user_settings enable row level security;

create policy "users read their own settings"
  on public.user_settings for select to authenticated
  using (user_id = (select auth.uid()));

create policy "users create their own settings"
  on public.user_settings for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "users update their own settings"
  on public.user_settings for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.user_settings from anon, authenticated;
grant select, insert, update on public.user_settings to authenticated;
grant all on public.user_settings to service_role;

-- Every profile gets a settings row.
create or replace function public.profiles_create_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_settings (user_id) values (new.id) on conflict (user_id) do nothing;
  return null;
end;
$$;

create trigger profiles_create_settings
  after insert on public.profiles
  for each row execute function public.profiles_create_settings();

insert into public.user_settings (user_id)
select id from public.profiles
on conflict (user_id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- LAST SEEN (profiles.last_seen_at, hidden behind get_last_seen)
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.profiles add column if not exists last_seen_at timestamptz;

-- Clients may read every profile column except last_seen_at.
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into v_cols
  from pg_attribute
  where attrelid = 'public.profiles'::regclass and attnum > 0 and not attisdropped
    and attname <> 'last_seen_at';
  revoke select on public.profiles from anon, authenticated;
  execute format('grant select (%s) on public.profiles to anon, authenticated', v_cols);
end
$$;

-- "contacts" = people the caller currently shares a conversation with.
create or replace function public.is_contact(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversation_members a
    join public.conversation_members b on b.conversation_id = a.conversation_id
    where a.user_id = p_a and a.left_at is null
      and b.user_id = p_b and b.left_at is null
  );
$$;

-- Throttled heartbeat. Stores nothing (and clears the old value) when the
-- user hides their last seen.
create or replace function public.touch_last_seen()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me  uuid := auth.uid();
  v_vis text;
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select last_seen into v_vis from public.user_settings where user_id = v_me;
  if coalesce(v_vis, 'everyone') = 'nobody' then
    update public.profiles set last_seen_at = null where id = v_me and last_seen_at is not null;
    return;
  end if;
  update public.profiles
     set last_seen_at = now()
   where id = v_me
     and (last_seen_at is null or last_seen_at < now() - interval '60 seconds');
end;
$$;

-- Returns null whenever the caller may not see it:
--   * target hides it ('nobody', or 'contacts' and caller isn't one)
--   * caller hides their own last seen (reciprocity, like WhatsApp)
--   * either side blocked the other
create or replace function public.get_last_seen(p_user_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_at     timestamptz;
  v_theirs text;
  v_mine   text;
begin
  if v_me is null or p_user_id is null then
    return null;
  end if;
  select last_seen_at into v_at from public.profiles where id = p_user_id;
  if p_user_id = v_me then
    return v_at;
  end if;
  if public.is_blocked_between(v_me, p_user_id) then
    return null;
  end if;
  select coalesce((select last_seen from public.user_settings where user_id = p_user_id), 'everyone') into v_theirs;
  select coalesce((select last_seen from public.user_settings where user_id = v_me), 'everyone') into v_mine;
  if v_mine = 'nobody' or v_theirs = 'nobody' then
    return null;
  end if;
  if v_theirs = 'contacts' and not public.is_contact(v_me, p_user_id) then
    return null;
  end if;
  return v_at;
end;
$$;

-- Switching last seen to 'nobody' erases the stored timestamp immediately.
create or replace function public.user_settings_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.last_seen = 'nobody' and old.last_seen is distinct from 'nobody' then
    update public.profiles set last_seen_at = null where id = new.user_id;
  end if;
  return null;
end;
$$;

create trigger user_settings_after_update
  after update of last_seen on public.user_settings
  for each row execute function public.user_settings_after_update();

-- ─────────────────────────────────────────────────────────────────────────────
-- READ RECEIPTS: server-side backstop for the client setting. A user with
-- read receipts off never moves their read watermark.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.conversation_members_enforce_receipts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.last_read_at is distinct from old.last_read_at
     and new.user_id = auth.uid()
     and exists (select 1 from public.user_settings where user_id = new.user_id and not read_receipts) then
    new.last_read_at := old.last_read_at;
  end if;
  return new;
end;
$$;

create trigger conversation_members_enforce_receipts
  before update of last_read_at on public.conversation_members
  for each row execute function public.conversation_members_enforce_receipts();

-- ─────────────────────────────────────────────────────────────────────────────
-- MUTED CONVERSATIONS (per member; only visible to that member)
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.conversation_members add column if not exists muted_until timestamptz;

-- Co-members can read every member column except muted_until.
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into v_cols
  from pg_attribute
  where attrelid = 'public.conversation_members'::regclass and attnum > 0 and not attisdropped
    and attname <> 'muted_until';
  revoke select on public.conversation_members from anon, authenticated;
  execute format('grant select (%s) on public.conversation_members to authenticated', v_cols);
end
$$;

-- p_until: null (or in the past) unmutes; 'infinity' mutes until unmuted.
create or replace function public.mute_conversation(p_conversation_id uuid, p_until timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversation_members
     set muted_until = case when p_until is null or p_until <= now() then null else p_until end
   where conversation_id = p_conversation_id
     and user_id = auth.uid()
     and left_at is null;
  if not found then
    raise exception 'not a member' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.get_conversation_mutes()
returns table (conversation_id uuid, muted_until timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select cm.conversation_id, cm.muted_until
  from public.conversation_members cm
  where cm.user_id = auth.uid()
    and cm.left_at is null
    and cm.muted_until is not null
    and cm.muted_until > now();
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PUSH
-- ─────────────────────────────────────────────────────────────────────────────

-- Revoking ("logging out") a device removes its push token at once.
create or replace function public.devices_revoked_clear_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    delete from public.push_tokens where device_id = new.id;
  end if;
  return null;
end;
$$;

create trigger devices_revoked_clear_push
  after update of revoked_at on public.devices
  for each row execute function public.devices_revoked_clear_push();

-- Queues an async POST to the send-push Edge Function. Never raises: a push
-- problem must not fail the INSERT that caused it. Returns the pg_net request
-- id, or null when push isn't configured.
--
-- Reusable hook (e.g. for calls):
--   perform public.send_push_event('call', jsonb_build_object('call_id', v_call));
create or replace function public.send_push_event(p_type text, p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
  v_id     bigint;
begin
  if p_type not in ('message', 'call') then
    raise exception 'unknown push type %', p_type using errcode = '22023';
  end if;
  v_url := public.vero_read_secret('project_url');
  v_secret := public.vero_read_secret('push_webhook_secret');
  if v_url is null or v_secret is null
     or to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    return null;
  end if;
  begin
    execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 5000)'
      into v_id
      using rtrim(v_url, '/') || '/functions/v1/send-push',
            coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('type', p_type),
            jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret);
  exception when others then
    raise warning '[vero] could not queue push: %', sqlerrm;
    return null;
  end;
  return v_id;
end;
$$;

-- Wakes recipients for new text/media messages. Only ids travel; the
-- ciphertext never leaves the database.
create or replace function public.messages_push_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.message_type not in ('text', 'media') then
    return null;
  end if;
  -- Skip the HTTP round trip when nobody can be notified.
  if not exists (
    select 1
    from public.conversation_members cm
    join public.push_tokens pt on pt.user_id = cm.user_id
    where cm.conversation_id = new.conversation_id
      and cm.left_at is null
      and cm.user_id <> new.sender_user_id
      and (cm.muted_until is null or cm.muted_until <= now())
  ) then
    return null;
  end if;
  perform public.send_push_event('message', jsonb_build_object(
    'message_id', new.id,
    'conversation_id', new.conversation_id
  ));
  return null;
end;
$$;

create trigger messages_push_after_insert
  after insert on public.messages
  for each row execute function public.messages_push_after_insert();

-- Whom to wake for a message: every active device (with a token) of every
-- current member except the sender, skipping members who muted the chat or
-- blocked the sender.
create or replace function public.get_message_push_targets(p_message_id uuid)
returns table (
  device_id         uuid,
  user_id           uuid,
  token             text,
  previews          boolean,
  sender_name       text,
  conversation_id   uuid,
  conversation_type text,
  group_name        text
)
language sql
stable
security definer
set search_path = ''
as $$
  select pt.device_id, pt.user_id, pt.token,
         coalesce(us.notification_previews, false),
         sp.display_name, c.id, c.conversation_type, c.group_name
  from public.messages m
  join public.conversations c on c.id = m.conversation_id
  join public.profiles sp on sp.id = m.sender_user_id
  join public.conversation_members cm on cm.conversation_id = m.conversation_id
  join public.devices d on d.user_id = cm.user_id and d.revoked_at is null
  join public.push_tokens pt on pt.device_id = d.id
  left join public.user_settings us on us.user_id = cm.user_id
  where m.id = p_message_id
    and m.deleted_at is null
    and m.message_type in ('text', 'media')
    and cm.left_at is null
    and cm.user_id <> m.sender_user_id
    and (cm.muted_until is null or cm.muted_until <= now())
    and not exists (
      select 1 from public.blocks b
      where b.blocker_user_id = cm.user_id and b.blocked_user_id = m.sender_user_id
    );
$$;

-- Whom to ring for a call: the callee's active devices, while the call is
-- still ringing. p_requester (optional) must be the caller.
create or replace function public.get_call_push_targets(p_call_id uuid, p_requester uuid default null)
returns table (
  device_id       uuid,
  user_id         uuid,
  token           text,
  previews        boolean,
  caller_name     text,
  conversation_id uuid,
  call_id         uuid,
  call_type       text
)
language sql
stable
security definer
set search_path = ''
as $$
  select pt.device_id, pt.user_id, pt.token,
         coalesce(us.notification_previews, false),
         cp.display_name, cs.conversation_id, cs.id, cs.call_type
  from public.call_sessions cs
  join public.profiles cp on cp.id = cs.caller_id
  join public.devices d on d.user_id = cs.callee_id and d.revoked_at is null
  join public.push_tokens pt on pt.device_id = d.id
  left join public.user_settings us on us.user_id = cs.callee_id
  where cs.id = p_call_id
    and cs.status = 'ringing'
    and cs.created_at > now() - interval '2 minutes'
    and (p_requester is null or cs.caller_id = p_requester)
    and not exists (
      select 1 from public.blocks b
      where b.blocker_user_id = cs.callee_id and b.blocked_user_id = cs.caller_id
    );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRESENCE (Realtime Presence on private "presence:<conversation id>" topics)
-- Added as extra policies so 001's can_use_realtime_topic stays untouched.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.can_use_presence_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id text := split_part(coalesce(p_topic, ''), ':', 2);
begin
  if split_part(coalesce(p_topic, ''), ':', 1) <> 'presence'
     or v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.is_conversation_member(v_id::uuid);
end;
$$;

create policy "vero members receive presence"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'presence'
    and public.can_use_presence_topic((select realtime.topic()))
  );

create policy "vero members track presence"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and public.can_use_presence_topic((select realtime.topic()))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- ENCRYPTED BACKUPS: private bucket, one folder per user (<user_id>/backup.bin).
-- The blob is encrypted on device with a key derived from the user's backup
-- passphrase; the server never sees the passphrase or the key.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('vero-backups', 'vero-backups', false)
    on conflict (id) do update set public = false;
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit'
    ) then
      execute $sql$update storage.buckets set file_size_limit = 52428800 where id = 'vero-backups'$sql$;
    end if;
  end if;

  if to_regclass('storage.objects') is not null then
    execute $sql$drop policy if exists "vero backups: owner reads" on storage.objects$sql$;
    execute $sql$drop policy if exists "vero backups: owner uploads" on storage.objects$sql$;
    execute $sql$drop policy if exists "vero backups: owner updates" on storage.objects$sql$;
    execute $sql$drop policy if exists "vero backups: owner deletes" on storage.objects$sql$;

    execute $sql$
      create policy "vero backups: owner reads" on storage.objects for select to authenticated
      using (bucket_id = 'vero-backups' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $sql$;
    execute $sql$
      create policy "vero backups: owner uploads" on storage.objects for insert to authenticated
      with check (bucket_id = 'vero-backups' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $sql$;
    execute $sql$
      create policy "vero backups: owner updates" on storage.objects for update to authenticated
      using (bucket_id = 'vero-backups' and (storage.foldername(name))[1] = (select auth.uid())::text)
      with check (bucket_id = 'vero-backups' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $sql$;
    execute $sql$
      create policy "vero backups: owner deletes" on storage.objects for delete to authenticated
      using (bucket_id = 'vero-backups' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $sql$;
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Function privileges (Postgres grants EXECUTE to PUBLIC by default).
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function public.vero_read_secret(text) from public, anon, authenticated;
revoke execute on function public.vero_upsert_secret(text, text, text) from public, anon, authenticated;
revoke execute on function public.vero_set_project_url(text) from public, anon, authenticated;
revoke execute on function public.verify_push_webhook_secret(text) from public, anon, authenticated;
revoke execute on function public.profiles_create_settings() from public, anon, authenticated;
revoke execute on function public.is_contact(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.touch_last_seen() from public, anon, authenticated;
revoke execute on function public.get_last_seen(uuid) from public, anon, authenticated;
revoke execute on function public.user_settings_after_update() from public, anon, authenticated;
revoke execute on function public.conversation_members_enforce_receipts() from public, anon, authenticated;
revoke execute on function public.mute_conversation(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.get_conversation_mutes() from public, anon, authenticated;
revoke execute on function public.devices_revoked_clear_push() from public, anon, authenticated;
revoke execute on function public.send_push_event(text, jsonb) from public, anon, authenticated;
revoke execute on function public.messages_push_after_insert() from public, anon, authenticated;
revoke execute on function public.get_message_push_targets(uuid) from public, anon, authenticated;
revoke execute on function public.get_call_push_targets(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.can_use_presence_topic(text) from public, anon, authenticated;

grant execute on function public.touch_last_seen() to authenticated;
grant execute on function public.get_last_seen(uuid) to authenticated;
grant execute on function public.mute_conversation(uuid, timestamptz) to authenticated;
grant execute on function public.get_conversation_mutes() to authenticated;
grant execute on function public.can_use_presence_topic(text) to authenticated;

grant execute on function public.verify_push_webhook_secret(text) to service_role;
grant execute on function public.get_message_push_targets(uuid) to service_role;
grant execute on function public.get_call_push_targets(uuid, uuid) to service_role;
grant execute on function public.vero_set_project_url(text) to service_role;
grant execute on function public.send_push_event(text, jsonb) to service_role;
