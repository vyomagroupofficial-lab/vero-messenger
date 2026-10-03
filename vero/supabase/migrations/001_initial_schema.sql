-- ============================================================================
-- Vero Messenger - initial schema
-- ============================================================================
-- Security model
--   * Message content is end-to-end encrypted on device. `messages.ciphertext`
--     holds an opaque envelope (see src/core/crypto/primitives.ts); the server
--     never sees plaintext, media keys or private keys.
--   * Every table has RLS. Policies use SECURITY DEFINER helpers so they never
--     recurse into the table they protect.
--   * Anything that changes who can read a conversation (creating chats,
--     adding/removing members) goes through RPCs that check authorization;
--     clients cannot insert membership rows directly.
--   * Realtime uses *private* broadcast channels authorised by policies on
--     realtime.messages:  conversation:<id>, user:<id>, call:<id>.
--   * All SECURITY DEFINER functions pin `search_path = ''`.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Shared helpers
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PROFILES (created automatically from auth.users metadata on sign-up)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  username         text not null unique
                   check (username ~ '^[a-z0-9_]{3,30}$'),
  display_name     text not null
                   check (char_length(btrim(display_name)) between 1 and 64),
  avatar_reference text check (avatar_reference is null or char_length(avatar_reference) <= 512),
  about            text check (about is null or char_length(about) <= 280),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

create policy "profiles are visible to signed-in users"
  on public.profiles for select to authenticated
  using (true);

create policy "users update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (display_name, avatar_reference, about) on public.profiles to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  v_display  text := btrim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
begin
  if v_username = '' then
    v_username := 'user_' || substr(replace(new.id::text, '-', ''), 1, 12);
  end if;
  if v_display = '' then
    v_display := v_username;
  end if;
  insert into public.profiles (id, username, display_name)
  values (new.id, v_username, left(v_display, 64));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Lets the sign-up screen give a friendly error before calling auth.signUp.
create or replace function public.username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.profiles where username = lower(btrim(p_username)));
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- DEVICES (one row per app installation; holds the PUBLIC identity key only)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.devices (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  device_label        text not null default 'Mobile device'
                      check (char_length(device_label) between 1 and 64),
  identity_public_key text not null check (char_length(identity_public_key) between 40 and 64),
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  revoked_at          timestamptz,
  unique (user_id, identity_public_key)
);

create index devices_user_active_idx on public.devices (user_id) where revoked_at is null;

alter table public.devices enable row level security;

-- Other users' device keys are fetched via get_device_keys()/get_user_device_keys().
create policy "users see their own devices"
  on public.devices for select to authenticated
  using (user_id = (select auth.uid()));

create policy "users register their own devices"
  on public.devices for insert to authenticated
  with check (user_id = (select auth.uid()) and revoked_at is null);

create policy "users update their own devices"
  on public.devices for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke update, delete on public.devices from anon, authenticated;
-- The identity key is immutable: a new key means a new device row.
grant update (device_label, last_seen_at, revoked_at) on public.devices to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- CONVERSATIONS & MEMBERS
-- ─────────────────────────────────────────────────────────────────────────────

create table public.conversations (
  id                uuid primary key default gen_random_uuid(),
  conversation_type text not null check (conversation_type in ('direct', 'group')),
  -- Group names are server-visible metadata (documented trade-off).
  group_name        text check (group_name is null or char_length(btrim(group_name)) between 1 and 64),
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (conversation_type = 'group' or group_name is null)
);

create index conversations_updated_idx on public.conversations (updated_at desc);

create trigger conversations_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

create table public.conversation_members (
  conversation_id   uuid not null references public.conversations (id) on delete cascade,
  -- References profiles (not auth.users) so PostgREST can embed member profiles.
  user_id           uuid not null references public.profiles (id) on delete cascade,
  role              text not null default 'member' check (role in ('member', 'admin', 'owner')),
  joined_at         timestamptz not null default now(),
  left_at           timestamptz,
  last_delivered_at timestamptz,
  last_read_at      timestamptz,
  primary key (conversation_id, user_id)
);

create index conversation_members_user_idx on public.conversation_members (user_id) where left_at is null;

-- SECURITY DEFINER so RLS policies can call it without recursing.
create or replace function public.is_conversation_member(p_conversation_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = p_conversation_id
      and user_id = p_user_id
      and left_at is null
  );
