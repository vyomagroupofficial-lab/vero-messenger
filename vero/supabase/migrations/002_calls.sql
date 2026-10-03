-- ============================================================================
-- Vero Messenger - 002: real calls (1:1 + group mesh) on top of 001's
-- call_sessions. Tests: supabase/tests/calls_test.sql.
-- ============================================================================
-- What the server stores / sees
--   * Who called whom (or which group), when, call type, outcome, which device
--     answered, and who is in a group call with their mute / camera /
--     screen-share flags (for the participant grid).
--   * It never sees SDP, DTLS fingerprints or ICE candidates: those are sealed
--     device-to-device with crypto_box (src/features/calls/signalingCrypto.ts)
--     before they're broadcast on the private `call:<id>` topic. Media is
--     peer-to-peer DTLS-SRTP (optionally relayed by TURN, which only sees
--     encrypted packets).
--
-- 1:1 calls
--   start_direct_call()  ringing; `call.invite` -> user:<callee>
--   answer_call()        first callee device wins (returns false elsewhere)
--   update_call_status() rejected / busy / cancelled / missed / ended / failed
--   Every status change broadcasts `call.status` to user:<caller>,
--   user:<callee> (all their devices, so other devices stop ringing) and
--   call:<id>.
--
-- Group calls (mesh, max 8 participants)
--   start_group_call()   one live call per group; `call.invite` -> every
--                        other member's user:<id>; `call.live` -> conversation
--   join_group_call()    returns the current participants; `call.participant`
--   leave_call()         last one out ends the call
--   set_call_media_state(), call_heartbeat(), expire_stale_calls()
--
-- Realtime: call:<id> of a group call is open to current group members
-- (new function + policies; 001's policy is untouched, policies OR together).
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- call_sessions: group calls, devices, new statuses
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.call_sessions
  add column is_group           boolean not null default false,
  add column caller_device_id   uuid references public.devices (id) on delete set null,
  add column answered_device_id uuid references public.devices (id) on delete set null,
  add column push_sent_at       timestamptz;

-- Group calls have no single callee.
alter table public.call_sessions alter column callee_id drop not null;

alter table public.call_sessions drop constraint if exists call_sessions_status_check;
alter table public.call_sessions add constraint call_sessions_status_check
  check (status in ('ringing', 'active', 'ended', 'missed', 'rejected', 'busy', 'cancelled', 'failed'));

alter table public.call_sessions add constraint call_sessions_kind_check
  check ((is_group and callee_id is null) or (not is_group and callee_id is not null));

-- At most one live call per group.
create unique index call_sessions_live_group_idx
  on public.call_sessions (conversation_id)
  where is_group and status = 'active';

create index call_sessions_open_idx
  on public.call_sessions (created_at)
  where status in ('ringing', 'active');

create index call_sessions_conversation_idx
  on public.call_sessions (conversation_id, created_at desc);

create index call_sessions_callee_idx
  on public.call_sessions (callee_id, created_at desc);

-- Group members see their group's calls (001's policy covers 1:1 participants).
create policy "group members see group calls"
  on public.call_sessions for select to authenticated
  using (is_group and public.is_conversation_member(conversation_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- call_participants (one row per device that joined; writes via RPCs only)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.call_participants (
  id             uuid primary key default gen_random_uuid(),
  call_id        uuid not null references public.call_sessions (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  device_id      uuid not null references public.devices (id) on delete cascade,
  joined_at      timestamptz not null default now(),
  left_at        timestamptz,
  last_seen_at   timestamptz not null default now(),
  audio_muted    boolean not null default false,
  video_enabled  boolean not null default false,
  screen_sharing boolean not null default false
);

create unique index call_participants_active_device_idx
  on public.call_participants (call_id, device_id) where left_at is null;
create index call_participants_call_idx on public.call_participants (call_id) where left_at is null;
create index call_participants_user_idx on public.call_participants (user_id, joined_at desc);
create index call_participants_stale_idx on public.call_participants (last_seen_at) where left_at is null;

alter table public.call_participants enable row level security;

-- 1:1: the two parties. Group: current members of the group.
create or replace function public.can_access_call(p_call_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_call public.call_sessions;
begin
  if auth.uid() is null then
    return false;
  end if;
  select * into v_call from public.call_sessions where id = p_call_id;
  if not found then
    return false;
  end if;
  if v_call.is_group then
    return public.is_conversation_member(v_call.conversation_id);
  end if;
  return auth.uid() in (v_call.caller_id, v_call.callee_id);
end;
$$;

create policy "call members see participants"
  on public.call_participants for select to authenticated
  using (public.can_access_call(call_id));

revoke insert, update, delete on public.call_participants from anon, authenticated;
revoke all on public.call_participants from anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- Internal helpers (not callable by clients)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.group_call_max_participants()
returns integer
language sql
immutable
set search_path = ''
as $$ select 8 $$;

create or replace function public.assert_own_device(p_device_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_device_id is null or not exists (
    select 1 from public.devices
    where id = p_device_id and user_id = auth.uid() and revoked_at is null
  ) then
    raise exception 'unknown device' using errcode = '42501';
  end if;
end;
$$;

-- Broadcasts the current status of a call to everyone who needs it.
create or replace function public.broadcast_call_status(p_call_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_call    public.call_sessions;
  v_payload jsonb;
begin
  select * into v_call from public.call_sessions where id = p_call_id;
  if not found then
    return;
  end if;
  v_payload := jsonb_build_object(
    'call_id', v_call.id,
    'conversation_id', v_call.conversation_id,
    'is_group', v_call.is_group,
    'call_type', v_call.call_type,
    'status', v_call.status,
    'caller_id', v_call.caller_id,
    'caller_device_id', v_call.caller_device_id,
    'callee_id', v_call.callee_id,
    'answered_device_id', v_call.answered_device_id,
    'by_user_id', auth.uid(),
    'at', now());

  perform realtime.send(v_payload, 'call.status', 'call:' || v_call.id::text, true);
  if v_call.is_group then
    -- Open group chats show / hide the "join call" banner.
    perform realtime.send(v_payload, 'call.live', 'conversation:' || v_call.conversation_id::text, true);
  else
    perform realtime.send(v_payload, 'call.status', 'user:' || v_call.caller_id::text, true);
    perform realtime.send(v_payload, 'call.status', 'user:' || v_call.callee_id::text, true);
  end if;
end;
$$;

create or replace function public.broadcast_call_participant(p_row public.call_participants, p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'call_id', p_row.call_id,
      'action', p_action,
      'user_id', p_row.user_id,
      'device_id', p_row.device_id,
      'audio_muted', p_row.audio_muted,
      'video_enabled', p_row.video_enabled,
      'screen_sharing', p_row.screen_sharing,
      'at', now()),
    'call.participant', 'call:' || p_row.call_id::text, true);
end;
$$;

-- Marks every active participant of a call as left (call finished).
create or replace function public.close_call_participants(p_call_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.call_participants
     set left_at = now()
   where call_id = p_call_id and left_at is null;
end;
$$;

-- Ends a group call once nobody is left in it.
create or replace function public.end_group_call_if_empty(p_call_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.call_sessions c
     set status = 'ended', ended_at = coalesce(c.ended_at, now())
   where c.id = p_call_id
     and c.is_group
     and c.status = 'active'
     and not exists (select 1 from public.call_participants p where p.call_id = c.id and p.left_at is null);
  if found then
    perform public.broadcast_call_status(p_call_id);
    return true;
  end if;
  return false;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Stale-call cleanup: lost heartbeats (app killed, network gone) and calls that
-- nobody resolved. Runs lazily from the call RPCs and every minute via pg_cron.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.expire_stale_calls()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_row   public.call_participants;
  v_id    uuid;
begin
  -- Unanswered 1:1 calls (clients time out at 45 s; this is the safety net).
  for v_id in
    update public.call_sessions
       set status = 'missed', ended_at = now()
     where not is_group and status = 'ringing' and created_at < now() - interval '90 seconds'
    returning id
  loop
    perform public.close_call_participants(v_id);
    perform public.broadcast_call_status(v_id);
    v_count := v_count + 1;
  end loop;

  -- Devices that stopped sending heartbeats (every 20 s) left the call.
  for v_row in
    update public.call_participants
       set left_at = last_seen_at
     where left_at is null and last_seen_at < now() - interval '75 seconds'
    returning *
  loop
    perform public.broadcast_call_participant(v_row, 'left');
    v_count := v_count + 1;
  end loop;

  -- Live calls nobody is in any more.
  for v_id in
    update public.call_sessions c
       set status = 'ended', ended_at = now()
     where c.status = 'active'
       and coalesce(c.answered_at, c.created_at) < now() - interval '60 seconds'
       and not exists (select 1 from public.call_participants p where p.call_id = c.id and p.left_at is null)
    returning c.id
  loop
    perform public.close_call_participants(v_id);
    perform public.broadcast_call_status(v_id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1:1 calls
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.start_direct_call(p_conversation_id uuid, p_call_type text, p_device_id uuid)
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
  perform public.assert_own_device(p_device_id);
  if p_call_type not in ('voice', 'video') then
    raise exception 'invalid call type' using errcode = '22023';
  end if;
  if not public.is_conversation_member(p_conversation_id) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if not exists (select 1 from public.conversations where id = p_conversation_id and conversation_type = 'direct') then
    raise exception 'use start_group_call for groups' using errcode = '22023';
  end if;

  select user_id into v_callee from public.conversation_members
  where conversation_id = p_conversation_id and user_id <> v_me and left_at is null;
  if v_callee is null or public.is_blocked_between(v_me, v_callee) then
    raise exception 'cannot call this user' using errcode = '42501';
  end if;

  -- Ring spam guard.
  if (select count(*) from public.call_sessions
      where caller_id = v_me and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'Too many calls. Try again in a few minutes.' using errcode = '54000';
  end if;

  perform public.expire_stale_calls();

  insert into public.call_sessions (conversation_id, caller_id, callee_id, call_type, caller_device_id)
  values (p_conversation_id, v_me, v_callee, p_call_type, p_device_id)
  returning id into v_call;

  insert into public.call_participants (call_id, user_id, device_id)
  values (v_call, v_me, p_device_id);

  select display_name into v_name from public.profiles where id = v_me;

  perform realtime.send(
    jsonb_build_object('call_id', v_call, 'conversation_id', p_conversation_id, 'is_group', false,
                       'caller_id', v_me, 'caller_device_id', p_device_id, 'caller_name', v_name,
                       'call_type', p_call_type, 'created_at', now()),
    'call.invite', 'user:' || v_callee::text, true);

  return v_call;
end;
$$;

-- The first callee device to answer wins; every other device is told via
-- call.status (answered_device_id) and stops ringing.
create or replace function public.answer_call(p_call_id uuid, p_device_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_call public.call_sessions;
begin
  perform public.assert_own_device(p_device_id);
  select * into v_call from public.call_sessions where id = p_call_id for update;
  if not found or v_call.is_group or v_call.callee_id is distinct from auth.uid() then
    raise exception 'not the callee of this call' using errcode = '42501';
  end if;
  if v_call.status <> 'ringing' then
    return false;
  end if;

  update public.call_sessions
     set status = 'active', answered_at = now(), answered_device_id = p_device_id
   where id = p_call_id;

  insert into public.call_participants (call_id, user_id, device_id)
  values (p_call_id, auth.uid(), p_device_id)
  on conflict (call_id, device_id) where left_at is null do nothing;

  perform public.broadcast_call_status(p_call_id);
  return true;
end;
$$;

-- Same signature as 001 (old clients keep working); new statuses + broadcasts.
--   ringing -> active    callee only (prefer answer_call, which records the device)
--   ringing -> rejected  callee declined            ringing -> busy   callee in another call
--   ringing -> cancelled caller hung up first       ringing -> missed timeout
--   ringing -> ended     mapped to cancelled (caller) / rejected (callee)
--   active  -> ended / failed; anything else from active means ended.
-- Terminal statuses are final.
create or replace function public.update_call_status(p_call_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_call public.call_sessions;
  v_new  text := p_status;
begin
  if p_status not in ('active', 'ended', 'missed', 'rejected', 'busy', 'cancelled', 'failed') then
    raise exception 'invalid status' using errcode = '22023';
  end if;

  select * into v_call from public.call_sessions where id = p_call_id for update;
  if not found or v_call.is_group or v_me is null or v_me not in (v_call.caller_id, v_call.callee_id) then
    raise exception 'not a participant of this call' using errcode = '42501';
  end if;
  if v_call.status not in ('ringing', 'active') then
    return;
  end if;

  if v_call.status = 'ringing' then
    if p_status in ('active', 'rejected', 'busy') and v_me <> v_call.callee_id then
      raise exception 'only the callee can do that' using errcode = '42501';
    elsif p_status = 'cancelled' and v_me <> v_call.caller_id then
      raise exception 'only the caller can cancel' using errcode = '42501';
    elsif p_status = 'ended' then
      v_new := case when v_me = v_call.caller_id then 'cancelled' else 'rejected' end;
    end if;
  else -- active
    if p_status = 'active' then
      return;
    elsif p_status <> 'failed' then
      v_new := 'ended';
    end if;
  end if;

  update public.call_sessions
     set status      = v_new,
         answered_at = case when v_new = 'active' then coalesce(answered_at, now()) else answered_at end,
         ended_at    = case when v_new <> 'active' then coalesce(ended_at, now()) else ended_at end
   where id = p_call_id;

  if v_new <> 'active' then
    perform public.close_call_participants(p_call_id);
  end if;
  perform public.broadcast_call_status(p_call_id);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Group calls
-- ─────────────────────────────────────────────────────────────────────────────

-- Starts the group's call, or returns the one that is already live (the
-- client then calls join_group_call either way).
create or replace function public.start_group_call(p_conversation_id uuid, p_call_type text, p_device_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_call   uuid;
  v_name   text;
  v_group  text;
  v_member uuid;
begin
  perform public.assert_own_device(p_device_id);
  if p_call_type not in ('voice', 'video') then
    raise exception 'invalid call type' using errcode = '22023';
  end if;
  if not public.is_conversation_member(p_conversation_id) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  select group_name into v_group from public.conversations
  where id = p_conversation_id and conversation_type = 'group';
  if not found then
    raise exception 'group calls need a group chat' using errcode = '22023';
  end if;

  perform public.expire_stale_calls();

  -- Serialise concurrent starts for the same group.
  perform pg_advisory_xact_lock(hashtextextended('vero-group-call:' || p_conversation_id::text, 0));

  select id into v_call from public.call_sessions
  where conversation_id = p_conversation_id and is_group and status = 'active';
  if found then
    return v_call;
  end if;

  if (select count(*) from public.call_sessions
      where caller_id = v_me and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'Too many calls. Try again in a few minutes.' using errcode = '54000';
  end if;

  insert into public.call_sessions
    (conversation_id, caller_id, callee_id, call_type, caller_device_id, is_group, status, answered_at)
  values (p_conversation_id, v_me, null, p_call_type, p_device_id, true, 'active', now())
  returning id into v_call;

  select display_name into v_name from public.profiles where id = v_me;

  for v_member in
    select cm.user_id from public.conversation_members cm
    where cm.conversation_id = p_conversation_id
      and cm.left_at is null
      and cm.user_id <> v_me
      and not public.is_blocked_between(v_me, cm.user_id)
  loop
    perform realtime.send(
      jsonb_build_object('call_id', v_call, 'conversation_id', p_conversation_id, 'is_group', true,
                         'group_name', v_group, 'caller_id', v_me, 'caller_device_id', p_device_id,
                         'caller_name', v_name, 'call_type', p_call_type, 'created_at', now()),
      'call.invite', 'user:' || v_member::text, true);
  end loop;

  perform public.broadcast_call_status(v_call);
  return v_call;
end;
$$;

-- Joins (or re-joins) a live group call from this device and returns everyone
-- currently in it. A user is in a call from one device at a time: joining from
-- another device moves them.
create or replace function public.join_group_call(p_call_id uuid, p_device_id uuid)
returns table (
  user_id        uuid,
  device_id      uuid,
  joined_at      timestamptz,
  audio_muted    boolean,
  video_enabled  boolean,
  screen_sharing boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_call public.call_sessions;
  v_row  public.call_participants;
begin
  perform public.assert_own_device(p_device_id);
  perform public.expire_stale_calls();

  select * into v_call from public.call_sessions where id = p_call_id for update;
  if not found or not v_call.is_group or not public.is_conversation_member(v_call.conversation_id) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;
  if v_call.status <> 'active' then
    raise exception 'This call has ended.' using errcode = '22023';
  end if;

  -- Move away from my other devices.
  for v_row in
    update public.call_participants p
       set left_at = now()
     where p.call_id = p_call_id and p.user_id = v_me and p.device_id <> p_device_id and p.left_at is null
    returning *
  loop
    perform public.broadcast_call_participant(v_row, 'left');
  end loop;

  select * into v_row from public.call_participants p
  where p.call_id = p_call_id and p.device_id = p_device_id and p.left_at is null;

  if found then
    update public.call_participants p set last_seen_at = now() where p.id = v_row.id;
  else
    if (select count(distinct p.user_id) from public.call_participants p
        where p.call_id = p_call_id and p.left_at is null and p.user_id <> v_me)
       >= public.group_call_max_participants() then
      raise exception 'This call is full (group calls are limited to % people).', public.group_call_max_participants()
        using errcode = '53400';
    end if;
    insert into public.call_participants (call_id, user_id, device_id)
    values (p_call_id, v_me, p_device_id)
    returning * into v_row;
    perform public.broadcast_call_participant(v_row, 'joined');
  end if;

  return query
    select p.user_id, p.device_id, p.joined_at, p.audio_muted, p.video_enabled, p.screen_sharing
    from public.call_participants p
    where p.call_id = p_call_id and p.left_at is null
    order by p.joined_at;
end;
$$;

-- Leaves a call from this device (group: the last one out ends it).
-- 1:1 calls end through update_call_status; this only records the device.
create or replace function public.leave_call(p_call_id uuid, p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.call_participants;
begin
  perform public.assert_own_device(p_device_id);
  if not public.can_access_call(p_call_id) then
    raise exception 'not a participant of this call' using errcode = '42501';
  end if;
  perform 1 from public.call_sessions where id = p_call_id for update;

  for v_row in
    update public.call_participants p
       set left_at = now()
     where p.call_id = p_call_id and p.device_id = p_device_id and p.user_id = auth.uid() and p.left_at is null
    returning *
  loop
    perform public.broadcast_call_participant(v_row, 'left');
  end loop;

  perform public.end_group_call_if_empty(p_call_id);
end;
$$;

-- Mute / camera / screen-share flags for the participant grid.
create or replace function public.set_call_media_state(
  p_call_id uuid, p_device_id uuid, p_audio_muted boolean, p_video_enabled boolean, p_screen_sharing boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.call_participants;
begin
  perform public.assert_own_device(p_device_id);
  update public.call_participants p
     set audio_muted    = coalesce(p_audio_muted, p.audio_muted),
         video_enabled  = coalesce(p_video_enabled, p.video_enabled),
         screen_sharing = coalesce(p_screen_sharing, p.screen_sharing),
         last_seen_at   = now()
   where p.call_id = p_call_id and p.device_id = p_device_id and p.user_id = auth.uid() and p.left_at is null
  returning * into v_row;
  if found then
    perform public.broadcast_call_participant(v_row, 'media');
  end if;
end;
$$;

-- Clients call this every ~20 s while in a call. Returns false when the call
-- is over or this device is no longer in it (it should then hang up).
create or replace function public.call_heartbeat(p_call_id uuid, p_device_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_own_device(p_device_id);
  update public.call_participants p
     set last_seen_at = now()
   where p.call_id = p_call_id and p.device_id = p_device_id and p.user_id = auth.uid() and p.left_at is null;
  if not found then
    return false;
  end if;
  return exists (select 1 from public.call_sessions where id = p_call_id and status in ('ringing', 'active'));
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Optional server config from Supabase Vault (service role only), so TURN can
-- be configured with SQL instead of `supabase secrets set`:
--   select vault.create_secret('<cloudflare key id>',    'vero_turn_cloudflare_key_id');
--   select vault.create_secret('<cloudflare api token>', 'vero_turn_cloudflare_api_token');
--   -- or a static TURN server:
--   select vault.create_secret('turn:turn.example.com:3478,turns:turn.example.com:5349', 'vero_turn_urls');
--   select vault.create_secret('<user>', 'vero_turn_username');
--   select vault.create_secret('<password>', 'vero_turn_credential');
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.get_turn_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb := '{}'::jsonb;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    return v_result;
  end if;
  execute $q$
    select coalesce(jsonb_object_agg(name, decrypted_secret), '{}'::jsonb)
    from vault.decrypted_secrets
    where name in ('vero_turn_cloudflare_key_id', 'vero_turn_cloudflare_api_token',
                   'vero_turn_urls', 'vero_turn_username', 'vero_turn_credential')
  $q$ into v_result;
  return v_result;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime: group members may use call:<id> of their group's calls
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.can_use_group_call_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id text := split_part(p_topic, ':', 2);
begin
  if split_part(p_topic, ':', 1) <> 'call'
     or v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1 from public.call_sessions c
    where c.id = v_id::uuid and c.is_group and public.is_conversation_member(c.conversation_id)
  );
end;
$$;

create policy "vero group call members receive realtime"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.can_use_group_call_topic((select realtime.topic()))
  );

create policy "vero group call members send realtime"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.can_use_group_call_topic((select realtime.topic()))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function public.can_access_call(uuid) from public, anon;
revoke execute on function public.group_call_max_participants() from public, anon;
revoke execute on function public.assert_own_device(uuid) from public, anon, authenticated;
revoke execute on function public.broadcast_call_status(uuid) from public, anon, authenticated;
revoke execute on function public.broadcast_call_participant(public.call_participants, text) from public, anon, authenticated;
revoke execute on function public.close_call_participants(uuid) from public, anon, authenticated;
revoke execute on function public.end_group_call_if_empty(uuid) from public, anon, authenticated;
revoke execute on function public.expire_stale_calls() from public, anon, authenticated;
revoke execute on function public.get_turn_config() from public, anon, authenticated;
revoke execute on function public.start_direct_call(uuid, text, uuid) from public, anon;
revoke execute on function public.answer_call(uuid, uuid) from public, anon;
revoke execute on function public.update_call_status(uuid, text) from public, anon;
revoke execute on function public.start_group_call(uuid, text, uuid) from public, anon;
revoke execute on function public.join_group_call(uuid, uuid) from public, anon;
revoke execute on function public.leave_call(uuid, uuid) from public, anon;
revoke execute on function public.set_call_media_state(uuid, uuid, boolean, boolean, boolean) from public, anon;
revoke execute on function public.call_heartbeat(uuid, uuid) from public, anon;
revoke execute on function public.can_use_group_call_topic(text) from public, anon;

grant execute on function public.can_access_call(uuid) to authenticated;
grant execute on function public.group_call_max_participants() to authenticated;
grant execute on function public.start_direct_call(uuid, text, uuid) to authenticated;
grant execute on function public.answer_call(uuid, uuid) to authenticated;
grant execute on function public.update_call_status(uuid, text) to authenticated;
grant execute on function public.start_group_call(uuid, text, uuid) to authenticated;
grant execute on function public.join_group_call(uuid, uuid) to authenticated;
grant execute on function public.leave_call(uuid, uuid) to authenticated;
grant execute on function public.set_call_media_state(uuid, uuid, boolean, boolean, boolean) to authenticated;
grant execute on function public.call_heartbeat(uuid, uuid) to authenticated;
grant execute on function public.can_use_group_call_topic(text) to authenticated;
grant execute on function public.expire_stale_calls() to service_role;
grant execute on function public.get_turn_config() to service_role;
grant select on public.call_participants to authenticated;
grant all on public.call_participants to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Scheduled cleanup (only if pg_cron is enabled on the project)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vero-expire-stale-calls', '* * * * *', 'select public.expire_stale_calls()');
  end if;
end;
$$;
