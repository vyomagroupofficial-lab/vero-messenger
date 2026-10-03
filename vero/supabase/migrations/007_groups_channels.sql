-- ============================================================================
-- Vero Messenger - 007: group admin tools, invite links, channels, communities
-- ============================================================================
-- Applies on top of 001 alone. Never edits 001's objects; it only ADDS:
--   * group_settings      description / avatar / "only admins send" / "only
--                         admins edit info" / "approve new members"
--                         (enforced by a new BEFORE INSERT trigger on messages)
--   * group_events        membership & info changes, rendered as system
--                         messages client-side (logged by triggers, so 001's
--                         add/remove RPCs are covered too)
--   * group_invites       revocable invite links (random 43-char tokens) with
--                         expiry, max uses and optional admin approval
--   * group_join_requests pending joins awaiting admin approval
--   * channels            one-to-many broadcast. Channel posts are NOT end-to-end
--                         encrypted (server-readable, like WhatsApp Channels):
--                         per-device key fan-out doesn't scale to thousands of
--                         followers. The app labels this clearly.
--   * communities         related groups + an E2EE announcements group where
--                         only admins can post
--   * realtime topic `channel:<id>` authorised by NEW policies on
--     realtime.messages (policies are OR-ed with 001's).
--
-- Privacy notes (server-visible metadata, same trade-off as group names in 001)
--   * Group/channel/community names, descriptions and avatars are visible to
--     the server. Avatars are small (<= ~96 KB) data-URI images stored in the
--     row; they are shown to members and to holders of an invite link.
--   * Channel followers are visible only to themselves; admins see a count.
--     Channel admins are visible only to other admins; posts don't expose
--     their author (column privileges exclude author_id).
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Shared helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- 32 random bytes (two v4 UUIDs, ~244 bits of entropy), base64url, 43 chars.
create or replace function public.generate_invite_token()
returns text
language sql
volatile
set search_path = ''
as $$
  select translate(
    rtrim(encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '='),
    '+/', '-_');
$$;

-- Small inline avatar images. ~96 KB of base64 is plenty for a 256x256 JPEG.
create or replace function public.is_valid_avatar_data(p_data text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_data is null or (
    char_length(p_data) <= 131072
    and p_data ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$'
  );
$$;

-- Sliding-window rate limits for invite previews/joins and channel creation.
create table public.rate_limit_events (
  id         bigserial primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  bucket     text not null,
  created_at timestamptz not null default now()
);

create index rate_limit_events_lookup_idx on public.rate_limit_events (user_id, bucket, created_at);

alter table public.rate_limit_events enable row level security;
-- No policies: only SECURITY DEFINER functions touch this table.
revoke all on public.rate_limit_events from anon, authenticated;

-- Returns false (and records nothing) when the caller is over the limit.
create or replace function public.consume_rate_limit(p_bucket text, p_max integer, p_window interval)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_count integer;
begin
  if v_me is null then
    return false;
  end if;
  delete from public.rate_limit_events
   where user_id = v_me and bucket = p_bucket and created_at < now() - p_window;
  select count(*) into v_count from public.rate_limit_events
   where user_id = v_me and bucket = p_bucket;
  if v_count >= p_max then
    return false;
  end if;
  insert into public.rate_limit_events (user_id, bucket) values (v_me, p_bucket);
  return true;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- GROUP SETTINGS
-- ─────────────────────────────────────────────────────────────────────────────

create table public.group_settings (
  conversation_id        uuid primary key references public.conversations (id) on delete cascade,
  description            text check (description is null or char_length(description) <= 512),
  avatar_data            text check (public.is_valid_avatar_data(avatar_data)),
  only_admins_send       boolean not null default false,
  only_admins_edit_info  boolean not null default true,
  join_approval_required boolean not null default false,
  deleted_at             timestamptz,
  updated_at             timestamptz not null default now()
);

create trigger group_settings_updated_at
  before update on public.group_settings
  for each row execute function public.set_updated_at();

alter table public.group_settings enable row level security;

create policy "members see their group settings"
  on public.group_settings for select to authenticated
  using (public.is_conversation_member(conversation_id));

revoke all on public.group_settings from anon;
revoke insert, update, delete, truncate on public.group_settings from authenticated;
grant select on public.group_settings to authenticated;

-- Every group gets a settings row (defaults) as soon as it exists.
create or replace function public.conversations_create_group_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.conversation_type = 'group' then
    insert into public.group_settings (conversation_id) values (new.id) on conflict do nothing;
  end if;
  return null;
end;
$$;

create trigger conversations_create_group_settings
  after insert on public.conversations
  for each row execute function public.conversations_create_group_settings();

insert into public.group_settings (conversation_id)
select id from public.conversations where conversation_type = 'group'
on conflict do nothing;

-- Caller's (or a user's) current role in a conversation; null if not a member.
create or replace function public.group_member_role(p_conversation_id uuid, p_user_id uuid default auth.uid())
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.conversation_members
  where conversation_id = p_conversation_id and user_id = p_user_id and left_at is null;
$$;

create or replace function public.group_member_count(p_conversation_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.conversation_members
  where conversation_id = p_conversation_id and left_at is null;
$$;

-- An active (not deleted) group.
create or replace function public.is_active_group(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
    join public.group_settings gs on gs.conversation_id = c.id
    where c.id = p_conversation_id and c.conversation_type = 'group' and gs.deleted_at is null
  );
$$;

-- "Only admins can send messages" (and deleted groups accept nothing).
-- Named so it runs after 001's messages_before_insert, which has already
-- derived sender_user_id from the (verified) sender device.
create or replace function public.messages_group_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.group_settings;
  v_sender   uuid := coalesce(auth.uid(), new.sender_user_id);
begin
  select * into v_settings from public.group_settings where conversation_id = new.conversation_id;
  if not found then
    return new;
  end if;
  if v_settings.deleted_at is not null then
    raise exception 'this group was deleted' using errcode = '42501';
  end if;
  if v_settings.only_admins_send
     and coalesce(public.group_member_role(new.conversation_id, v_sender), '') not in ('admin', 'owner') then
    raise exception 'only admins can send messages in this group' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger messages_group_permissions
  before insert on public.messages
  for each row execute function public.messages_group_permissions();

-- ─────────────────────────────────────────────────────────────────────────────
-- GROUP EVENTS (rendered client-side as system messages)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.group_events (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  actor_id        uuid references public.profiles (id) on delete set null,
  target_id       uuid references public.profiles (id) on delete set null,
  event_type      text not null check (event_type in (
                    'created', 'added', 'joined', 'left', 'removed', 'promoted', 'demoted',
                    'owner_changed', 'renamed', 'description_changed', 'avatar_changed',
                    'settings_changed')),
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index group_events_conversation_idx on public.group_events (conversation_id, created_at);

-- When the caller (re)joined - members only see events from then on.
create or replace function public.member_joined_at(p_conversation_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select joined_at from public.conversation_members
  where conversation_id = p_conversation_id and user_id = auth.uid() and left_at is null;
$$;

alter table public.group_events enable row level security;

create policy "members see group events since they joined"
  on public.group_events for select to authenticated
  using (
    public.is_conversation_member(conversation_id)
    and created_at >= public.member_joined_at(conversation_id)
  );

revoke all on public.group_events from anon;
revoke insert, update, delete, truncate on public.group_events from authenticated;
grant select on public.group_events to authenticated;

create or replace function public.log_group_event(
  p_conversation_id uuid,
  p_event_type text,
  p_target_id uuid default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(current_setting('vero.member_change_reason', true), '');
  v_row    public.group_events;
begin
  if v_reason = 'group_deleted' then
    return;
  end if;
  insert into public.group_events (conversation_id, actor_id, target_id, event_type, details)
  values (
    p_conversation_id,
    (select id from public.profiles where id = auth.uid()),
    p_target_id,
    p_event_type,
    case when v_reason is not null then coalesce(p_details, '{}'::jsonb) || jsonb_build_object('via', v_reason)
         else coalesce(p_details, '{}'::jsonb) end
  )
  returning * into v_row;

  perform realtime.send(to_jsonb(v_row), 'group.event', 'conversation:' || p_conversation_id::text, true);
end;
$$;

create or replace function public.conversation_members_log_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_type  text;
begin
  if not exists (select 1 from public.conversations where id = new.conversation_id and conversation_type = 'group') then
    return null;
  end if;

  if tg_op = 'INSERT' or (old.left_at is not null and new.left_at is null) then
    if tg_op = 'INSERT' and new.role = 'owner' and v_actor is not distinct from new.user_id then
      v_type := 'created';
    elsif v_actor is not distinct from new.user_id then
      v_type := 'joined';
    else
      v_type := 'added';
    end if;
  elsif old.left_at is null and new.left_at is not null then
    v_type := case when v_actor is not distinct from new.user_id then 'left' else 'removed' end;
  elsif old.role is distinct from new.role and new.left_at is null then
    if old.role = 'owner' then
      return null; -- the new owner's 'owner_changed' event covers a transfer
    end if;
    v_type := case
      when new.role = 'owner' then 'owner_changed'
      when new.role = 'admin' then 'promoted'
      else 'demoted'
    end;
  else
    return null;
  end if;

  perform public.log_group_event(new.conversation_id, v_type, new.user_id);
  return null;
end;
$$;

create trigger conversation_members_log_event
  after insert or update on public.conversation_members
  for each row execute function public.conversation_members_log_event();

create or replace function public.conversations_log_rename()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.conversation_type = 'group' and new.group_name is distinct from old.group_name then
    perform public.log_group_event(new.id, 'renamed', null, jsonb_build_object('name', new.group_name));
  end if;
  return null;
end;
$$;

create trigger conversations_log_rename
  after update of group_name on public.conversations
  for each row execute function public.conversations_log_rename();

create or replace function public.group_settings_log_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null then
    return null;
  end if;
  if new.description is distinct from old.description then
    perform public.log_group_event(new.conversation_id, 'description_changed', null, '{}'::jsonb);
  end if;
  if new.avatar_data is distinct from old.avatar_data then
    perform public.log_group_event(new.conversation_id, 'avatar_changed', null,
      jsonb_build_object('removed', new.avatar_data is null));
  end if;
  if (new.only_admins_send, new.only_admins_edit_info, new.join_approval_required)
     is distinct from (old.only_admins_send, old.only_admins_edit_info, old.join_approval_required) then
    perform public.log_group_event(new.conversation_id, 'settings_changed', null, jsonb_build_object(
      'only_admins_send', new.only_admins_send,
      'only_admins_edit_info', new.only_admins_edit_info,
      'join_approval_required', new.join_approval_required));
  end if;
  return null;
end;
$$;

create trigger group_settings_log_change
  after update on public.group_settings
  for each row execute function public.group_settings_log_change();

-- ─────────────────────────────────────────────────────────────────────────────
-- GROUP ADMIN RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- Maximum current members per group (per-device key fan-out cost grows with it).
create or replace function public.group_member_limit()
returns integer
language sql
immutable
set search_path = ''
as $$ select 1024 $$;

-- Internal: add or re-activate a member. Callers do the authorization.
create or replace function public.group_add_member_internal(p_conversation_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_active_group(p_conversation_id) then
    raise exception 'group not found' using errcode = 'P0002';
  end if;
  if public.group_member_role(p_conversation_id, p_user_id) is not null then
    return false;
  end if;
  if public.group_member_count(p_conversation_id) >= public.group_member_limit() then
    raise exception 'this group is full' using errcode = '54000';
  end if;
  insert into public.conversation_members (conversation_id, user_id, role)
  values (p_conversation_id, p_user_id, 'member')
  on conflict (conversation_id, user_id)
  do update set left_at = null, joined_at = now(), role = 'member', last_delivered_at = null, last_read_at = null;
  return true;
end;
$$;

create or replace function public.update_group_info(
  p_conversation_id uuid,
  p_name text default null,
  p_description text default null,
  p_avatar_data text default null,
  p_clear_avatar boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role     text := public.group_member_role(p_conversation_id);
  v_settings public.group_settings;
begin
  if v_role is null or not public.is_active_group(p_conversation_id) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;
  select * into v_settings from public.group_settings where conversation_id = p_conversation_id;
  if v_settings.only_admins_edit_info and v_role not in ('admin', 'owner') then
    raise exception 'only admins can edit group info' using errcode = '42501';
  end if;

  if p_name is not null then
    if char_length(btrim(p_name)) not between 1 and 64 then
      raise exception 'group name must be 1-64 characters' using errcode = '22023';
    end if;
    update public.conversations set group_name = btrim(p_name)
     where id = p_conversation_id and group_name is distinct from btrim(p_name);
  end if;

  if p_avatar_data is not null and not public.is_valid_avatar_data(p_avatar_data) then
    raise exception 'avatar must be a small JPEG, PNG or WebP image' using errcode = '22023';
  end if;

  update public.group_settings
     set description = case when p_description is null then description
                            else nullif(btrim(p_description), '') end,
         avatar_data = case when p_clear_avatar then null
                            when p_avatar_data is not null then p_avatar_data
                            else avatar_data end
   where conversation_id = p_conversation_id
     and (p_description is not null or p_avatar_data is not null or p_clear_avatar);
end;
$$;

create or replace function public.set_group_permissions(
  p_conversation_id uuid,
  p_only_admins_send boolean default null,
  p_only_admins_edit_info boolean default null,
  p_join_approval_required boolean default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_conversation_admin(p_conversation_id) or not public.is_active_group(p_conversation_id) then
    raise exception 'only group admins can change group settings' using errcode = '42501';
  end if;
  update public.group_settings
     set only_admins_send       = coalesce(p_only_admins_send, only_admins_send),
         only_admins_edit_info  = coalesce(p_only_admins_edit_info, only_admins_edit_info),
         join_approval_required = coalesce(p_join_approval_required, join_approval_required)
   where conversation_id = p_conversation_id;
end;
$$;

-- Admins promote members; only the owner demotes admins (admins may step down).
create or replace function public.set_group_member_role(p_conversation_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_mine   text := public.group_member_role(p_conversation_id);
  v_theirs text := public.group_member_role(p_conversation_id, p_user_id);
begin
  if p_role not in ('admin', 'member') then
    raise exception 'role must be admin or member' using errcode = '22023';
  end if;
  if not public.is_active_group(p_conversation_id) then
    raise exception 'group not found' using errcode = 'P0002';
  end if;
  if v_mine is null or v_mine not in ('admin', 'owner') then
    raise exception 'only group admins can change roles' using errcode = '42501';
  end if;
  if v_theirs is null then
    raise exception 'not a member of this group' using errcode = 'P0002';
  end if;
  if v_theirs = 'owner' then
    raise exception 'transfer ownership instead' using errcode = '42501';
  end if;
  if v_theirs = p_role then
    return;
  end if;
  if p_role = 'member' and v_mine <> 'owner' and p_user_id <> v_me then
    raise exception 'only the owner can dismiss admins' using errcode = '42501';
  end if;

  update public.conversation_members set role = p_role
   where conversation_id = p_conversation_id and user_id = p_user_id;

  perform realtime.send(jsonb_build_object('conversation_id', p_conversation_id),
                        'members.changed', 'conversation:' || p_conversation_id::text, true);
end;
$$;

create or replace function public.transfer_group_ownership(p_conversation_id uuid, p_new_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if public.group_member_role(p_conversation_id) is distinct from 'owner'
     or not public.is_active_group(p_conversation_id) then
    raise exception 'only the owner can transfer ownership' using errcode = '42501';
  end if;
  if p_new_owner_id is null or p_new_owner_id = v_me
     or public.group_member_role(p_conversation_id, p_new_owner_id) is null then
    raise exception 'the new owner must be a current member' using errcode = '22023';
  end if;

  update public.conversation_members set role = 'admin'
   where conversation_id = p_conversation_id and user_id = v_me;
  update public.conversation_members set role = 'owner'
   where conversation_id = p_conversation_id and user_id = p_new_owner_id;

  perform realtime.send(jsonb_build_object('conversation_id', p_conversation_id),
                        'members.changed', 'conversation:' || p_conversation_id::text, true);
end;
$$;

-- Leaving as owner hands the group to the longest-serving admin (or member).
create or replace function public.leave_group(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me        uuid := auth.uid();
  v_role      text := public.group_member_role(p_conversation_id);
  v_successor uuid;
begin
  if v_role is null then
    raise exception 'not a member of this group' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.conversations where id = p_conversation_id and conversation_type = 'group') then
    raise exception 'not a group' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.communities c
    join public.community_members m on m.community_id = c.id and m.user_id = v_me and m.role = 'owner'
    where c.announcements_conversation_id = p_conversation_id
  ) then
    raise exception 'the community owner cannot leave its announcements group' using errcode = '42501';
  end if;

  if v_role = 'owner' then
    select user_id into v_successor
    from public.conversation_members
    where conversation_id = p_conversation_id and left_at is null and user_id <> v_me
    order by (role = 'admin') desc, joined_at, user_id
    limit 1;
    if v_successor is not null then
      update public.conversation_members set role = 'owner'
       where conversation_id = p_conversation_id and user_id = v_successor;
    end if;
  end if;

  update public.conversation_members set left_at = now(), role = 'member'
   where conversation_id = p_conversation_id and user_id = v_me;

  update public.group_join_requests set status = 'cancelled', decided_at = now()
   where conversation_id = p_conversation_id and user_id = v_me and status = 'pending';

  perform realtime.send(jsonb_build_object('conversation_id', p_conversation_id),
                        'members.changed', 'conversation:' || p_conversation_id::text, true);
end;
$$;

-- Internal: tombstone a group. Messages and invites are deleted, attachment
-- blobs are queued for cleanup, everyone is removed.
create or replace function public.delete_group_internal(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('vero.member_change_reason', 'group_deleted', true);

  perform realtime.send(jsonb_build_object('conversation_id', p_conversation_id),
                        'group.deleted', 'conversation:' || p_conversation_id::text, true);

  update public.group_settings
     set deleted_at = now(), avatar_data = null, description = null
   where conversation_id = p_conversation_id;
  update public.media set deleted_at = now()
   where conversation_id = p_conversation_id and deleted_at is null;
  delete from public.messages where conversation_id = p_conversation_id;
  delete from public.group_invites where conversation_id = p_conversation_id;
  delete from public.group_join_requests where conversation_id = p_conversation_id;
  delete from public.group_events where conversation_id = p_conversation_id;
  delete from public.community_groups where conversation_id = p_conversation_id;
  update public.conversation_members set left_at = now()
   where conversation_id = p_conversation_id and left_at is null;

  perform set_config('vero.member_change_reason', '', true);
end;
$$;

create or replace function public.delete_group(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.group_member_role(p_conversation_id) is distinct from 'owner'
     or not public.is_active_group(p_conversation_id) then
    raise exception 'only the owner can delete the group' using errcode = '42501';
  end if;
  if exists (select 1 from public.communities where announcements_conversation_id = p_conversation_id) then
    raise exception 'delete the community instead' using errcode = '42501';
  end if;
  perform public.delete_group_internal(p_conversation_id);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- INVITE LINKS & JOIN REQUESTS
-- ─────────────────────────────────────────────────────────────────────────────

create table public.group_invites (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references public.conversations (id) on delete cascade,
  token             text not null unique check (token ~ '^[A-Za-z0-9_-]{22,64}$'),
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz,
  max_uses          integer check (max_uses is null or max_uses between 1 and 100000),
  uses              integer not null default 0 check (uses >= 0),
  requires_approval boolean not null default false,
  revoked_at        timestamptz
);

create index group_invites_conversation_idx on public.group_invites (conversation_id, created_at desc);

alter table public.group_invites enable row level security;

create policy "group admins see invite links"
  on public.group_invites for select to authenticated
  using (public.is_conversation_admin(conversation_id));

revoke all on public.group_invites from anon;
revoke insert, update, delete, truncate on public.group_invites from authenticated;
grant select on public.group_invites to authenticated;

create table public.group_join_requests (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  invite_id       uuid references public.group_invites (id) on delete set null,
  via             text not null default 'invite' check (via in ('invite', 'community')),
  status          text not null default 'pending'
                  check (status in ('pending', 'approved', 'denied', 'cancelled')),
  created_at      timestamptz not null default now(),
  decided_by      uuid references public.profiles (id) on delete set null,
  decided_at      timestamptz
);

create unique index group_join_requests_one_pending_idx
  on public.group_join_requests (conversation_id, user_id) where status = 'pending';
create index group_join_requests_user_idx on public.group_join_requests (user_id);

alter table public.group_join_requests enable row level security;

create policy "requesters and group admins see join requests"
  on public.group_join_requests for select to authenticated
  using (user_id = (select auth.uid()) or public.is_conversation_admin(conversation_id));

revoke all on public.group_join_requests from anon;
revoke insert, update, delete, truncate on public.group_join_requests from authenticated;
grant select on public.group_join_requests to authenticated;

create or replace function public.create_group_invite(
  p_conversation_id uuid,
  p_expires_at timestamptz default null,
  p_max_uses integer default null,
  p_requires_approval boolean default false
)
returns public.group_invites
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.group_invites;
begin
  if not public.is_conversation_admin(p_conversation_id) or not public.is_active_group(p_conversation_id) then
    raise exception 'only group admins can create invite links' using errcode = '42501';
  end if;
  if p_expires_at is not null and (p_expires_at <= now() or p_expires_at > now() + interval '366 days') then
    raise exception 'expiry must be within the next year' using errcode = '22023';
  end if;
  if p_max_uses is not null and p_max_uses not between 1 and 100000 then
    raise exception 'invalid max uses' using errcode = '22023';
  end if;
  if (select count(*) from public.group_invites
      where conversation_id = p_conversation_id and revoked_at is null
        and (expires_at is null or expires_at > now())) >= 25 then
    raise exception 'too many active invite links; revoke one first' using errcode = '54000';
  end if;

  insert into public.group_invites (conversation_id, token, created_by, expires_at, max_uses, requires_approval)
  values (p_conversation_id, public.generate_invite_token(), auth.uid(), p_expires_at, p_max_uses,
          coalesce(p_requires_approval, false))
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.revoke_group_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv uuid;
begin
  select conversation_id into v_conv from public.group_invites where id = p_invite_id;
  if v_conv is null or not public.is_conversation_admin(v_conv) then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  update public.group_invites set revoked_at = coalesce(revoked_at, now()) where id = p_invite_id;
end;
$$;

create or replace function public.list_group_invites(p_conversation_id uuid)
returns setof public.group_invites
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.group_invites
  where conversation_id = p_conversation_id
    and public.is_conversation_admin(p_conversation_id)
  order by created_at desc;
$$;

-- Internal: why an invite can't be used right now (null = usable).
create or replace function public.group_invite_problem(p_invite public.group_invites)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_invite.id is null then 'invalid'
    when not public.is_active_group(p_invite.conversation_id) then 'invalid'
    when p_invite.revoked_at is not null then 'revoked'
    when p_invite.expires_at is not null and p_invite.expires_at <= now() then 'expired'
    when p_invite.max_uses is not null and p_invite.uses >= p_invite.max_uses then 'full'
    else null
  end;
$$;

-- Callable by any signed-in user holding the link. Never raises for a bad
-- token (so failed guesses still count against the rate limit).
create or replace function public.preview_group_invite(p_token text)
returns table (
  status              text,
  conversation_id     uuid,
  group_name          text,
  description         text,
  avatar_data         text,
  member_count        integer,
  requires_approval   boolean,
  is_member           boolean,
  has_pending_request boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv     public.group_invites;
  v_problem text;
  v_conv    public.conversations;
  v_gs      public.group_settings;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not public.consume_rate_limit('invite_preview', 60, interval '10 minutes') then
    return query select 'rate_limited'::text, null::uuid, null::text, null::text, null::text,
                        null::integer, null::boolean, null::boolean, null::boolean;
    return;
  end if;

  select * into v_inv from public.group_invites i where i.token = p_token;
  v_problem := public.group_invite_problem(v_inv);
  if v_problem is not null then
    return query select v_problem, null::uuid, null::text, null::text, null::text,
                        null::integer, null::boolean, null::boolean, null::boolean;
    return;
  end if;

  select * into v_conv from public.conversations c where c.id = v_inv.conversation_id;
  select * into v_gs from public.group_settings g where g.conversation_id = v_inv.conversation_id;

  return query select
    'valid'::text,
    v_conv.id,
    v_conv.group_name,
    v_gs.description,
    v_gs.avatar_data,
    public.group_member_count(v_conv.id),
    (v_inv.requires_approval or v_gs.join_approval_required),
    public.group_member_role(v_conv.id) is not null,
    exists (select 1 from public.group_join_requests r
            where r.conversation_id = v_conv.id and r.user_id = auth.uid() and r.status = 'pending');
end;
$$;

create or replace function public.join_group_via_invite(p_token text)
returns table (status text, conversation_id uuid, request_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me      uuid := auth.uid();
  v_inv     public.group_invites;
  v_problem text;
  v_gs      public.group_settings;
  v_req     uuid;
  v_owner   uuid;
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not public.consume_rate_limit('invite_join', 10, interval '1 hour') then
    return query select 'rate_limited'::text, null::uuid, null::uuid;
    return;
  end if;

  select * into v_inv from public.group_invites i where i.token = p_token for update;
  v_problem := public.group_invite_problem(v_inv);
  if v_problem is not null then
    return query select v_problem, null::uuid, null::uuid;
    return;
  end if;

  if public.group_member_role(v_inv.conversation_id) is not null then
    return query select 'already_member'::text, v_inv.conversation_id, null::uuid;
    return;
  end if;

  -- Don't let a link bypass a block with the group's owner.
  select cm.user_id into v_owner from public.conversation_members cm
   where cm.conversation_id = v_inv.conversation_id and cm.role = 'owner' and cm.left_at is null;
  if v_owner is not null and public.is_blocked_between(v_me, v_owner) then
    return query select 'invalid'::text, null::uuid, null::uuid;
    return;
  end if;

  select * into v_gs from public.group_settings g where g.conversation_id = v_inv.conversation_id;

  if v_inv.requires_approval or v_gs.join_approval_required then
    select r.id into v_req from public.group_join_requests r
     where r.conversation_id = v_inv.conversation_id and r.user_id = v_me and r.status = 'pending';
    if v_req is not null then
      return query select 'already_requested'::text, v_inv.conversation_id, v_req;
      return;
    end if;
    insert into public.group_join_requests (conversation_id, user_id, invite_id, via)
    values (v_inv.conversation_id, v_me, v_inv.id, 'invite')
    returning id into v_req;
    update public.group_invites set uses = uses + 1 where id = v_inv.id;
    perform realtime.send(jsonb_build_object('conversation_id', v_inv.conversation_id, 'request_id', v_req),
                          'join_request.new', 'conversation:' || v_inv.conversation_id::text, true);
    return query select 'requested'::text, v_inv.conversation_id, v_req;
    return;
  end if;

  if public.group_member_count(v_inv.conversation_id) >= public.group_member_limit() then
    return query select 'group_full'::text, null::uuid, null::uuid;
    return;
  end if;

  perform set_config('vero.member_change_reason', 'invite', true);
  perform public.group_add_member_internal(v_inv.conversation_id, v_me);
  perform set_config('vero.member_change_reason', '', true);
  update public.group_invites set uses = uses + 1 where id = v_inv.id;

  perform realtime.send(jsonb_build_object('conversation_id', v_inv.conversation_id),
                        'members.changed', 'conversation:' || v_inv.conversation_id::text, true);
  return query select 'joined'::text, v_inv.conversation_id, null::uuid;
end;
$$;

create or replace function public.decide_group_join_request(p_request_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.group_join_requests;
begin
  select * into v_req from public.group_join_requests where id = p_request_id for update;
  if v_req.id is null or not public.is_conversation_admin(v_req.conversation_id) then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'request was already handled' using errcode = '22023';
  end if;

  if p_approve then
    perform set_config('vero.member_change_reason', 'request', true);
    perform public.group_add_member_internal(v_req.conversation_id, v_req.user_id);
    perform set_config('vero.member_change_reason', '', true);
    perform realtime.send(jsonb_build_object('conversation_id', v_req.conversation_id),
                          'members.changed', 'conversation:' || v_req.conversation_id::text, true);
  end if;

  update public.group_join_requests
     set status = case when p_approve then 'approved' else 'denied' end,
         decided_by = auth.uid(),
         decided_at = now()
   where id = p_request_id;
end;
$$;

create or replace function public.approve_group_join_request(p_request_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$ select public.decide_group_join_request(p_request_id, true) $$;

create or replace function public.deny_group_join_request(p_request_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$ select public.decide_group_join_request(p_request_id, false) $$;

create or replace function public.cancel_group_join_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.group_join_requests set status = 'cancelled', decided_at = now()
   where id = p_request_id and user_id = auth.uid() and status = 'pending';
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CHANNELS (broadcast; NOT end-to-end encrypted - labelled in the UI)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.channels (
  id             uuid primary key default gen_random_uuid(),
  handle         text not null unique check (handle ~ '^[a-z0-9_]{3,32}$'),
  name           text not null check (char_length(btrim(name)) between 1 and 64),
  description    text check (description is null or char_length(description) <= 1024),
  avatar_data    text check (public.is_valid_avatar_data(avatar_data)),
  visibility     text not null default 'public' check (visibility in ('public', 'private')),
  -- Private channels are followed via this token (admins only can read it).
  invite_token   text unique check (invite_token is null or invite_token ~ '^[A-Za-z0-9_-]{22,64}$'),
  follower_count integer not null default 0 check (follower_count >= 0),
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index channels_public_popular_idx on public.channels (follower_count desc) where visibility = 'public';

create trigger channels_updated_at
  before update on public.channels
  for each row execute function public.set_updated_at();

create table public.channel_admins (
  channel_id uuid not null references public.channels (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null default 'admin' check (role in ('owner', 'admin')),
  added_at   timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create unique index channel_admins_one_owner_idx on public.channel_admins (channel_id) where role = 'owner';
create index channel_admins_user_idx on public.channel_admins (user_id);

create table public.channel_followers (
  channel_id  uuid not null references public.channels (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  followed_at timestamptz not null default now(),
  muted       boolean not null default false,
  primary key (channel_id, user_id)
);

create index channel_followers_user_idx on public.channel_followers (user_id);

create table public.channel_posts (
  id              uuid primary key default gen_random_uuid(),
  channel_id      uuid not null references public.channels (id) on delete cascade,
  author_id       uuid default auth.uid() references public.profiles (id) on delete set null,
  body            text check (body is null or char_length(body) <= 4096),
  -- Object path in the `vero-channel-media` bucket: <channel_id>/<file>
  media_path      text check (media_path is null or media_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,128}$'),
  media_mime      text check (media_mime is null or media_mime in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  reaction_counts jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  check (char_length(btrim(coalesce(body, ''))) > 0 or media_path is not null),
  check ((media_path is null) = (media_mime is null))
);

create index channel_posts_channel_created_idx on public.channel_posts (channel_id, created_at desc);

create table public.channel_post_reactions (
  post_id    uuid not null references public.channel_posts (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create or replace function public.is_channel_admin(p_channel_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.channel_admins where channel_id = p_channel_id and user_id = p_user_id);
$$;

create or replace function public.is_channel_owner(p_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.channel_admins
                 where channel_id = p_channel_id and user_id = auth.uid() and role = 'owner');
$$;

create or replace function public.is_channel_follower(p_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.channel_followers where channel_id = p_channel_id and user_id = auth.uid());
$$;

-- Public channels are readable by every signed-in user; private ones only by
-- followers and admins.
create or replace function public.can_read_channel(p_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.channels c
    where c.id = p_channel_id
      and (c.visibility = 'public' or public.is_channel_follower(c.id) or public.is_channel_admin(c.id))
  );
$$;

alter table public.channels enable row level security;
alter table public.channel_admins enable row level security;
alter table public.channel_followers enable row level security;
alter table public.channel_posts enable row level security;
alter table public.channel_post_reactions enable row level security;

create policy "readable channels are visible"
  on public.channels for select to authenticated
  using (public.can_read_channel(id));

create policy "channel admins see the admin list"
  on public.channel_admins for select to authenticated
  using (public.is_channel_admin(channel_id));

create policy "followers see their own follow rows"
  on public.channel_followers for select to authenticated
  using (user_id = (select auth.uid()));

create policy "followers mute or unmute"
  on public.channel_followers for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "followers unfollow"
  on public.channel_followers for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "readers see channel posts"
  on public.channel_posts for select to authenticated
  using (public.can_read_channel(channel_id));

create policy "channel admins post"
  on public.channel_posts for insert to authenticated
  with check (public.is_channel_admin(channel_id) and author_id = (select auth.uid()));

create policy "channel admins edit posts"
  on public.channel_posts for update to authenticated
  using (public.is_channel_admin(channel_id))
  with check (public.is_channel_admin(channel_id));

create policy "channel admins delete posts"
  on public.channel_posts for delete to authenticated
  using (public.is_channel_admin(channel_id));

create policy "users see their own reactions"
  on public.channel_post_reactions for select to authenticated
  using (user_id = (select auth.uid()));

-- Column privileges: the invite token and post authors stay hidden.
revoke all on public.channels, public.channel_admins, public.channel_followers,
              public.channel_posts, public.channel_post_reactions from anon;
revoke all on public.channels, public.channel_admins, public.channel_followers,
              public.channel_posts, public.channel_post_reactions from authenticated;
grant select (id, handle, name, description, avatar_data, visibility, follower_count, created_at, updated_at)
  on public.channels to authenticated;
grant select on public.channel_admins to authenticated;
grant select, delete on public.channel_followers to authenticated;
grant update (muted) on public.channel_followers to authenticated;
grant select (id, channel_id, body, media_path, media_mime, reaction_counts, created_at, edited_at)
  on public.channel_posts to authenticated;
grant insert (channel_id, body, media_path, media_mime) on public.channel_posts to authenticated;
grant update (body) on public.channel_posts to authenticated;
grant delete on public.channel_posts to authenticated;
grant select on public.channel_post_reactions to authenticated;

-- Normalise new posts: server-chosen author/time; media must live in the
-- channel's own folder.
create or replace function public.channel_posts_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.author_id       := auth.uid();
    new.created_at      := now();
    new.edited_at       := null;
    new.reaction_counts := '{}'::jsonb;
    if new.media_path is not null and split_part(new.media_path, '/', 1) <> new.channel_id::text then
      raise exception 'media must be uploaded to this channel''s folder' using errcode = '22023';
    end if;
  else
    if new.body is distinct from old.body then
      new.edited_at := now();
    end if;
  end if;
  return new;
end;
$$;

create trigger channel_posts_before_write
  before insert or update on public.channel_posts
  for each row execute function public.channel_posts_before_write();

create or replace function public.channel_post_json(p public.channel_posts)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'channel_id', p.channel_id, 'body', p.body, 'media_path', p.media_path,
    'media_mime', p.media_mime, 'reaction_counts', p.reaction_counts,
    'created_at', p.created_at, 'edited_at', p.edited_at);
$$;

create or replace function public.channel_posts_broadcast()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform realtime.send(public.channel_post_json(new), 'post.new', 'channel:' || new.channel_id::text, true);
  elsif tg_op = 'UPDATE' then
    if new.reaction_counts is distinct from old.reaction_counts and new.body is not distinct from old.body then
      perform realtime.send(jsonb_build_object('id', new.id, 'reaction_counts', new.reaction_counts),
                            'post.reactions', 'channel:' || new.channel_id::text, true);
    else
      perform realtime.send(public.channel_post_json(new), 'post.updated', 'channel:' || new.channel_id::text, true);
    end if;
  else
    perform realtime.send(jsonb_build_object('id', old.id), 'post.deleted', 'channel:' || old.channel_id::text, true);
  end if;
  return null;
end;
$$;

create trigger channel_posts_broadcast
  after insert or update or delete on public.channel_posts
  for each row execute function public.channel_posts_broadcast();

create or replace function public.channel_followers_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.channels set follower_count = follower_count + 1 where id = new.channel_id;
  else
    update public.channels set follower_count = greatest(follower_count - 1, 0) where id = old.channel_id;
  end if;
  return null;
end;
$$;

create trigger channel_followers_count
  after insert or delete on public.channel_followers
  for each row execute function public.channel_followers_count();

create or replace function public.channel_reactions_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update public.channel_posts p
       set reaction_counts = case
             when coalesce((p.reaction_counts ->> old.emoji)::integer, 0) <= 1 then p.reaction_counts - old.emoji
             else jsonb_set(p.reaction_counts, array[old.emoji], to_jsonb((p.reaction_counts ->> old.emoji)::integer - 1))
           end
     where p.id = old.post_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    update public.channel_posts p
       set reaction_counts = jsonb_set(p.reaction_counts, array[new.emoji],
                                       to_jsonb(coalesce((p.reaction_counts ->> new.emoji)::integer, 0) + 1))
     where p.id = new.post_id;
  end if;
  return null;
end;
$$;

create trigger channel_reactions_count
  after insert or update or delete on public.channel_post_reactions
  for each row execute function public.channel_reactions_count();

-- ── Channel RPCs ─────────────────────────────────────────────────────────────

create or replace function public.channel_handle_available(p_handle text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select lower(btrim(p_handle)) ~ '^[a-z0-9_]{3,32}$'
     and not exists (select 1 from public.channels where handle = lower(btrim(p_handle)));
$$;

create or replace function public.create_channel(
  p_name text,
  p_handle text,
  p_description text default null,
  p_visibility text default 'public'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_handle text := lower(btrim(coalesce(p_handle, '')));
  v_id     uuid;
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_visibility not in ('public', 'private') then
    raise exception 'visibility must be public or private' using errcode = '22023';
  end if;
  if v_handle !~ '^[a-z0-9_]{3,32}$' then
    raise exception 'handle must be 3-32 lowercase letters, digits or _' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 64 then
    raise exception 'channel name must be 1-64 characters' using errcode = '22023';
  end if;
  if exists (select 1 from public.channels where handle = v_handle) then
    raise exception 'that handle is taken' using errcode = '23505';
  end if;
  if not public.consume_rate_limit('channel_create', 10, interval '1 day') then
    raise exception 'too many channels created today' using errcode = '54000';
  end if;

  insert into public.channels (handle, name, description, visibility, invite_token, created_by)
  values (v_handle, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), p_visibility,
          case when p_visibility = 'private' then public.generate_invite_token() end, v_me)
  returning id into v_id;

  insert into public.channel_admins (channel_id, user_id, role) values (v_id, v_me, 'owner');
  return v_id;
end;
$$;

create or replace function public.update_channel(
  p_channel_id uuid,
  p_name text default null,
  p_description text default null,
  p_avatar_data text default null,
  p_clear_avatar boolean default false,
  p_visibility text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_channel_admin(p_channel_id) then
    raise exception 'only channel admins can edit the channel' using errcode = '42501';
  end if;
  if p_name is not null and char_length(btrim(p_name)) not between 1 and 64 then
    raise exception 'channel name must be 1-64 characters' using errcode = '22023';
  end if;
  if p_visibility is not null and p_visibility not in ('public', 'private') then
    raise exception 'visibility must be public or private' using errcode = '22023';
  end if;
  if p_avatar_data is not null and not public.is_valid_avatar_data(p_avatar_data) then
    raise exception 'avatar must be a small JPEG, PNG or WebP image' using errcode = '22023';
  end if;

  update public.channels
     set name         = coalesce(btrim(p_name), name),
         description  = case when p_description is null then description
                             else nullif(btrim(p_description), '') end,
         avatar_data  = case when p_clear_avatar then null
                             when p_avatar_data is not null then p_avatar_data
                             else avatar_data end,
         visibility   = coalesce(p_visibility, visibility),
         invite_token = case when coalesce(p_visibility, visibility) = 'private'
                             then coalesce(invite_token, public.generate_invite_token())
                             else invite_token end
   where id = p_channel_id;

  perform realtime.send(jsonb_build_object('channel_id', p_channel_id), 'channel.updated',
                        'channel:' || p_channel_id::text, true);
end;
$$;

create or replace function public.get_channel_invite_token(p_channel_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if not public.is_channel_admin(p_channel_id) then
    raise exception 'only channel admins can see the invite link' using errcode = '42501';
  end if;
  select invite_token into v_token from public.channels where id = p_channel_id;
  return v_token;
end;
$$;

create or replace function public.rotate_channel_invite(p_channel_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if not public.is_channel_admin(p_channel_id) then
    raise exception 'only channel admins can reset the invite link' using errcode = '42501';
  end if;
  update public.channels set invite_token = public.generate_invite_token()
   where id = p_channel_id
  returning invite_token into v_token;
  return v_token;
end;
$$;

create or replace function public.delete_channel(p_channel_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_channel_owner(p_channel_id) then
    raise exception 'only the owner can delete the channel' using errcode = '42501';
  end if;
  perform realtime.send(jsonb_build_object('channel_id', p_channel_id), 'channel.deleted',
                        'channel:' || p_channel_id::text, true);
  delete from public.channels where id = p_channel_id;
end;
$$;

create or replace function public.add_channel_admin(p_channel_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_channel_owner(p_channel_id) then
    raise exception 'only the owner can add admins' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id)
     or public.is_blocked_between(auth.uid(), p_user_id) then
    raise exception 'invalid user' using errcode = '22023';
  end if;
  if (select count(*) from public.channel_admins where channel_id = p_channel_id) >= 16 then
    raise exception 'a channel can have at most 16 admins' using errcode = '54000';
  end if;
  insert into public.channel_admins (channel_id, user_id, role)
  values (p_channel_id, p_user_id, 'admin')
  on conflict do nothing;
end;
$$;

-- The owner removes admins; an admin may step down.
create or replace function public.remove_channel_admin(p_channel_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_channel_owner(p_channel_id)
     and not (p_user_id = auth.uid() and public.is_channel_admin(p_channel_id)) then
    raise exception 'only the owner can remove admins' using errcode = '42501';
  end if;
  delete from public.channel_admins
   where channel_id = p_channel_id and user_id = p_user_id and role = 'admin';
end;
$$;

create or replace function public.follow_channel(p_channel_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (select 1 from public.channels where id = p_channel_id and visibility = 'public') then
    raise exception 'channel not found' using errcode = 'P0002';
  end if;
  insert into public.channel_followers (channel_id, user_id) values (p_channel_id, auth.uid())
  on conflict do nothing;
end;
$$;

create or replace function public.preview_channel_invite(p_token text)
returns table (
  status         text,
  channel_id     uuid,
  name           text,
  handle         text,
  description    text,
  avatar_data    text,
  follower_count integer,
  is_following   boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ch public.channels;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not public.consume_rate_limit('invite_preview', 60, interval '10 minutes') then
    return query select 'rate_limited'::text, null::uuid, null::text, null::text, null::text,
                        null::text, null::integer, null::boolean;
    return;
  end if;
  select * into v_ch from public.channels c where c.invite_token = p_token;
  if v_ch.id is null then
    return query select 'invalid'::text, null::uuid, null::text, null::text, null::text,
                        null::text, null::integer, null::boolean;
    return;
  end if;
  return query select 'valid'::text, v_ch.id, v_ch.name, v_ch.handle, v_ch.description, v_ch.avatar_data,
                      v_ch.follower_count, public.is_channel_follower(v_ch.id);
end;
$$;

create or replace function public.follow_channel_via_invite(p_token text)
returns table (status text, channel_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not public.consume_rate_limit('invite_join', 10, interval '1 hour') then
    return query select 'rate_limited'::text, null::uuid;
    return;
  end if;
  select c.id into v_id from public.channels c where c.invite_token = p_token;
  if v_id is null then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  insert into public.channel_followers (channel_id, user_id) values (v_id, auth.uid())
  on conflict do nothing;
  return query select 'following'::text, v_id;
end;
$$;

create or replace function public.unfollow_channel(p_channel_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.channel_followers where channel_id = p_channel_id and user_id = auth.uid();
$$;

create or replace function public.set_channel_muted(p_channel_id uuid, p_muted boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.channel_followers set muted = coalesce(p_muted, false)
   where channel_id = p_channel_id and user_id = auth.uid();
  if not found then
    raise exception 'you are not following this channel' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.react_to_channel_post(p_post_id uuid, p_emoji text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel uuid;
begin
  select channel_id into v_channel from public.channel_posts where id = p_post_id;
  if v_channel is null or not public.can_read_channel(v_channel) then
    raise exception 'post not found' using errcode = 'P0002';
  end if;
  if p_emoji is null or btrim(p_emoji) = '' then
    delete from public.channel_post_reactions where post_id = p_post_id and user_id = auth.uid();
    return;
  end if;
  if char_length(p_emoji) > 16 then
    raise exception 'invalid reaction' using errcode = '22023';
  end if;
  insert into public.channel_post_reactions (post_id, user_id, emoji)
  values (p_post_id, auth.uid(), p_emoji)
  on conflict (post_id, user_id) do update set emoji = excluded.emoji, created_at = now()
  where public.channel_post_reactions.emoji is distinct from excluded.emoji;
end;
$$;

-- Channel card with the caller's relationship to it.
create or replace function public.get_channel_details(p_channel_id uuid)
returns table (
  id             uuid,
  handle         text,
  name           text,
  description    text,
  avatar_data    text,
  visibility     text,
  follower_count integer,
  my_role        text,
  is_following   boolean,
  muted          boolean,
  last_post_at   timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.handle, c.name, c.description, c.avatar_data, c.visibility, c.follower_count,
         (select a.role from public.channel_admins a where a.channel_id = c.id and a.user_id = auth.uid()),
         f.user_id is not null,
         coalesce(f.muted, false),
         (select max(p.created_at) from public.channel_posts p where p.channel_id = c.id)
  from public.channels c
  left join public.channel_followers f on f.channel_id = c.id and f.user_id = auth.uid()
  where c.id = p_channel_id and public.can_read_channel(c.id);
$$;

-- Channels the caller follows or runs.
create or replace function public.my_channels()
returns table (
  id             uuid,
  handle         text,
  name           text,
  description    text,
  avatar_data    text,
  visibility     text,
  follower_count integer,
  my_role        text,
  is_following   boolean,
  muted          boolean,
  last_post_at   timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.handle, c.name, c.description, c.avatar_data, c.visibility, c.follower_count,
         a.role, f.user_id is not null, coalesce(f.muted, false),
         (select max(p.created_at) from public.channel_posts p where p.channel_id = c.id) as last_post_at
  from public.channels c
  left join public.channel_followers f on f.channel_id = c.id and f.user_id = auth.uid()
  left join public.channel_admins a on a.channel_id = c.id and a.user_id = auth.uid()
  where auth.uid() is not null and (f.user_id is not null or a.user_id is not null)
  order by last_post_at desc nulls last, c.name;
$$;

-- Public directory: search by handle/name, or most-followed when the query is empty.
create or replace function public.search_channels(p_query text default '', p_limit integer default 30)
returns table (
  id             uuid,
  handle         text,
  name           text,
  description    text,
  avatar_data    text,
  follower_count integer,
  is_following   boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with q as (
    select replace(replace(replace(lower(btrim(coalesce(p_query, ''))), '\', '\\'), '%', '\%'), '_', '\_') as term
  )
  select c.id, c.handle, c.name, c.description, c.avatar_data, c.follower_count,
         public.is_channel_follower(c.id)
  from public.channels c, q
  where auth.uid() is not null
    and c.visibility = 'public'
    and (q.term = '' or c.handle like q.term || '%' or lower(c.name) like '%' || q.term || '%')
  order by (c.handle = lower(btrim(coalesce(p_query, '')))) desc, c.follower_count desc, c.name
  limit least(greatest(coalesce(p_limit, 30), 1), 50);
$$;

-- ── Realtime: channel:<id> (readers receive, admins send) ────────────────────

create or replace function public.can_use_channel_topic(p_topic text, p_write boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind text := split_part(p_topic, ':', 1);
  v_id   text := split_part(p_topic, ':', 2);
begin
  if v_kind <> 'channel' or v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if p_write then
    return public.is_channel_admin(v_id::uuid);
  end if;
  return public.can_read_channel(v_id::uuid);
end;
$$;

create policy "vero channel readers receive realtime"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and public.can_use_channel_topic((select realtime.topic()), false)
  );

create policy "vero channel admins send realtime"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and public.can_use_channel_topic((select realtime.topic()), true)
  );

-- ── Storage for channel images (server-readable, like the posts) ─────────────

create or replace function public.channel_id_from_object_path(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case when split_part(p_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 1)::uuid end;
$$;

do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'objects') then
    if exists (select 1 from information_schema.columns
               where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types') then
      insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('vero-channel-media', 'vero-channel-media', false, 10485760,
              array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
      on conflict (id) do nothing;
    else
      insert into storage.buckets (id, name, public)
      values ('vero-channel-media', 'vero-channel-media', false)
      on conflict (id) do nothing;
    end if;

    execute $p$
      create policy "vero channel media readable by channel readers"
        on storage.objects for select to authenticated
        using (bucket_id = 'vero-channel-media'
               and public.can_read_channel(public.channel_id_from_object_path(name)))
    $p$;
    execute $p$
      create policy "vero channel media uploaded by channel admins"
        on storage.objects for insert to authenticated
        with check (bucket_id = 'vero-channel-media'
                    and public.is_channel_admin(public.channel_id_from_object_path(name)))
    $p$;
    execute $p$
      create policy "vero channel media deleted by channel admins"
        on storage.objects for delete to authenticated
        using (bucket_id = 'vero-channel-media'
               and public.is_channel_admin(public.channel_id_from_object_path(name)))
    $p$;
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- COMMUNITIES
-- ─────────────────────────────────────────────────────────────────────────────

create table public.communities (
  id                             uuid primary key default gen_random_uuid(),
  name                           text not null check (char_length(btrim(name)) between 1 and 48),
  description                    text check (description is null or char_length(description) <= 1024),
  avatar_data                    text check (public.is_valid_avatar_data(avatar_data)),
  announcements_conversation_id  uuid unique references public.conversations (id) on delete set null,
  created_by                     uuid references public.profiles (id) on delete set null,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now()
);

create trigger communities_updated_at
  before update on public.communities
  for each row execute function public.set_updated_at();

create table public.community_members (
  community_id uuid not null references public.communities (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at    timestamptz not null default now(),
  primary key (community_id, user_id)
);

create index community_members_user_idx on public.community_members (user_id);

create table public.community_groups (
  community_id     uuid not null references public.communities (id) on delete cascade,
  -- A group belongs to at most one community.
  conversation_id  uuid not null unique references public.conversations (id) on delete cascade,
  is_announcements boolean not null default false,
  added_by         uuid references public.profiles (id) on delete set null,
  added_at         timestamptz not null default now(),
  primary key (community_id, conversation_id)
);

create or replace function public.community_role(p_community_id uuid, p_user_id uuid default auth.uid())
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.community_members where community_id = p_community_id and user_id = p_user_id;
$$;

create or replace function public.is_community_member(p_community_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.community_role(p_community_id) is not null;
$$;

create or replace function public.is_community_admin(p_community_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.community_role(p_community_id) in ('owner', 'admin'), false);
$$;

alter table public.communities enable row level security;
alter table public.community_members enable row level security;
alter table public.community_groups enable row level security;

create policy "members see their communities"
  on public.communities for select to authenticated
  using (public.is_community_member(id));

-- Members don't see each other (like WhatsApp communities); admins see everyone.
create policy "own membership or admins see community members"
  on public.community_members for select to authenticated
  using (user_id = (select auth.uid()) or public.is_community_admin(community_id));

create policy "members see community groups"
  on public.community_groups for select to authenticated
  using (public.is_community_member(community_id));

revoke all on public.communities, public.community_members, public.community_groups from anon;
revoke insert, update, delete, truncate on public.communities, public.community_members, public.community_groups
  from authenticated;
grant select on public.communities, public.community_members, public.community_groups to authenticated;

-- Membership sync: joining any linked group makes you a community member and
-- puts you in the announcements group; leaving announcements leaves the community.
create or replace function public.conversation_members_sync_community()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link record;
  v_ann  uuid;
begin
  if coalesce(current_setting('vero.member_change_reason', true), '') = 'group_deleted' then
    return null;
  end if;

  for v_link in
    select cg.community_id, cg.is_announcements from public.community_groups cg
    where cg.conversation_id = new.conversation_id
  loop
    if new.left_at is null and (tg_op = 'INSERT' or old.left_at is not null) then
      insert into public.community_members (community_id, user_id, role)
      values (v_link.community_id, new.user_id, 'member')
      on conflict do nothing;
      if not v_link.is_announcements then
        select announcements_conversation_id into v_ann from public.communities where id = v_link.community_id;
        if v_ann is not null and public.group_member_role(v_ann, new.user_id) is null
           and public.is_active_group(v_ann) then
          insert into public.conversation_members (conversation_id, user_id, role)
          values (v_ann, new.user_id, 'member')
          on conflict (conversation_id, user_id)
          do update set left_at = null, joined_at = now(), role = 'member',
                        last_delivered_at = null, last_read_at = null;
        end if;
      end if;
    elsif tg_op = 'UPDATE' and old.left_at is null and new.left_at is not null and v_link.is_announcements then
      delete from public.community_members
       where community_id = v_link.community_id and user_id = new.user_id and role <> 'owner';
    end if;
  end loop;
  return null;
end;
$$;

create trigger conversation_members_sync_community
  after insert or update of left_at on public.conversation_members
  for each row execute function public.conversation_members_sync_community();

-- Internal: create a group with the caller as owner and no other members.
create or replace function public.create_group_internal(p_name text, p_description text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv uuid;
begin
  if p_name is null or char_length(btrim(p_name)) not between 1 and 64 then
    raise exception 'group name must be 1-64 characters' using errcode = '22023';
  end if;
  insert into public.conversations (conversation_type, group_name, created_by)
  values ('group', btrim(p_name), auth.uid())
  returning id into v_conv;
  insert into public.conversation_members (conversation_id, user_id, role) values (v_conv, auth.uid(), 'owner');
  if p_description is not null then
    update public.group_settings set description = nullif(btrim(p_description), '') where conversation_id = v_conv;
  end if;
  return v_conv;
end;
$$;

create or replace function public.create_community(p_name text, p_description text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me        uuid := auth.uid();
  v_community uuid;
  v_ann       uuid;
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 48 then
    raise exception 'community name must be 1-48 characters' using errcode = '22023';
  end if;
  if not public.consume_rate_limit('community_create', 5, interval '1 day') then
    raise exception 'too many communities created today' using errcode = '54000';
  end if;

  insert into public.communities (name, description, created_by)
  values (btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), v_me)
  returning id into v_community;
  insert into public.community_members (community_id, user_id, role) values (v_community, v_me, 'owner');

  -- Announcements: a normal E2EE group where only admins can post.
  v_ann := public.create_group_internal(btrim(p_name) || ' · Announcements');
  update public.group_settings
     set only_admins_send = true, only_admins_edit_info = true
   where conversation_id = v_ann;
  update public.communities set announcements_conversation_id = v_ann where id = v_community;
  insert into public.community_groups (community_id, conversation_id, is_announcements, added_by)
  values (v_community, v_ann, true, v_me);
  return v_community;
end;
$$;

create or replace function public.update_community(
  p_community_id uuid,
  p_name text default null,
  p_description text default null,
  p_avatar_data text default null,
  p_clear_avatar boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_community_admin(p_community_id) then
    raise exception 'only community admins can edit the community' using errcode = '42501';
  end if;
  if p_name is not null and char_length(btrim(p_name)) not between 1 and 48 then
    raise exception 'community name must be 1-48 characters' using errcode = '22023';
  end if;
  if p_avatar_data is not null and not public.is_valid_avatar_data(p_avatar_data) then
    raise exception 'avatar must be a small JPEG, PNG or WebP image' using errcode = '22023';
  end if;
  update public.communities
     set name        = coalesce(btrim(p_name), name),
         description = case when p_description is null then description
                            else nullif(btrim(p_description), '') end,
         avatar_data = case when p_clear_avatar then null
                            when p_avatar_data is not null then p_avatar_data
                            else avatar_data end
   where id = p_community_id;
end;
$$;

create or replace function public.delete_community(p_community_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ann uuid;
begin
  if public.community_role(p_community_id) is distinct from 'owner' then
    raise exception 'only the owner can delete the community' using errcode = '42501';
  end if;
  select announcements_conversation_id into v_ann from public.communities where id = p_community_id;
  -- Linked groups keep existing on their own; announcements go away.
  delete from public.communities where id = p_community_id;
  if v_ann is not null and public.is_active_group(v_ann) then
    perform public.delete_group_internal(v_ann);
  end if;
end;
$$;

create or replace function public.link_group_to_community(p_community_id uuid, p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ann uuid;
begin
  if not public.is_community_admin(p_community_id) then
    raise exception 'only community admins can add groups' using errcode = '42501';
  end if;
  if not public.is_conversation_admin(p_conversation_id) or not public.is_active_group(p_conversation_id) then
    raise exception 'you must be an admin of the group' using errcode = '42501';
  end if;
  if exists (select 1 from public.community_groups where conversation_id = p_conversation_id) then
    raise exception 'this group already belongs to a community' using errcode = '23505';
  end if;
  if (select count(*) from public.community_groups where community_id = p_community_id) >= 101 then
    raise exception 'a community can have at most 100 groups' using errcode = '54000';
  end if;

  insert into public.community_groups (community_id, conversation_id, added_by)
  values (p_community_id, p_conversation_id, auth.uid());

  -- Existing members join the community and its announcements group.
  insert into public.community_members (community_id, user_id, role)
  select p_community_id, cm.user_id, 'member'
  from public.conversation_members cm
  where cm.conversation_id = p_conversation_id and cm.left_at is null
  on conflict do nothing;

  select announcements_conversation_id into v_ann from public.communities where id = p_community_id;
  if v_ann is not null and public.is_active_group(v_ann) then
    perform set_config('vero.member_change_reason', 'community', true);
    insert into public.conversation_members (conversation_id, user_id, role)
    select v_ann, cm.user_id, 'member'
    from public.conversation_members cm
    where cm.conversation_id = p_conversation_id and cm.left_at is null
      and public.group_member_role(v_ann, cm.user_id) is null
    on conflict (conversation_id, user_id)
    do update set left_at = null, joined_at = now(), role = 'member', last_delivered_at = null, last_read_at = null;
    perform set_config('vero.member_change_reason', '', true);
    perform realtime.send(jsonb_build_object('conversation_id', v_ann),
                          'members.changed', 'conversation:' || v_ann::text, true);
  end if;
end;
$$;

create or replace function public.unlink_group_from_community(p_community_id uuid, p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_community_admin(p_community_id) and not public.is_conversation_admin(p_conversation_id) then
    raise exception 'only community or group admins can remove a group' using errcode = '42501';
  end if;
  delete from public.community_groups
   where community_id = p_community_id and conversation_id = p_conversation_id and not is_announcements;
  if not found then
    raise exception 'group is not linked to this community' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.create_community_group(
  p_community_id uuid,
  p_name text,
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv uuid;
begin
  if not public.is_community_admin(p_community_id) then
    raise exception 'only community admins can create groups' using errcode = '42501';
  end if;
  v_conv := public.create_group_internal(p_name, p_description);
  perform public.link_group_to_community(p_community_id, v_conv);
  return v_conv;
end;
$$;

create or replace function public.get_community_details(p_community_id uuid)
returns table (
  id                            uuid,
  name                          text,
  description                   text,
  avatar_data                   text,
  announcements_conversation_id uuid,
  member_count                  integer,
  group_count                   integer,
  my_role                       text
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.name, c.description, c.avatar_data, c.announcements_conversation_id,
         (select count(*)::integer from public.community_members m where m.community_id = c.id),
         (select count(*)::integer from public.community_groups g where g.community_id = c.id and not g.is_announcements),
         public.community_role(c.id)
  from public.communities c
  where c.id = p_community_id and public.is_community_member(c.id);
$$;

create or replace function public.my_communities()
returns table (
  id                            uuid,
  name                          text,
  description                   text,
  avatar_data                   text,
  announcements_conversation_id uuid,
  member_count                  integer,
  group_count                   integer,
  my_role                       text
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.name, c.description, c.avatar_data, c.announcements_conversation_id,
         (select count(*)::integer from public.community_members m where m.community_id = c.id),
         (select count(*)::integer from public.community_groups g where g.community_id = c.id and not g.is_announcements),
         me.role
  from public.communities c
  join public.community_members me on me.community_id = c.id and me.user_id = auth.uid()
  order by c.name;
$$;

-- Groups in a community, as a community member sees them (names are visible
-- to community members even before they join a group).
create or replace function public.get_community_groups(p_community_id uuid)
returns table (
  conversation_id        uuid,
  group_name             text,
  description            text,
  avatar_data            text,
  member_count           integer,
  is_announcements       boolean,
  is_member              boolean,
  join_approval_required boolean,
  has_pending_request    boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select cg.conversation_id, c.group_name, gs.description, gs.avatar_data,
         public.group_member_count(cg.conversation_id), cg.is_announcements,
         public.group_member_role(cg.conversation_id) is not null,
         gs.join_approval_required,
         exists (select 1 from public.group_join_requests r
                 where r.conversation_id = cg.conversation_id and r.user_id = auth.uid() and r.status = 'pending')
  from public.community_groups cg
  join public.conversations c on c.id = cg.conversation_id
  join public.group_settings gs on gs.conversation_id = cg.conversation_id and gs.deleted_at is null
  where cg.community_id = p_community_id and public.is_community_member(p_community_id)
  order by cg.is_announcements desc, c.group_name;
$$;

create or replace function public.join_community_group(p_community_id uuid, p_conversation_id uuid)
returns table (status text, request_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me  uuid := auth.uid();
  v_gs  public.group_settings;
  v_req uuid;
begin
  if not public.is_community_member(p_community_id) then
    raise exception 'join the community first' using errcode = '42501';
  end if;
  if not exists (select 1 from public.community_groups
                 where community_id = p_community_id and conversation_id = p_conversation_id) then
    raise exception 'group is not part of this community' using errcode = 'P0002';
  end if;
  if public.group_member_role(p_conversation_id) is not null then
    return query select 'already_member'::text, null::uuid;
    return;
  end if;
  select * into v_gs from public.group_settings where conversation_id = p_conversation_id;
  if v_gs.deleted_at is not null then
    raise exception 'group not found' using errcode = 'P0002';
  end if;

  if v_gs.join_approval_required then
    select r.id into v_req from public.group_join_requests r
     where r.conversation_id = p_conversation_id and r.user_id = v_me and r.status = 'pending';
    if v_req is not null then
      return query select 'already_requested'::text, v_req;
      return;
    end if;
    insert into public.group_join_requests (conversation_id, user_id, via)
    values (p_conversation_id, v_me, 'community')
    returning id into v_req;
    perform realtime.send(jsonb_build_object('conversation_id', p_conversation_id, 'request_id', v_req),
                          'join_request.new', 'conversation:' || p_conversation_id::text, true);
    return query select 'requested'::text, v_req;
    return;
  end if;

  perform set_config('vero.member_change_reason', 'community', true);
  perform public.group_add_member_internal(p_conversation_id, v_me);
  perform set_config('vero.member_change_reason', '', true);
  perform realtime.send(jsonb_build_object('conversation_id', p_conversation_id),
                        'members.changed', 'conversation:' || p_conversation_id::text, true);
  return query select 'joined'::text, null::uuid;
end;
$$;

-- Owner/admins promote; only the owner demotes. Mirrors the role in the
-- announcements group so community admins can post there.
create or replace function public.set_community_member_role(p_community_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mine   text := public.community_role(p_community_id);
  v_theirs text := public.community_role(p_community_id, p_user_id);
  v_ann    uuid;
begin
  if p_role not in ('admin', 'member') then
    raise exception 'role must be admin or member' using errcode = '22023';
  end if;
  if v_mine is null or v_mine not in ('owner', 'admin') then
    raise exception 'only community admins can change roles' using errcode = '42501';
  end if;
  if v_theirs is null then
    raise exception 'not a community member' using errcode = 'P0002';
  end if;
  if v_theirs = 'owner' then
    raise exception 'the owner''s role cannot be changed' using errcode = '42501';
  end if;
  if p_role = 'member' and v_mine <> 'owner' and p_user_id <> auth.uid() then
    raise exception 'only the owner can dismiss admins' using errcode = '42501';
  end if;

  update public.community_members set role = p_role
   where community_id = p_community_id and user_id = p_user_id;

  select announcements_conversation_id into v_ann from public.communities where id = p_community_id;
  if v_ann is not null and public.group_member_role(v_ann, p_user_id) in ('admin', 'member') then
    update public.conversation_members set role = p_role
     where conversation_id = v_ann and user_id = p_user_id and left_at is null;
    perform realtime.send(jsonb_build_object('conversation_id', v_ann),
                          'members.changed', 'conversation:' || v_ann::text, true);
  end if;
end;
$$;

-- Admins remove members (from the community and its announcements group).
create or replace function public.remove_community_member(p_community_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_theirs text := public.community_role(p_community_id, p_user_id);
  v_ann    uuid;
begin
  if p_user_id <> auth.uid() and not public.is_community_admin(p_community_id) then
    raise exception 'only community admins can remove members' using errcode = '42501';
  end if;
  if v_theirs is null then
    raise exception 'not a community member' using errcode = 'P0002';
  end if;
  if v_theirs = 'owner' then
    raise exception 'the owner cannot leave or be removed; delete the community instead' using errcode = '42501';
  end if;
  if v_theirs = 'admin' and p_user_id <> auth.uid() and public.community_role(p_community_id) <> 'owner' then
    raise exception 'only the owner can remove admins' using errcode = '42501';
  end if;

  delete from public.community_members where community_id = p_community_id and user_id = p_user_id;

  select announcements_conversation_id into v_ann from public.communities where id = p_community_id;
  if v_ann is not null then
    update public.conversation_members set left_at = now(), role = 'member'
     where conversation_id = v_ann and user_id = p_user_id and left_at is null;
    perform realtime.send(jsonb_build_object('conversation_id', v_ann),
                          'members.changed', 'conversation:' || v_ann::text, true);
  end if;
end;
$$;

create or replace function public.leave_community(p_community_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$ select public.remove_community_member(p_community_id, auth.uid()) $$;

-- Community admins see the member list (members don't see each other).
create or replace function public.list_community_members(p_community_id uuid)
returns table (user_id uuid, username text, display_name text, role text, joined_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, p.username, p.display_name, m.role, m.joined_at
  from public.community_members m
  join public.profiles p on p.id = m.user_id
  where m.community_id = p_community_id and public.is_community_admin(p_community_id)
  order by (m.role = 'owner') desc, (m.role = 'admin') desc, p.display_name;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Function privileges (per function: never a blanket revoke that would undo
-- other migrations' grants).
-- ─────────────────────────────────────────────────────────────────────────────

-- Internal helpers: not callable through the API.
revoke execute on function public.generate_invite_token() from public, anon, authenticated;
revoke execute on function public.consume_rate_limit(text, integer, interval) from public, anon, authenticated;
revoke execute on function public.conversations_create_group_settings() from public, anon, authenticated;
revoke execute on function public.messages_group_permissions() from public, anon, authenticated;
revoke execute on function public.log_group_event(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.conversation_members_log_event() from public, anon, authenticated;
revoke execute on function public.conversations_log_rename() from public, anon, authenticated;
revoke execute on function public.group_settings_log_change() from public, anon, authenticated;
revoke execute on function public.group_add_member_internal(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.delete_group_internal(uuid) from public, anon, authenticated;
revoke execute on function public.group_invite_problem(public.group_invites) from public, anon, authenticated;
revoke execute on function public.decide_group_join_request(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.channel_posts_before_write() from public, anon, authenticated;
revoke execute on function public.channel_post_json(public.channel_posts) from public, anon, authenticated;
revoke execute on function public.channel_posts_broadcast() from public, anon, authenticated;
revoke execute on function public.channel_followers_count() from public, anon, authenticated;
revoke execute on function public.channel_reactions_count() from public, anon, authenticated;
revoke execute on function public.conversation_members_sync_community() from public, anon, authenticated;
revoke execute on function public.create_group_internal(text, text) from public, anon, authenticated;

-- Helpers used inside RLS policies / by signed-in clients.
revoke execute on function public.is_valid_avatar_data(text) from public, anon;
revoke execute on function public.group_member_role(uuid, uuid) from public, anon;
revoke execute on function public.group_member_count(uuid) from public, anon;
revoke execute on function public.is_active_group(uuid) from public, anon;
revoke execute on function public.member_joined_at(uuid) from public, anon;
revoke execute on function public.group_member_limit() from public, anon;
revoke execute on function public.is_channel_admin(uuid, uuid) from public, anon;
revoke execute on function public.is_channel_owner(uuid) from public, anon;
revoke execute on function public.is_channel_follower(uuid) from public, anon;
revoke execute on function public.can_read_channel(uuid) from public, anon;
revoke execute on function public.can_use_channel_topic(text, boolean) from public, anon;
revoke execute on function public.channel_id_from_object_path(text) from public, anon;
revoke execute on function public.community_role(uuid, uuid) from public, anon;
revoke execute on function public.is_community_member(uuid) from public, anon;
revoke execute on function public.is_community_admin(uuid) from public, anon;
grant execute on function public.is_valid_avatar_data(text) to authenticated;
grant execute on function public.group_member_role(uuid, uuid) to authenticated;
grant execute on function public.group_member_count(uuid) to authenticated;
grant execute on function public.is_active_group(uuid) to authenticated;
grant execute on function public.member_joined_at(uuid) to authenticated;
grant execute on function public.group_member_limit() to authenticated;
grant execute on function public.is_channel_admin(uuid, uuid) to authenticated;
grant execute on function public.is_channel_owner(uuid) to authenticated;
grant execute on function public.is_channel_follower(uuid) to authenticated;
grant execute on function public.can_read_channel(uuid) to authenticated;
grant execute on function public.can_use_channel_topic(text, boolean) to authenticated;
grant execute on function public.channel_id_from_object_path(text) to authenticated;
grant execute on function public.community_role(uuid, uuid) to authenticated;
grant execute on function public.is_community_member(uuid) to authenticated;
grant execute on function public.is_community_admin(uuid) to authenticated;

-- RPCs for signed-in users.
revoke execute on function public.update_group_info(uuid, text, text, text, boolean) from public, anon;
revoke execute on function public.set_group_permissions(uuid, boolean, boolean, boolean) from public, anon;
revoke execute on function public.set_group_member_role(uuid, uuid, text) from public, anon;
revoke execute on function public.transfer_group_ownership(uuid, uuid) from public, anon;
revoke execute on function public.leave_group(uuid) from public, anon;
revoke execute on function public.delete_group(uuid) from public, anon;
revoke execute on function public.create_group_invite(uuid, timestamptz, integer, boolean) from public, anon;
revoke execute on function public.revoke_group_invite(uuid) from public, anon;
revoke execute on function public.list_group_invites(uuid) from public, anon;
revoke execute on function public.preview_group_invite(text) from public, anon;
revoke execute on function public.join_group_via_invite(text) from public, anon;
revoke execute on function public.approve_group_join_request(uuid) from public, anon;
revoke execute on function public.deny_group_join_request(uuid) from public, anon;
revoke execute on function public.cancel_group_join_request(uuid) from public, anon;
revoke execute on function public.channel_handle_available(text) from public, anon;
revoke execute on function public.create_channel(text, text, text, text) from public, anon;
revoke execute on function public.update_channel(uuid, text, text, text, boolean, text) from public, anon;
revoke execute on function public.get_channel_invite_token(uuid) from public, anon;
revoke execute on function public.rotate_channel_invite(uuid) from public, anon;
revoke execute on function public.delete_channel(uuid) from public, anon;
revoke execute on function public.add_channel_admin(uuid, uuid) from public, anon;
revoke execute on function public.remove_channel_admin(uuid, uuid) from public, anon;
revoke execute on function public.follow_channel(uuid) from public, anon;
revoke execute on function public.preview_channel_invite(text) from public, anon;
revoke execute on function public.follow_channel_via_invite(text) from public, anon;
revoke execute on function public.unfollow_channel(uuid) from public, anon;
revoke execute on function public.set_channel_muted(uuid, boolean) from public, anon;
revoke execute on function public.react_to_channel_post(uuid, text) from public, anon;
revoke execute on function public.get_channel_details(uuid) from public, anon;
revoke execute on function public.my_channels() from public, anon;
revoke execute on function public.search_channels(text, integer) from public, anon;
revoke execute on function public.create_community(text, text) from public, anon;
revoke execute on function public.update_community(uuid, text, text, text, boolean) from public, anon;
revoke execute on function public.delete_community(uuid) from public, anon;
revoke execute on function public.link_group_to_community(uuid, uuid) from public, anon;
revoke execute on function public.unlink_group_from_community(uuid, uuid) from public, anon;
revoke execute on function public.create_community_group(uuid, text, text) from public, anon;
revoke execute on function public.get_community_details(uuid) from public, anon;
revoke execute on function public.my_communities() from public, anon;
revoke execute on function public.get_community_groups(uuid) from public, anon;
revoke execute on function public.join_community_group(uuid, uuid) from public, anon;
revoke execute on function public.set_community_member_role(uuid, uuid, text) from public, anon;
revoke execute on function public.remove_community_member(uuid, uuid) from public, anon;
revoke execute on function public.leave_community(uuid) from public, anon;
revoke execute on function public.list_community_members(uuid) from public, anon;

grant execute on function public.update_group_info(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.set_group_permissions(uuid, boolean, boolean, boolean) to authenticated;
grant execute on function public.set_group_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.transfer_group_ownership(uuid, uuid) to authenticated;
grant execute on function public.leave_group(uuid) to authenticated;
grant execute on function public.delete_group(uuid) to authenticated;
grant execute on function public.create_group_invite(uuid, timestamptz, integer, boolean) to authenticated;
grant execute on function public.revoke_group_invite(uuid) to authenticated;
grant execute on function public.list_group_invites(uuid) to authenticated;
grant execute on function public.preview_group_invite(text) to authenticated;
grant execute on function public.join_group_via_invite(text) to authenticated;
grant execute on function public.approve_group_join_request(uuid) to authenticated;
grant execute on function public.deny_group_join_request(uuid) to authenticated;
grant execute on function public.cancel_group_join_request(uuid) to authenticated;
grant execute on function public.channel_handle_available(text) to authenticated;
grant execute on function public.create_channel(text, text, text, text) to authenticated;
grant execute on function public.update_channel(uuid, text, text, text, boolean, text) to authenticated;
grant execute on function public.get_channel_invite_token(uuid) to authenticated;
grant execute on function public.rotate_channel_invite(uuid) to authenticated;
grant execute on function public.delete_channel(uuid) to authenticated;
grant execute on function public.add_channel_admin(uuid, uuid) to authenticated;
grant execute on function public.remove_channel_admin(uuid, uuid) to authenticated;
grant execute on function public.follow_channel(uuid) to authenticated;
grant execute on function public.preview_channel_invite(text) to authenticated;
grant execute on function public.follow_channel_via_invite(text) to authenticated;
grant execute on function public.unfollow_channel(uuid) to authenticated;
grant execute on function public.set_channel_muted(uuid, boolean) to authenticated;
grant execute on function public.react_to_channel_post(uuid, text) to authenticated;
grant execute on function public.get_channel_details(uuid) to authenticated;
grant execute on function public.my_channels() to authenticated;
grant execute on function public.search_channels(text, integer) to authenticated;
grant execute on function public.create_community(text, text) to authenticated;
grant execute on function public.update_community(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.delete_community(uuid) to authenticated;
grant execute on function public.link_group_to_community(uuid, uuid) to authenticated;
grant execute on function public.unlink_group_from_community(uuid, uuid) to authenticated;
grant execute on function public.create_community_group(uuid, text, text) to authenticated;
grant execute on function public.get_community_details(uuid) to authenticated;
grant execute on function public.my_communities() to authenticated;
grant execute on function public.get_community_groups(uuid) to authenticated;
grant execute on function public.join_community_group(uuid, uuid) to authenticated;
grant execute on function public.set_community_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.remove_community_member(uuid, uuid) to authenticated;
grant execute on function public.leave_community(uuid) to authenticated;
grant execute on function public.list_community_members(uuid) to authenticated;