$$;

create or replace function public.is_conversation_admin(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = p_conversation_id
      and user_id = auth.uid()
      and left_at is null
      and role in ('admin', 'owner')
  );
$$;

-- True if the caller has ever shared a conversation with p_user_id
-- (used to authorise public-key lookups, including for people who left).
create or replace function public.has_shared_conversation(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id = auth.uid() or exists (
    select 1
    from public.conversation_members me
    join public.conversation_members them on them.conversation_id = me.conversation_id
    where me.user_id = auth.uid()
      and me.left_at is null
      and them.user_id = p_user_id
  );
$$;

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;

create policy "members see their conversations"
  on public.conversations for select to authenticated
  using (public.is_conversation_member(id));

create policy "members see co-members"
  on public.conversation_members for select to authenticated
  using (public.is_conversation_member(conversation_id));

-- All writes go through the RPCs below.
revoke insert, update, delete on public.conversations from anon, authenticated;
revoke insert, update, delete on public.conversation_members from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCKS & REPORTS
-- ─────────────────────────────────────────────────────────────────────────────

create table public.blocks (
  blocker_user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  blocked_user_id uuid not null references auth.users (id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  check (blocker_user_id <> blocked_user_id)
);

alter table public.blocks enable row level security;

create policy "users manage their own blocks"
  on public.blocks for all to authenticated
  using (blocker_user_id = (select auth.uid()))
  with check (blocker_user_id = (select auth.uid()));

create or replace function public.is_blocked_between(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.blocks
    where (blocker_user_id = a and blocked_user_id = b)
       or (blocker_user_id = b and blocked_user_id = a)
  );
$$;

create table public.reports (
  id               uuid primary key default gen_random_uuid(),
  reporter_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  reported_user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id  uuid references public.conversations (id) on delete set null,
  reason           text not null check (char_length(reason) between 1 and 1000),
  created_at       timestamptz not null default now()
);

alter table public.reports enable row level security;

create policy "users file reports"
  on public.reports for insert to authenticated
  with check (reporter_id = (select auth.uid()) and reporter_id <> reported_user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- MEDIA (rows are written by the upload Edge Function with the service role)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.media (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references public.conversations (id) on delete cascade,
  uploader_id       uuid not null references auth.users (id) on delete cascade,
  storage_object_id text not null,           -- Google Drive file id of the ENCRYPTED blob
  encrypted_size    bigint not null check (encrypted_size > 0),
  encrypted_hash    text not null,           -- BLAKE2b-256 of the ciphertext (hex)
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create index media_conversation_idx on public.media (conversation_id);

alter table public.media enable row level security;

create policy "members see conversation media records"
  on public.media for select to authenticated
  using (public.is_conversation_member(conversation_id));

revoke insert, update, delete on public.media from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- MESSAGES (ciphertext only)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.messages (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references public.conversations (id) on delete cascade,
  sender_device_id    uuid not null references public.devices (id) on delete cascade,
  sender_user_id      uuid not null references public.profiles (id) on delete cascade,
  ciphertext          text not null check (char_length(ciphertext) <= 262144),
  -- Coarse type only; the real kind (photo, voice, ...) is inside the ciphertext.
  message_type        text not null default 'text'
                      check (message_type in ('text', 'media', 'reaction', 'system')),
  media_id            uuid references public.media (id) on delete set null,
  reply_to_message_id uuid references public.messages (id) on delete set null,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz,
  deleted_at          timestamptz
);

create index messages_conversation_created_idx on public.messages (conversation_id, created_at desc);
create index messages_expiry_idx on public.messages (expires_at) where expires_at is not null;
create index messages_sender_device_idx on public.messages (sender_device_id);

alter table public.messages enable row level security;

create policy "members read conversation messages"
  on public.messages for select to authenticated
  using (
    public.is_conversation_member(conversation_id)
    and (expires_at is null or expires_at > now())
  );

create policy "members send messages from their own devices"
  on public.messages for insert to authenticated
  with check (
    sender_user_id = (select auth.uid())
    and public.is_conversation_member(conversation_id)
  );

revoke update, delete on public.messages from anon, authenticated;

create or replace function public.messages_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_type  text;
begin
  select user_id into v_owner
  from public.devices
  where id = new.sender_device_id and revoked_at is null;

  if v_owner is null or v_owner is distinct from auth.uid() then
    raise exception 'sender device is not registered to this user' using errcode = '42501';
  end if;

  new.sender_user_id := v_owner;
  new.created_at     := now();
  new.deleted_at     := null;

  if new.expires_at is not null and new.expires_at <= now() then
    raise exception 'expires_at must be in the future' using errcode = '22023';
  end if;

  select conversation_type into v_type from public.conversations where id = new.conversation_id;
  if v_type = 'direct' and exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = new.conversation_id
      and cm.user_id <> v_owner
      and public.is_blocked_between(cm.user_id, v_owner)
  ) then
    raise exception 'cannot message this user' using errcode = '42501';
  end if;

  if new.reply_to_message_id is not null and not exists (
    select 1 from public.messages
    where id = new.reply_to_message_id and conversation_id = new.conversation_id
  ) then
    raise exception 'reply target is not in this conversation' using errcode = '22023';
  end if;

  if new.media_id is not null and not exists (
    select 1 from public.media
    where id = new.media_id and conversation_id = new.conversation_id and uploader_id = v_owner
  ) then
    raise exception 'media does not belong to this conversation' using errcode = '22023';
  end if;

  return new;
end;
$$;

create trigger messages_before_insert
  before insert on public.messages
  for each row execute function public.messages_before_insert();

-- Fan the ciphertext out over the private realtime channel, ping members' inboxes
-- and bump conversation ordering.
create or replace function public.messages_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations set updated_at = new.created_at where id = new.conversation_id;

  perform realtime.send(
    jsonb_build_object(
      'id', new.id,
      'conversation_id', new.conversation_id,
      'sender_device_id', new.sender_device_id,
      'sender_user_id', new.sender_user_id,
      'ciphertext', new.ciphertext,
      'message_type', new.message_type,
      'media_id', new.media_id,
      'reply_to_message_id', new.reply_to_message_id,
      'created_at', new.created_at,
      'expires_at', new.expires_at
    ),
    'message.new',
    'conversation:' || new.conversation_id::text,
    true
  );

  -- Lightweight "something arrived" ping to each member's personal topic so
  -- chat lists update without subscribing to every conversation.
  perform realtime.send(
    jsonb_build_object('conversation_id', new.conversation_id, 'message_id', new.id),
    'inbox.message',
    'user:' || cm.user_id::text,
    true
  )
  from public.conversation_members cm
  where cm.conversation_id = new.conversation_id and cm.left_at is null;

  return null;
end;
$$;

create trigger messages_after_insert
  after insert on public.messages
  for each row execute function public.messages_after_insert();

-- ─────────────────────────────────────────────────────────────────────────────
-- PUSH TOKENS
-- ─────────────────────────────────────────────────────────────────────────────

create table public.push_tokens (
  device_id  uuid primary key references public.devices (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  token      text not null check (char_length(token) <= 512),
  platform   text not null check (platform in ('ios', 'android', 'web')),
  updated_at timestamptz not null default now()
);

create index push_tokens_user_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

create policy "users manage push tokens for their own devices"
  on public.push_tokens for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.devices d
      where d.id = device_id and d.user_id = (select auth.uid()) and d.revoked_at is null
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- CALL SESSIONS (signalling metadata only; media is peer-to-peer)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.call_sessions (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  caller_id       uuid not null references auth.users (id) on delete cascade,
  callee_id       uuid not null references auth.users (id) on delete cascade,
  call_type       text not null check (call_type in ('voice', 'video')),
  status          text not null default 'ringing'
                  check (status in ('ringing', 'active', 'ended', 'missed', 'rejected')),
  created_at      timestamptz not null default now(),
  answered_at     timestamptz,
  ended_at        timestamptz
);

create index call_sessions_participants_idx on public.call_sessions (caller_id, callee_id, created_at desc);

alter table public.call_sessions enable row level security;

create policy "participants see their calls"
  on public.call_sessions for select to authenticated
  using ((select auth.uid()) in (caller_id, callee_id));

revoke insert, update, delete on public.call_sessions from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPCs
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.create_direct_conversation(p_other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_conv uuid;
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_other_user_id is null or p_other_user_id = v_me then
    raise exception 'invalid participant' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_other_user_id) then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if public.is_blocked_between(v_me, p_other_user_id) then
    raise exception 'cannot start a conversation with this user' using errcode = '42501';
  end if;

  -- Serialise concurrent creation for the same pair.
  perform pg_advisory_xact_lock(
    hashtextextended(least(v_me, p_other_user_id)::text || greatest(v_me, p_other_user_id)::text, 0)
  );

  select c.id into v_conv
  from public.conversations c
  join public.conversation_members a on a.conversation_id = c.id and a.user_id = v_me
  join public.conversation_members b on b.conversation_id = c.id and b.user_id = p_other_user_id
  where c.conversation_type = 'direct'
  limit 1;

  if v_conv is not null then
    -- Re-activate if either side had left.
    update public.conversation_members
       set left_at = null
     where conversation_id = v_conv and user_id in (v_me, p_other_user_id) and left_at is not null;
    return v_conv;
  end if;

  insert into public.conversations (conversation_type, created_by)
  values ('direct', v_me)
  returning id into v_conv;

  insert into public.conversation_members (conversation_id, user_id, role)
  values (v_conv, v_me, 'member'), (v_conv, p_other_user_id, 'member');

  return v_conv;
end;
$$;

create or replace function public.create_group_conversation(p_name text, p_member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me      uuid := auth.uid();
  v_conv    uuid;
  v_members uuid[];
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) = 0 then
    raise exception 'a group needs a name' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct m), '{}') into v_members
  from unnest(coalesce(p_member_ids, '{}')) as m
  where m <> v_me;

  if cardinality(v_members) = 0 then
    raise exception 'a group needs at least one other member' using errcode = '22023';
  end if;
  if cardinality(v_members) > 255 then
    raise exception 'too many members' using errcode = '22023';
  end if;
  if (select count(*) from public.profiles where id = any (v_members)) <> cardinality(v_members) then
    raise exception 'unknown member' using errcode = 'P0002';
  end if;
  if exists (select 1 from unnest(v_members) m where public.is_blocked_between(v_me, m)) then
    raise exception 'cannot add a blocked user' using errcode = '42501';
  end if;

  insert into public.conversations (conversation_type, group_name, created_by)
  values ('group', btrim(p_name), v_me)
  returning id into v_conv;

  insert into public.conversation_members (conversation_id, user_id, role)
  values (v_conv, v_me, 'owner');

  insert into public.conversation_members (conversation_id, user_id, role)
  select v_conv, m, 'member' from unnest(v_members) as m;

  return v_conv;
end;
$$;

create or replace function public.add_group_members(p_conversation_id uuid, p_member_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_conversation_admin(p_conversation_id) then
    raise exception 'only group admins can add members' using errcode = '42501';
  end if;
  if not exists (select 1 from public.conversations where id = p_conversation_id and conversation_type = 'group') then
    raise exception 'not a group' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_member_ids) m
    where not exists (select 1 from public.profiles where id = m)
       or public.is_blocked_between(auth.uid(), m)
  ) then
    raise exception 'invalid member' using errcode = '22023';
  end if;

  insert into public.conversation_members (conversation_id, user_id, role)
  select p_conversation_id, m, 'member' from unnest(p_member_ids) as m
  on conflict (conversation_id, user_id)
  do update set left_at = null, joined_at = now(), role = 'member'
  where public.conversation_members.left_at is not null;

  perform realtime.send(jsonb_build_object('conversation_id', p_conversation_id),
                        'members.changed', 'conversation:' || p_conversation_id::text, true);
end;
$$;

-- Admins remove others; anyone may remove themselves (leave).
create or replace function public.remove_group_member(p_conversation_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id <> auth.uid() and not public.is_conversation_admin(p_conversation_id) then
    raise exception 'only group admins can remove members' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.conversation_members
    where conversation_id = p_conversation_id and user_id = p_user_id and role = 'owner'
  ) and p_user_id <> auth.uid() then
    raise exception 'the owner cannot be removed' using errcode = '42501';
  end if;

  update public.conversation_members
     set left_at = now()
   where conversation_id = p_conversation_id and user_id = p_user_id and left_at is null;

  perform realtime.send(jsonb_build_object('conversation_id', p_conversation_id),
                        'members.changed', 'conversation:' || p_conversation_id::text, true);
end;
$$;

create or replace function public.rename_group(p_conversation_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_conversation_admin(p_conversation_id) then
    raise exception 'only group admins can rename the group' using errcode = '42501';
  end if;
  update public.conversations set group_name = btrim(p_name)
  where id = p_conversation_id and conversation_type = 'group';
end;
$$;

-- Public identity keys of every active device of every current member
-- (including the caller's own devices) - the recipient list for a new message.
create or replace function public.get_conversation_devices(p_conversation_id uuid)
returns table (device_id uuid, user_id uuid, identity_public_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.user_id, d.identity_public_key
  from public.conversation_members cm
  join public.devices d on d.user_id = cm.user_id and d.revoked_at is null
  where cm.conversation_id = p_conversation_id
    and cm.left_at is null
    and public.is_conversation_member(p_conversation_id);
$$;

-- Keys for specific devices (to verify senders of historical messages).
create or replace function public.get_device_keys(p_device_ids uuid[])
returns table (device_id uuid, user_id uuid, identity_public_key text, revoked_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.user_id, d.identity_public_key, d.revoked_at
  from public.devices d
  where d.id = any (p_device_ids)
    and public.has_shared_conversation(d.user_id);
$$;

-- Active device keys of one user (for safety numbers).
create or replace function public.get_user_device_keys(p_user_id uuid)
returns table (device_id uuid, identity_public_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.identity_public_key
  from public.devices d
  where d.user_id = p_user_id
    and d.revoked_at is null
    and public.has_shared_conversation(p_user_id);
$$;

create or replace function public.search_profiles(p_query text)
returns table (id uuid, username text, display_name text, avatar_reference text, about text)
language sql
stable
security definer
set search_path = ''
as $$
  with q as (
    select replace(replace(replace(lower(btrim(p_query)), '\', '\\'), '%', '\%'), '_', '\_') as term
  )
  select p.id, p.username, p.display_name, p.avatar_reference, p.about
  from public.profiles p, q
  where char_length(q.term) >= 2
    and p.id <> auth.uid()
    and not public.is_blocked_between(auth.uid(), p.id)
    and (p.username like q.term || '%' or lower(p.display_name) like '%' || q.term || '%')
  order by (p.username = lower(btrim(p_query))) desc, p.username
  limit 25;
$$;

-- Soft-delete for everyone: the ciphertext is wiped server-side.
create or replace function public.delete_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv  uuid;
  v_media uuid;
begin
  update public.messages
     set deleted_at = now(), ciphertext = '', expires_at = null
   where id = p_message_id
     and sender_user_id = auth.uid()
     and deleted_at is null
  returning conversation_id, media_id into v_conv, v_media;

  if v_conv is null then
    raise exception 'message not found' using errcode = 'P0002';
  end if;

  if v_media is not null then
    update public.media set deleted_at = now() where id = v_media;
  end if;

  perform realtime.send(jsonb_build_object('id', p_message_id),
                        'message.deleted', 'conversation:' || v_conv::text, true);
end;
$$;

-- Delivery/read receipts as per-member watermarks (cheaper and leaks less than
-- per-message rows). p_kind: 'delivered' | 'read'.
create or replace function public.mark_conversation_receipt(
  p_conversation_id uuid,
  p_kind text,
  p_until timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz := least(coalesce(p_until, now()), now());
begin
  if p_kind not in ('delivered', 'read') then
    raise exception 'invalid receipt kind' using errcode = '22023';
  end if;

  update public.conversation_members
     set last_delivered_at = greatest(coalesce(last_delivered_at, '-infinity'), v_at),
         last_read_at = case when p_kind = 'read'
                             then greatest(coalesce(last_read_at, '-infinity'), v_at)
                             else last_read_at end
   where conversation_id = p_conversation_id
     and user_id = auth.uid()
     and left_at is null;

  if found then
    perform realtime.send(
      jsonb_build_object('user_id', auth.uid(), 'kind', p_kind, 'at', v_at),
      'receipt', 'conversation:' || p_conversation_id::text, true);
  end if;
end;
$$;

create or replace function public.start_call(p_conversation_id uuid, p_call_type text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_callee uuid;
  v_call   uuid;
  v_name   text;
begin
  if not public.is_conversation_member(p_conversation_id) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if not exists (select 1 from public.conversations where id = p_conversation_id and conversation_type = 'direct') then
    raise exception 'calls are only supported in direct chats' using errcode = '22023';
  end if;

  select user_id into v_callee from public.conversation_members
  where conversation_id = p_conversation_id and user_id <> v_me and left_at is null;

  if v_callee is null or public.is_blocked_between(v_me, v_callee) then
    raise exception 'cannot call this user' using errcode = '42501';
  end if;

  insert into public.call_sessions (conversation_id, caller_id, callee_id, call_type)
  values (p_conversation_id, v_me, v_callee, p_call_type)
  returning id into v_call;

  select display_name into v_name from public.profiles where id = v_me;

  perform realtime.send(
    jsonb_build_object('call_id', v_call, 'conversation_id', p_conversation_id,
                       'caller_id', v_me, 'caller_name', v_name, 'call_type', p_call_type),
    'call.invite', 'user:' || v_callee::text, true);

  return v_call;
end;
$$;

create or replace function public.update_call_status(p_call_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('active', 'ended', 'missed', 'rejected') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  update public.call_sessions
     set status      = p_status,
         answered_at = case when p_status = 'active' then coalesce(answered_at, now()) else answered_at end,
         ended_at    = case when p_status in ('ended', 'missed', 'rejected') then coalesce(ended_at, now()) else ended_at end
   where id = p_call_id
     and auth.uid() in (caller_id, callee_id)
     and status not in ('ended', 'missed', 'rejected');
end;
$$;

-- Hard-deletes expired disappearing messages. Scheduled below with pg_cron.
create or replace function public.cleanup_expired_messages()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.media m set deleted_at = now()
  from public.messages msg
  where msg.media_id = m.id and msg.expires_at < now() and m.deleted_at is null;

  delete from public.messages where expires_at is not null and expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Function privileges: nothing is callable anonymously except username checks.
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;
grant execute on function public.is_conversation_admin(uuid) to authenticated;
grant execute on function public.has_shared_conversation(uuid) to authenticated;
grant execute on function public.is_blocked_between(uuid, uuid) to authenticated;
grant execute on function public.create_direct_conversation(uuid) to authenticated;
grant execute on function public.create_group_conversation(text, uuid[]) to authenticated;
grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;
grant execute on function public.rename_group(uuid, text) to authenticated;
grant execute on function public.get_conversation_devices(uuid) to authenticated;
grant execute on function public.get_device_keys(uuid[]) to authenticated;
grant execute on function public.get_user_device_keys(uuid) to authenticated;
grant execute on function public.search_profiles(text) to authenticated;
grant execute on function public.delete_message(uuid) to authenticated;
grant execute on function public.mark_conversation_receipt(uuid, text, timestamptz) to authenticated;
grant execute on function public.start_call(uuid, text) to authenticated;
grant execute on function public.update_call_status(uuid, text) to authenticated;
grant execute on function public.cleanup_expired_messages() to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- REALTIME AUTHORISATION (private channels)
--   conversation:<uuid>  members may receive and send (typing, reactions)
--   user:<uuid>          only that user receives; only the server sends
--   call:<uuid>          only the two call participants
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.can_use_realtime_topic(p_topic text, p_write boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind text := split_part(p_topic, ':', 1);
  v_id   text := split_part(p_topic, ':', 2);
  v_uuid uuid;
begin
  if v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_uuid := v_id::uuid;

  if v_kind = 'conversation' then
    return public.is_conversation_member(v_uuid);
  elsif v_kind = 'user' then
    return not p_write and v_uuid = auth.uid();
  elsif v_kind = 'call' then
    return exists (
      select 1 from public.call_sessions
      where id = v_uuid and auth.uid() in (caller_id, callee_id)
    );
  end if;
  return false;
end;
$$;

grant execute on function public.can_use_realtime_topic(text, boolean) to authenticated;

create policy "vero members receive realtime"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.can_use_realtime_topic((select realtime.topic()), false)
  );

create policy "vero members send realtime"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.can_use_realtime_topic((select realtime.topic()), true)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEDULED CLEANUP (only if pg_cron is enabled on the project)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vero-cleanup-expired', '*/5 * * * *', 'select public.cleanup_expired_messages()');
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRIVATE BUCKET for encrypted attachments (default media backend).
-- No storage policies: only the Edge Functions (service role) touch it.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public)
    values ('vero-media', 'vero-media', false)
    on conflict (id) do nothing;
  end if;
end;
$$;
