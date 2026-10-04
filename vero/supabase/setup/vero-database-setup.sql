-- Vero: full database setup for the live project (generated 2026-10-04).
-- Paste into Supabase Dashboard -> SQL Editor -> New query, then Run.
-- Everything runs in one transaction: it either all applies or nothing changes.
begin;

-- 001 (remaining part): disappearing-message cleanup
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
revoke execute on function public.cleanup_expired_messages() from public, anon, authenticated;
grant execute on function public.cleanup_expired_messages() to service_role;
select cron.schedule('vero-cleanup-expired', '*/5 * * * *', 'select public.cleanup_expired_messages()');

-- ================= 002_calls.sql =================
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

insert into supabase_migrations.schema_migrations (version, name) values ('002', 'calls') on conflict do nothing;

-- ================= 003_ratchet.sql =================
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

insert into supabase_migrations.schema_migrations (version, name) values ('003', 'ratchet') on conflict do nothing;

-- ================= 004_media.sql =================
-- ============================================================================
-- 004 - Direct-to-Storage encrypted media uploads
-- ============================================================================
-- Before: the whole ciphertext went through the media-upload Edge Function as
-- one base64 body (memory/body/time limits, ~15 MB max).
-- Now:
--   1. media-upload {action:"create"} -> begin_media_upload() checks membership,
--      size and rate limits and creates a *pending* media row, then the
--      function hands out a signed upload URL for
--      vero-media/<conversation_id>/<media_id>.
--   2. The app uploads the ciphertext straight to Storage.
--   3. media-upload {action:"confirm"} streams the object, checks its size and
--      BLAKE2b-256 against the row, and calls complete_media_upload().
-- Messages can only reference media that is `ready`; pending uploads that are
-- never confirmed are swept by cleanup_stale_media_uploads().
-- ============================================================================

alter table public.media
  add column if not exists upload_status text not null default 'ready'
    check (upload_status in ('pending', 'ready')),
  add column if not exists confirmed_at timestamptz;
-- Existing rows were verified by the old upload path; new rows start pending.
alter table public.media alter column upload_status set default 'pending';

alter table public.media
  add constraint media_encrypted_hash_format check (encrypted_hash ~ '^[0-9a-f]{64}$') not valid;

comment on column public.media.storage_object_id is
  'Backend-prefixed id of the ENCRYPTED blob: sb:<conversation_id>/<media_id> (Supabase Storage) or drive:<fileId>';
comment on column public.media.upload_status is
  'pending: upload URL issued, object not verified yet; ready: size + hash verified, may be referenced by messages';

create index if not exists media_pending_idx on public.media (created_at) where upload_status = 'pending';
create index if not exists media_uploader_created_idx on public.media (uploader_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- begin_media_upload: service role only (called by the media-upload function
-- after it authenticated the caller). Returns the new media id.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.begin_media_upload(
  p_conversation_id uuid,
  p_uploader_id     uuid,
  p_encrypted_size  bigint,
  p_encrypted_hash  text,
  p_backend         text,
  p_max_bytes       bigint,
  p_max_per_minute  integer default 30,
  p_max_pending     integer default 20
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  if not public.is_conversation_member(p_conversation_id, p_uploader_id) then
    raise exception 'not a member of this conversation' using errcode = '42501';
  end if;
  if p_encrypted_size is null or p_encrypted_size <= 0 then
    raise exception 'invalid size' using errcode = '22023';
  end if;
  if p_encrypted_size > p_max_bytes then
    raise exception 'file too large' using errcode = '54000';
  end if;
  if p_encrypted_hash is null or p_encrypted_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid hash' using errcode = '22023';
  end if;
  if p_backend not in ('supabase', 'drive') then
    raise exception 'invalid backend' using errcode = '22023';
  end if;

  -- Serialise concurrent uploads of one user so the limits below can't be raced.
  perform pg_advisory_xact_lock(hashtextextended('vero.media.' || p_uploader_id::text, 0));

  if (select count(*) from public.media
      where uploader_id = p_uploader_id and created_at > now() - interval '1 minute') >= p_max_per_minute then
    raise exception 'too many uploads' using errcode = '53400';
  end if;
  if (select count(*) from public.media
      where uploader_id = p_uploader_id and upload_status = 'pending' and deleted_at is null) >= p_max_pending then
    raise exception 'too many unfinished uploads' using errcode = '53400';
  end if;

  insert into public.media (id, conversation_id, uploader_id, storage_object_id, encrypted_size, encrypted_hash, upload_status)
  values (
    v_id,
    p_conversation_id,
    p_uploader_id,
    case p_backend
      when 'supabase' then 'sb:' || p_conversation_id::text || '/' || v_id::text
      else 'drive:pending'
    end,
    p_encrypted_size,
    p_encrypted_hash,
    'pending'
  );
  return v_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- complete_media_upload: service role only. p_ok=false marks the row deleted so
-- cleanup-expired removes whatever was uploaded. Returns true if a pending row
-- of that uploader was updated.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.complete_media_upload(
  p_media_id    uuid,
  p_uploader_id uuid,
  p_ok          boolean,
  p_object_id   text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_ok then
    update public.media
       set upload_status = 'ready',
           confirmed_at = now(),
           storage_object_id = coalesce(p_object_id, storage_object_id)
     where id = p_media_id
       and uploader_id = p_uploader_id
       and upload_status = 'pending'
       and deleted_at is null;
  else
    update public.media
       set deleted_at = now(),
           storage_object_id = coalesce(p_object_id, storage_object_id)
     where id = p_media_id
       and uploader_id = p_uploader_id
       and upload_status = 'pending'
       and deleted_at is null;
  end if;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- cleanup_stale_media_uploads: pending uploads that were never confirmed are
-- marked deleted (signed upload URLs expire after 2 hours).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.cleanup_stale_media_uploads(p_older_than interval default interval '6 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.media
     set deleted_at = now()
   where upload_status = 'pending'
     and deleted_at is null
     and created_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- media_download_target: service role only (media-download function). Returns
-- the stored object only to a current member of the media's conversation, and
-- only once the upload was verified. Same empty result for "missing", "not
-- yours", "deleted" and "not ready", so ids can't be probed.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.media_download_target(p_media_id uuid, p_user_id uuid)
returns table (storage_object_id text, encrypted_size bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select m.storage_object_id, m.encrypted_size
  from public.media m
  where m.id = p_media_id
    and m.deleted_at is null
    and m.upload_status = 'ready'
    and public.is_conversation_member(m.conversation_id, p_user_id);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Messages may only reference verified, live media. (Separate trigger so the
-- messages_before_insert function from 001 stays untouched.)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.messages_check_media_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.media_id is not null and not exists (
    select 1 from public.media
    where id = new.media_id and upload_status = 'ready' and deleted_at is null
  ) then
    raise exception 'media upload is not complete' using errcode = '22023';
  end if;
  return new;
end;
$$;

create or replace trigger messages_check_media_ready
  before insert on public.messages
  for each row execute function public.messages_check_media_ready();

-- Clients still only READ media rows (RLS policy from 001); writes go through
-- the functions above with the service role.
revoke execute on function public.begin_media_upload(uuid, uuid, bigint, text, text, bigint, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.complete_media_upload(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke execute on function public.cleanup_stale_media_uploads(interval) from public, anon, authenticated;
revoke execute on function public.messages_check_media_ready() from public, anon, authenticated;
revoke execute on function public.media_download_target(uuid, uuid) from public, anon, authenticated;
grant execute on function public.media_download_target(uuid, uuid) to service_role;
grant execute on function public.begin_media_upload(uuid, uuid, bigint, text, text, bigint, integer, integer) to service_role;
grant execute on function public.complete_media_upload(uuid, uuid, boolean, text) to service_role;
grant execute on function public.cleanup_stale_media_uploads(interval) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Bucket hardening: private, ciphertext only, 50 MB per object (the Supabase
-- free-plan cap). Still no storage.objects policies: clients only ever use
-- signed URLs minted by the Edge Functions.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public)
    values ('vero-media', 'vero-media', false)
    on conflict (id) do nothing;

    update storage.buckets
       set public = false,
           file_size_limit = 52428800,
           allowed_mime_types = array['application/octet-stream']
     where id = 'vero-media';
  end if;
end;
$$;

-- Sweep stale pending uploads together with expired messages (if pg_cron is on).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vero-cleanup-stale-uploads', '17 * * * *', 'select public.cleanup_stale_media_uploads()');
  end if;
end;
$$;

insert into supabase_migrations.schema_migrations (version, name) values ('004', 'media') on conflict do nothing;

-- ================= 005_settings_push_backup.sql =================
-- ============================================================================
-- Vero Messenger - 005: privacy settings, push notifications, mutes,
--                       last seen / online presence, encrypted backups
-- ============================================================================
-- Depends on 001 only. Later migrations (007 channels, ...) are referenced
-- solely from PL/pgSQL bodies, which resolve tables at call time.
--
-- Push pipeline (no Edge Function secrets needed):
--
--   messages INSERT --trigger--> net.http_post(<project_url>/functions/v1/send-push,
--                                              header x-webhook-secret: <vault secret>)
--   send-push checks the header with verify_push_webhook_secret() (service
--   role only), then asks get_message_push_targets() whom to wake.
--
--   Both values live in Supabase Vault:
--     push_webhook_secret  created by this migration with a random value
--     project_url          created by the operator, once:
--       select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   Until project_url exists the trigger is a silent no-op.
--
-- Privacy:
--   * user_settings: owner-only (RLS).
--   * last seen lives in its own table that clients cannot read directly
--     (profiles are readable by every signed-in user); get_last_seen()
--     applies the owner's visibility setting.
--   * presence:<user id> realtime topics: only that user may track, only
--     people who share a chat with them may watch, and only while both
--     sides have "show online" on.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- pg_net (present on Supabase; the local test harness stubs net.http_post)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net')
     and not exists (select 1 from pg_extension where extname = 'pg_net') then
    begin
      create extension pg_net with schema extensions;
    exception when others then
      raise warning '[vero] could not enable pg_net (%); enable it under Database -> Extensions', sqlerrm;
    end;
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Vault
-- ─────────────────────────────────────────────────────────────────────────────

-- Reads a Vault secret (null when Vault or the secret is missing).
-- Owner / service role only.
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
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 order by created_at desc limit 1'
    into v_value using p_name;
  return nullif(btrim(coalesce(v_value, '')), '');
end;
$$;

-- Shared secret between the push trigger and the send-push function:
-- 64 hex chars from two v4 UUIDs (gen_random_uuid uses the CSPRNG) hashed together.
do $$
begin
  if to_regclass('vault.secrets') is not null and public.vero_read_secret('push_webhook_secret') is null then
    perform vault.create_secret(
      encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'),
      'push_webhook_secret',
      'Authenticates database -> send-push calls (x-webhook-secret header). Rotate with vault.update_secret.'
    );
  end if;
end
$$;

-- send-push calls this (service role) to check the x-webhook-secret header.
-- Compares digests so the timing does not depend on how much of the secret matches.
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
  -- Show the sender's name in push notifications (never message content). Off by default.
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

-- Every profile gets a settings row (and existing profiles get one now).
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
-- LAST SEEN
-- Kept out of `profiles` on purpose: every signed-in user can read profiles.
-- No client privileges at all; read through get_last_seen().
-- ─────────────────────────────────────────────────────────────────────────────

create table public.user_last_seen (
  user_id      uuid primary key references public.profiles (id) on delete cascade,
  last_seen_at timestamptz not null default now()
);

alter table public.user_last_seen enable row level security;
revoke all on public.user_last_seen from anon, authenticated;
grant all on public.user_last_seen to service_role;

-- "Contacts" = people you currently share a DIRECT chat with.
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
    join public.conversations c on c.id = a.conversation_id
    where c.conversation_type = 'direct'
      and a.user_id = p_a and a.left_at is null
      and b.user_id = p_b and b.left_at is null
  );
$$;

-- Throttled heartbeat (at most one write a minute). Stores nothing - and
-- erases the old value - while the user hides their last seen.
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
    delete from public.user_last_seen where user_id = v_me;
    return;
  end if;
  insert into public.user_last_seen as ls (user_id, last_seen_at)
  values (v_me, now())
  on conflict (user_id) do update
    set last_seen_at = excluded.last_seen_at
    where ls.last_seen_at < now() - interval '60 seconds';
end;
$$;

-- Returns null whenever the caller may not see it:
--   * the target hides it ('nobody', or 'contacts' and the caller isn't one)
--   * the caller hides their own (reciprocity, as in WhatsApp)
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
  select last_seen_at into v_at from public.user_last_seen where user_id = p_user_id;
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
    delete from public.user_last_seen where user_id = new.user_id;
  end if;
  return null;
end;
$$;

create trigger user_settings_after_update
  after update of last_seen on public.user_settings
  for each row execute function public.user_settings_after_update();

-- ─────────────────────────────────────────────────────────────────────────────
-- READ RECEIPTS: server-side backstop for the client setting. A user with
-- read receipts off never moves their own read watermark (the app sends
-- 'delivered' instead of 'read' anyway).
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
-- MUTED CONVERSATIONS (per member). 'infinity' = until unmuted.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.conversation_members add column if not exists muted_until timestamptz;

-- p_until: null (or a time in the past) unmutes.
create or replace function public.mute_conversation(p_conversation_id uuid, p_until timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_until timestamptz := case when p_until is null or p_until <= now() then null else p_until end;
begin
  update public.conversation_members
     set muted_until = v_until
   where conversation_id = p_conversation_id
     and user_id = auth.uid()
     and left_at is null;
  if not found then
    raise exception 'not a member' using errcode = '42501';
  end if;
  return v_until;
end;
$$;

-- The caller's active mutes.
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
-- problem must not fail the statement that caused it. Returns the pg_net
-- request id, or null when push isn't configured.
--
-- Reusable from other migrations / RPCs, e.g. for an incoming call:
--   perform public.send_push_event('call', jsonb_build_object('call_id', v_call));
-- send-push understands: message {message_id}, call {call_id},
--                        channel_post {post_id}.
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
  if p_type is null or p_type !~ '^[a-z_]{1,32}$' then
    raise warning '[vero] invalid push type %', p_type;
    return null;
  end if;
  v_url := public.vero_read_secret('project_url');
  v_secret := public.vero_read_secret('push_webhook_secret');
  if v_url is null or v_secret is null
     or v_url !~ '^https?://[^/[:space:]]+/?$'
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

-- Wakes recipients of new text/media messages. Only ids travel; the
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
    and m.created_at > now() - interval '10 minutes'
    and cm.left_at is null
    and cm.user_id <> m.sender_user_id
    and (cm.muted_until is null or cm.muted_until <= now())
    and not exists (
      select 1 from public.blocks b
      where b.blocker_user_id = cm.user_id and b.blocked_user_id = m.sender_user_id
    );
$$;

-- Whom to ring for a call: the callee's active devices while the call is
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

-- Channel posts (007). PL/pgSQL so this migration does not depend on 007;
-- the trigger itself must be created after 007 (see README):
--   create trigger channel_posts_push_after_insert after insert on public.channel_posts
--     for each row execute function public.channel_posts_push_after_insert();
create or replace function public.get_channel_post_push_targets(p_post_id uuid)
returns table (
  device_id    uuid,
  user_id      uuid,
  token        text,
  previews     boolean,
  channel_id   uuid,
  channel_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
    select pt.device_id, pt.user_id, pt.token, coalesce(us.notification_previews, false), ch.id, ch.name
    from public.channel_posts p
    join public.channels ch on ch.id = p.channel_id
    join public.channel_followers f on f.channel_id = p.channel_id and not f.muted
    join public.devices d on d.user_id = f.user_id and d.revoked_at is null
    join public.push_tokens pt on pt.device_id = d.id
    left join public.user_settings us on us.user_id = f.user_id
    where p.id = p_post_id
      and p.created_at > now() - interval '10 minutes'
      and f.user_id is distinct from p.author_id;
end;
$$;

create or replace function public.channel_posts_push_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.send_push_event('channel_post', jsonb_build_object('post_id', new.id));
  return null;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ONLINE PRESENCE (Realtime Presence on private "presence:<user id>" topics)
--   track (write): only the user themself
--   watch (read):  people who share a chat with them, unless blocked, and
--                  only while BOTH have show_online on (reciprocal)
-- Extra policies, so 001's can_use_realtime_topic stays untouched.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.can_use_presence_topic(p_topic text, p_write boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_id     text := split_part(coalesce(p_topic, ''), ':', 2);
  v_target uuid;
begin
  if v_me is null
     or split_part(coalesce(p_topic, ''), ':', 1) <> 'presence'
     or v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_target := v_id::uuid;
  if v_target = v_me then
    return true;
  end if;
  if p_write then
    return false;
  end if;
  if public.is_blocked_between(v_me, v_target) then
    return false;
  end if;
  if not coalesce((select show_online from public.user_settings where user_id = v_target), true)
     or not coalesce((select show_online from public.user_settings where user_id = v_me), true) then
    return false;
  end if;
  return exists (
    select 1
    from public.conversation_members a
    join public.conversation_members b on b.conversation_id = a.conversation_id
    where a.user_id = v_me and a.left_at is null
      and b.user_id = v_target and b.left_at is null
  );
end;
$$;

create policy "vero presence watchers"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'presence'
    and public.can_use_presence_topic((select realtime.topic()), false)
  );

create policy "vero presence trackers"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and public.can_use_presence_topic((select realtime.topic()), true)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- ENCRYPTED BACKUPS: private bucket, one folder per user (<user id>/backup.bin).
-- The blob is encrypted on the device (passphrase and/or recovery key); the
-- server never sees either secret or the backup key.
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
revoke execute on function public.get_channel_post_push_targets(uuid) from public, anon, authenticated;
revoke execute on function public.channel_posts_push_after_insert() from public, anon, authenticated;
revoke execute on function public.can_use_presence_topic(text, boolean) from public, anon, authenticated;

grant execute on function public.touch_last_seen() to authenticated;
grant execute on function public.get_last_seen(uuid) to authenticated;
grant execute on function public.mute_conversation(uuid, timestamptz) to authenticated;
grant execute on function public.get_conversation_mutes() to authenticated;
grant execute on function public.can_use_presence_topic(text, boolean) to authenticated;

grant execute on function public.verify_push_webhook_secret(text) to service_role;
grant execute on function public.get_message_push_targets(uuid) to service_role;
grant execute on function public.get_call_push_targets(uuid, uuid) to service_role;
grant execute on function public.get_channel_post_push_targets(uuid) to service_role;
grant execute on function public.send_push_event(text, jsonb) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('005', 'settings_push_backup') on conflict do nothing;

-- ================= 006_messaging.sql =================
-- ============================================================================
-- Vero Messenger - 006: core messaging features
-- ============================================================================
-- Edits, delete-for-everyone window, forwarding, starred-message sync,
-- pinned / archived chats.
--
-- Security / privacy notes
--   * Edits travel as end-to-end encrypted CONTROL messages. The server only
--     learns a new coarse message_type 'control' (it cannot tell an edit from
--     any other control payload, nor which message was edited). Recipients
--     check sender and 15-minute window on device.
--   * delete_message() keeps its signature; it is replaced to enforce a
--     48-hour window and to ping members' inboxes so chat lists (and devices
--     that don't have the chat open) learn about the deletion.
--   * forward_media() lets a member reuse an encrypted blob they can already
--     download in another conversation they belong to, without re-uploading
--     (only verified 'ready' uploads, see 004_media.sql).
--     The file key never reaches the server; it is re-wrapped inside the new
--     E2EE message. Blobs are reference-counted by storage_object_id (see
--     the cleanup-expired Edge Function).
--   * Stars are synced between a user's OWN devices as encrypted
--     self_sync_events (ciphertext addressed to the user's devices only), so
--     the server learns neither which messages are starred nor even that an
--     event is about stars.
--   * Pin / archive state lives in conversation_prefs (own rows only) rather
--     than on conversation_members, whose rows are readable by every
--     co-member: whether you pinned or archived a chat is nobody else's
--     business. Writes go through pin_conversation() / archive_conversation().
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- MESSAGE TYPE: add 'control' (edits and other encrypted control payloads)
-- ─────────────────────────────────────────────────────────────────────────────
-- 001 created an unnamed CHECK. Drop whichever message_type CHECK exists and
-- recreate it, keeping every value already allowed (another migration may
-- have added some) plus 'control'.

do $$
declare
  r       record;
  v_types text[] := array['text', 'media', 'reaction', 'system'];
begin
  for r in
    select c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.conrelid = 'public.messages'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%message_type%'
  loop
    v_types := v_types || array(select m[1] from regexp_matches(r.def, '''([a-z_]+)''', 'g') as m);
    execute format('alter table public.messages drop constraint %I', r.conname);
  end loop;
  v_types := array(select distinct t from unnest(v_types || array['control']) as t order by t);
  execute format(
    'alter table public.messages add constraint messages_message_type_check check (message_type = any (%L::text[]))',
    v_types);
end;
$$;

-- Control messages carry everything inside the ciphertext.
create or replace function public.messages_control_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.message_type = 'control'
     and (new.media_id is not null or new.reply_to_message_id is not null) then
    raise exception 'control messages cannot reference media or replies' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger messages_control_check
  before insert on public.messages
  for each row execute function public.messages_control_check();

-- Devices that were offline catch up on deletions with
-- "deleted_at > <last sync>" (RLS limits it to their conversations).
create index messages_deleted_idx on public.messages (deleted_at) where deleted_at is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- DELETE FOR EVERYONE (48-hour window)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.delete_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg public.messages;
begin
  select * into v_msg
  from public.messages
  where id = p_message_id
    and sender_user_id = auth.uid()
    and deleted_at is null
  for update;

  if not found then
    raise exception 'message not found' using errcode = 'P0002';
  end if;

  if v_msg.created_at < now() - interval '48 hours' then
    raise exception 'messages can only be deleted for everyone within 48 hours' using errcode = '22023';
  end if;

  update public.messages
     set deleted_at = now(), ciphertext = '', expires_at = null
   where id = p_message_id;

  if v_msg.media_id is not null then
    update public.media set deleted_at = now() where id = v_msg.media_id and deleted_at is null;
  end if;

  perform realtime.send(jsonb_build_object('id', p_message_id, 'conversation_id', v_msg.conversation_id),
                        'message.deleted', 'conversation:' || v_msg.conversation_id::text, true);

  -- Chats that aren't open (and the sender's other devices) update their lists.
  perform realtime.send(
    jsonb_build_object('conversation_id', v_msg.conversation_id, 'message_id', p_message_id),
    'inbox.deleted',
    'user:' || cm.user_id::text,
    true
  )
  from public.conversation_members cm
  where cm.conversation_id = v_msg.conversation_id and cm.left_at is null;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- FORWARDING MEDIA WITHOUT RE-UPLOAD
-- ─────────────────────────────────────────────────────────────────────────────
-- Creates a media row in p_conversation_id that points at the same encrypted
-- blob. Allowed only when the caller can already download the source (member
-- of its conversation, attached to a live message) and is a member of the
-- target. The new row is owned by the caller, so the usual
-- messages_before_insert check (media uploaded by the sender, same
-- conversation) applies unchanged.

create or replace function public.forward_media(p_media_id uuid, p_conversation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_src    public.media;
  v_recent integer;
  v_id     uuid;
begin
  if v_me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select * into v_src from public.media where id = p_media_id;
  -- Same error for "missing" and "not yours" so ids can't be probed.
  if not found
     or v_src.deleted_at is not null
     or v_src.upload_status <> 'ready'
     or not public.is_conversation_member(v_src.conversation_id)
     or not exists (
       select 1 from public.messages msg
       where msg.media_id = p_media_id
         and msg.conversation_id = v_src.conversation_id
         and msg.deleted_at is null
         and (msg.expires_at is null or msg.expires_at > now())
     ) then
    raise exception 'media not found' using errcode = 'P0002';
  end if;

  if not public.is_conversation_member(p_conversation_id) then
    raise exception 'not a member of the target conversation' using errcode = '42501';
  end if;

  select count(*) into v_recent
  from public.media
  where uploader_id = v_me and created_at > now() - interval '1 minute';
  if v_recent >= 60 then
    raise exception 'too many attachments, slow down' using errcode = '54000';
  end if;

  -- Same verified blob (004: size + hash were checked when it was uploaded), so
  -- the new row is 'ready' immediately.
  insert into public.media (conversation_id, uploader_id, storage_object_id, encrypted_size, encrypted_hash,
                            upload_status, confirmed_at)
  values (p_conversation_id, v_me, v_src.storage_object_id, v_src.encrypted_size, v_src.encrypted_hash,
          'ready', now())
  returning id into v_id;

  return v_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENCRYPTED SYNC BETWEEN A USER'S OWN DEVICES (stars, ...)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.self_sync_events (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  sender_device_id uuid not null references public.devices (id) on delete cascade,
  -- Envelope addressed to the user's own devices only (opaque to the server).
  ciphertext       text not null check (char_length(ciphertext) between 1 and 65536),
  created_at       timestamptz not null default now()
);

create index self_sync_events_user_created_idx on public.self_sync_events (user_id, created_at);

alter table public.self_sync_events enable row level security;

create policy "users read their own sync events"
  on public.self_sync_events for select to authenticated
  using (user_id = (select auth.uid()));

create policy "users write their own sync events"
  on public.self_sync_events for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "users delete their own sync events"
  on public.self_sync_events for delete to authenticated
  using (user_id = (select auth.uid()));

revoke update on public.self_sync_events from anon, authenticated;
revoke all on public.self_sync_events from anon;

create or replace function public.self_sync_events_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner  uuid;
  v_recent integer;
begin
  select user_id into v_owner
  from public.devices
  where id = new.sender_device_id and revoked_at is null;

  if v_owner is null or v_owner is distinct from auth.uid() then
    raise exception 'sender device is not registered to this user' using errcode = '42501';
  end if;

  new.user_id    := v_owner;
  new.created_at := now();

  select count(*) into v_recent
  from public.self_sync_events
  where user_id = v_owner and created_at > now() - interval '1 minute';
  if v_recent >= 120 then
    raise exception 'too many sync events, slow down' using errcode = '54000';
  end if;

  return new;
end;
$$;

create trigger self_sync_events_before_insert
  before insert on public.self_sync_events
  for each row execute function public.self_sync_events_before_insert();

create or replace function public.self_sync_events_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(jsonb_build_object('id', new.id), 'self.sync', 'user:' || new.user_id::text, true);
  return null;
end;
$$;

create trigger self_sync_events_after_insert
  after insert on public.self_sync_events
  for each row execute function public.self_sync_events_after_insert();

-- Old sync events are dropped; a device offline for longer gets the state
-- through device transfer instead.
create or replace function public.cleanup_self_sync_events()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.self_sync_events where created_at < now() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PINNED / ARCHIVED CHATS (private per-user state)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.conversation_prefs (
  user_id         uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  pinned_at       timestamptz,
  archived_at     timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (user_id, conversation_id),
  check (pinned_at is null or archived_at is null)
);

create index conversation_prefs_pinned_idx on public.conversation_prefs (user_id) where pinned_at is not null;

alter table public.conversation_prefs enable row level security;

create policy "users read their own chat preferences"
  on public.conversation_prefs for select to authenticated
  using (user_id = (select auth.uid()));

-- Writes go through pin_conversation() / archive_conversation().
revoke insert, update, delete on public.conversation_prefs from anon, authenticated;
revoke all on public.conversation_prefs from anon;

create or replace function public.pinned_conversation_limit()
returns integer
language sql
immutable
set search_path = ''
as $$ select 3 $$;

create or replace function public.pin_conversation(p_conversation_id uuid, p_pinned boolean)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_pinned integer;
  v_row    public.conversation_prefs;
begin
  if v_me is null or not public.is_conversation_member(p_conversation_id) then
    raise exception 'not a member of this conversation' using errcode = '42501';
  end if;

  -- Serialise this user's pin changes so two devices can't both take the last slot.
  perform pg_advisory_xact_lock(hashtextextended('vero.pin:' || v_me::text, 0));

  if coalesce(p_pinned, false) then
    select count(*) into v_pinned
    from public.conversation_prefs p
    join public.conversation_members cm
      on cm.conversation_id = p.conversation_id and cm.user_id = p.user_id and cm.left_at is null
    where p.user_id = v_me
      and p.pinned_at is not null
      and p.conversation_id <> p_conversation_id;
    if v_pinned >= public.pinned_conversation_limit() then
      raise exception 'you can pin up to % chats', public.pinned_conversation_limit() using errcode = '23514';
    end if;

    insert into public.conversation_prefs as p (user_id, conversation_id, pinned_at, archived_at)
    values (v_me, p_conversation_id, now(), null)
    on conflict (user_id, conversation_id) do update
      set pinned_at   = coalesce(p.pinned_at, now()),
          archived_at = null,
          updated_at  = now()
    returning * into v_row;
  else
    update public.conversation_prefs
       set pinned_at = null, updated_at = now()
     where user_id = v_me and conversation_id = p_conversation_id
    returning * into v_row;
  end if;

  perform realtime.send(
    jsonb_build_object('conversation_id', p_conversation_id, 'pinned_at', v_row.pinned_at,
                       'archived_at', v_row.archived_at),
    'prefs.changed', 'user:' || v_me::text, true);

  return v_row.pinned_at;
end;
$$;

-- Archiving also unpins. Allowed for chats you have left, too.
create or replace function public.archive_conversation(p_conversation_id uuid, p_archived boolean)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.conversation_prefs;
begin
  if v_me is null or not exists (
    select 1 from public.conversation_members
    where conversation_id = p_conversation_id and user_id = v_me
  ) then
    raise exception 'not a member of this conversation' using errcode = '42501';
  end if;

  if coalesce(p_archived, false) then
    insert into public.conversation_prefs as p (user_id, conversation_id, pinned_at, archived_at)
    values (v_me, p_conversation_id, null, now())
    on conflict (user_id, conversation_id) do update
      set archived_at = coalesce(p.archived_at, now()),
          pinned_at   = null,
          updated_at  = now()
    returning * into v_row;
  else
    update public.conversation_prefs
       set archived_at = null, updated_at = now()
     where user_id = v_me and conversation_id = p_conversation_id
    returning * into v_row;
  end if;

  perform realtime.send(
    jsonb_build_object('conversation_id', p_conversation_id, 'pinned_at', v_row.pinned_at,
                       'archived_at', v_row.archived_at),
    'prefs.changed', 'user:' || v_me::text, true);

  return v_row.archived_at;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Function privileges
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function public.messages_control_check() from public, anon, authenticated;
revoke execute on function public.self_sync_events_before_insert() from public, anon, authenticated;
revoke execute on function public.self_sync_events_after_insert() from public, anon, authenticated;
revoke execute on function public.cleanup_self_sync_events() from public, anon, authenticated;
revoke execute on function public.delete_message(uuid) from public, anon;
revoke execute on function public.forward_media(uuid, uuid) from public, anon;
revoke execute on function public.pin_conversation(uuid, boolean) from public, anon;
revoke execute on function public.archive_conversation(uuid, boolean) from public, anon;
revoke execute on function public.pinned_conversation_limit() from public, anon;

grant execute on function public.delete_message(uuid) to authenticated;
grant execute on function public.forward_media(uuid, uuid) to authenticated;
grant execute on function public.pin_conversation(uuid, boolean) to authenticated;
grant execute on function public.archive_conversation(uuid, boolean) to authenticated;
grant execute on function public.pinned_conversation_limit() to authenticated;
grant execute on function public.cleanup_self_sync_events() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vero-cleanup-self-sync', '17 3 * * *', 'select public.cleanup_self_sync_events()');
  end if;
end;
$$;

insert into supabase_migrations.schema_migrations (version, name) values ('006', 'messaging') on conflict do nothing;

-- ================= 007_groups_channels.sql =================
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
--   * realtime topics `channel:<id>` and `group:<id>` authorised by NEW
--     policies on realtime.messages (policies are OR-ed with 001's).
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

  perform realtime.send(to_jsonb(v_row), 'group.event', 'group:' || p_conversation_id::text, true);
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

  -- Lets open chats refresh their header (name) via the existing handler.
  perform realtime.send(jsonb_build_object('conversation_id', p_conversation_id),
                        'members.changed', 'conversation:' || p_conversation_id::text, true);
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

  perform realtime.send(jsonb_build_object('conversation_id', p_conversation_id),
                        'members.changed', 'conversation:' || p_conversation_id::text, true);
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
  elsif coalesce(current_setting('vero.deleting_channel', true), '') <> old.channel_id::text then
    -- (skipped when the whole channel is being deleted: one channel.deleted suffices)
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
  perform set_config('vero.deleting_channel', p_channel_id::text, true);
  delete from public.channels where id = p_channel_id;
  perform set_config('vero.deleting_channel', '', true);
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

-- ── Realtime: channel:<id> (readers receive, admins send) and group:<id>
--    (current members receive group events; only the server sends) ──────────

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
  if v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if v_kind = 'channel' then
    if p_write then
      return public.is_channel_admin(v_id::uuid);
    end if;
    return public.can_read_channel(v_id::uuid);
  elsif v_kind = 'group' then
    return not p_write and public.is_conversation_member(v_id::uuid);
  end if;
  return false;
end;
$$;

create policy "vero channel and group topics receive realtime"
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

insert into supabase_migrations.schema_migrations (version, name) values ('007', 'groups_channels') on conflict do nothing;

-- ================= 008_stories.sql =================
-- ============================================================================
-- Vero Messenger - Stories / Status (end-to-end encrypted, 24 hours)
-- ============================================================================
-- Security model
--   * A story is encrypted on the author's device exactly like a message
--     (src/core/crypto/primitives.ts envelope v2, bound to
--     "story:<authorId>|<storyId>|<authorDeviceId>"). The server stores:
--       stories.ciphertext          envelope body + the AUTHOR's own device slots
--       story_recipients.key_slots  the content-key slots for ONE recipient's devices
--     so each recipient only ever downloads their own key slots.
--   * The audience is resolved on the author's device at post time (from the
--     synced story_privacy setting) and must be the author's contacts (people
--     they share an active, unblocked direct chat with). post_story() drops
--     anyone else.
--   * RLS: a story row is readable only by its author and its recipients and
--     only until it expires. Views are visible only to the author.
--   * Encrypted media lives in the private `vero-stories` Storage bucket under
--     <authorId>/<storyId>/<uuid>.bin; storage policies reuse the same story
--     authorisation. Expired/deleted stories flag their blob in
--     story_media_trash; the `stories-cleanup` Edge Function removes them.
--   * Realtime: recipients get a content-free `story.new` ping on their
--     private user:<id> topic.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- STORY PRIVACY (synced per-user setting; own row only)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.story_privacy (
  user_id        uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  audience       text not null default 'contacts'
                 check (audience in ('contacts', 'contacts_except', 'only')),
  except_user_ids uuid[] not null default '{}' check (cardinality(except_user_ids) <= 2000),
  only_user_ids   uuid[] not null default '{}' check (cardinality(only_user_ids) <= 2000),
  -- Authors whose stories this user has muted (sorted to the bottom of the tray).
  muted_user_ids  uuid[] not null default '{}' check (cardinality(muted_user_ids) <= 2000),
  updated_at     timestamptz not null default now()
);

create trigger story_privacy_updated_at
  before update on public.story_privacy
  for each row execute function public.set_updated_at();

alter table public.story_privacy enable row level security;

create policy "users manage their own story privacy"
  on public.story_privacy for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.story_privacy from anon, authenticated;
grant select, insert, update, delete on public.story_privacy to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- STORIES, RECIPIENTS, VIEWS
-- ─────────────────────────────────────────────────────────────────────────────

create table public.stories (
  -- Client-generated: the id is bound into the envelope's associated data.
  id               uuid primary key,
  author_id        uuid not null references public.profiles (id) on delete cascade,
  author_device_id uuid not null references public.devices (id) on delete cascade,
  -- Coarse type only; text vs photo vs video, colours, captions are encrypted.
  story_type       text not null check (story_type in ('text', 'media')),
  ciphertext       text not null check (char_length(ciphertext) between 1 and 65536),
  media_path       text check (media_path is null or char_length(media_path) <= 200),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default (now() + interval '24 hours'),
  check (expires_at > created_at and expires_at <= created_at + interval '24 hours'),
  check ((story_type = 'media') = (media_path is not null))
);

create index stories_author_idx on public.stories (author_id, created_at desc);
create index stories_expiry_idx on public.stories (expires_at);
create unique index stories_media_path_idx on public.stories (media_path) where media_path is not null;

create table public.story_recipients (
  story_id     uuid not null references public.stories (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  -- deviceId -> base64(boxNonce || box(contentKey || binding)) for THIS recipient's devices
  key_slots    jsonb not null
               check (jsonb_typeof(key_slots) = 'object' and pg_column_size(key_slots) <= 16384),
  primary key (story_id, recipient_id)
);

create index story_recipients_recipient_idx on public.story_recipients (recipient_id);

create table public.story_views (
  story_id  uuid not null references public.stories (id) on delete cascade,
  viewer_id uuid not null references public.profiles (id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer_id)
);

-- Blobs waiting to be removed from the `vero-stories` bucket.
create table public.story_media_trash (
  object_path text primary key,
  flagged_at  timestamptz not null default now()
);

-- ── Helpers (SECURITY DEFINER so policies never recurse) ────────────────────

-- Caller authored this story and it has not expired.
create or replace function public.is_story_author(p_story_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.stories
    where id = p_story_id and author_id = auth.uid() and expires_at > now()
  );
$$;

-- Caller is in the story's audience, it has not expired, and neither side has
-- blocked the other since it was posted.
create or replace function public.is_story_recipient(p_story_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.story_recipients r
    join public.stories s on s.id = r.story_id
    where r.story_id = p_story_id
      and r.recipient_id = auth.uid()
      and s.expires_at > now()
      and not public.is_blocked_between(s.author_id, r.recipient_id)
  );
$$;

-- "Contacts" for stories = people sharing an active, unblocked direct chat.
-- Internal only (not granted): it would otherwise reveal who talks to whom.
create or replace function public.are_story_contacts(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select a <> b
     and not public.is_blocked_between(a, b)
     and exists (
       select 1
       from public.conversations c
       join public.conversation_members ma on ma.conversation_id = c.id and ma.user_id = a and ma.left_at is null
       join public.conversation_members mb on mb.conversation_id = c.id and mb.user_id = b and mb.left_at is null
       where c.conversation_type = 'direct'
     );
$$;

alter table public.stories enable row level security;
alter table public.story_recipients enable row level security;
alter table public.story_views enable row level security;
alter table public.story_media_trash enable row level security;

create policy "authors and recipients read live stories"
  on public.stories for select to authenticated
  using (
    (author_id = (select auth.uid()) and expires_at > now())
    or public.is_story_recipient(id)
  );

create policy "recipients read their own key slots; authors read the audience"
  on public.story_recipients for select to authenticated
  using (
    (recipient_id = (select auth.uid()) and public.is_story_recipient(story_id))
    or public.is_story_author(story_id)
  );

create policy "only the author sees who viewed a story"
  on public.story_views for select to authenticated
  using (public.is_story_author(story_id));

-- Every write goes through the RPCs below; the trash is service-role only.
revoke all on public.stories from anon, authenticated;
revoke all on public.story_recipients from anon, authenticated;
revoke all on public.story_views from anon, authenticated;
revoke all on public.story_media_trash from anon, authenticated;
grant select on public.stories to authenticated;
grant select on public.story_recipients to authenticated;
grant select on public.story_views to authenticated;
grant select, insert, delete on public.story_media_trash to service_role;

-- ── Realtime ping (no content) to every recipient ───────────────────────────

create or replace function public.story_recipients_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author uuid;
begin
  select author_id into v_author from public.stories where id = new.story_id;
  perform realtime.send(
    jsonb_build_object('story_id', new.story_id, 'author_id', v_author),
    'story.new',
    'user:' || new.recipient_id::text,
    true
  );
  return null;
end;
$$;

create trigger story_recipients_after_insert
  after insert on public.story_recipients
  for each row execute function public.story_recipients_after_insert();

-- ─────────────────────────────────────────────────────────────────────────────
-- RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- Active device keys of the caller and of the given users who are the caller's
-- story contacts: the devices a new story's content key is wrapped for.
create or replace function public.get_story_audience_devices(p_user_ids uuid[])
returns table (device_id uuid, user_id uuid, identity_public_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.user_id, d.identity_public_key
  from public.devices d
  where d.revoked_at is null
    and auth.uid() is not null
    and cardinality(coalesce(p_user_ids, '{}')) <= 2000
    and (
      d.user_id = auth.uid()
      or (d.user_id = any (p_user_ids) and public.are_story_contacts(auth.uid(), d.user_id))
    );
$$;

-- Posts a story. p_recipients = [{ "user_id": uuid, "key_slots": { deviceId: slot } }].
-- Recipients who are not the caller's contacts (or are blocked) are dropped.
-- Returns the number of recipients accepted.
create or replace function public.post_story(
  p_story_id   uuid,
  p_device_id  uuid,
  p_story_type text,
  p_ciphertext text,
  p_media_path text,
  p_recipients jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_count integer;
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_story_id is null then
    raise exception 'story id required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.devices where id = p_device_id and user_id = v_me and revoked_at is null
  ) then
    raise exception 'device is not registered to this user' using errcode = '42501';
  end if;
  if p_story_type not in ('text', 'media') then
    raise exception 'invalid story type' using errcode = '22023';
  end if;
  if p_story_type = 'media' and (
       p_media_path is null
       or p_media_path !~ ('^' || v_me::text || '/' || p_story_id::text
                           || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$')
     ) then
    raise exception 'media must be uploaded under <you>/<story>/' using errcode = '22023';
  end if;
  if p_story_type = 'text' and p_media_path is not null then
    raise exception 'text stories have no media' using errcode = '22023';
  end if;
  if p_recipients is null or jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) > 2000 then
    raise exception 'invalid recipients' using errcode = '22023';
  end if;

  insert into public.stories (id, author_id, author_device_id, story_type, ciphertext, media_path)
  values (p_story_id, v_me, p_device_id, p_story_type, p_ciphertext, p_media_path);

  with parsed as (
    select case when e ->> 'user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (e ->> 'user_id')::uuid end as user_id,
           e -> 'key_slots' as key_slots
    from jsonb_array_elements(p_recipients) as e
    where jsonb_typeof(e) = 'object'
  ),
  valid as (
    select distinct on (user_id) user_id, key_slots
    from parsed
    where user_id is not null
      and jsonb_typeof(key_slots) = 'object'
      and key_slots <> '{}'::jsonb
      and public.are_story_contacts(v_me, user_id)
  )
  insert into public.story_recipients (story_id, recipient_id, key_slots)
  select p_story_id, user_id, key_slots from valid;
  get diagnostics v_count = row_count;

  -- Let the author's other devices refresh too.
  perform realtime.send(jsonb_build_object('story_id', p_story_id, 'author_id', v_me),
                        'story.new', 'user:' || v_me::text, true);
  return v_count;
end;
$$;

-- Records that the caller viewed a story (the client skips this when the
-- user has turned read receipts off). Idempotent; pings the author.
create or replace function public.mark_story_viewed(p_story_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author uuid;
begin
  if public.is_story_author(p_story_id) then
    return;
  end if;
  if not public.is_story_recipient(p_story_id) then
    raise exception 'story not found' using errcode = 'P0002';
  end if;

  insert into public.story_views (story_id, viewer_id)
  values (p_story_id, auth.uid())
  on conflict (story_id, viewer_id) do nothing;

  if found then
    select author_id into v_author from public.stories where id = p_story_id;
    perform realtime.send(jsonb_build_object('story_id', p_story_id, 'viewer_id', auth.uid()),
                          'story.viewed', 'user:' || v_author::text, true);
  end if;
end;
$$;

-- Author deletes a story early. Its blob is flagged for removal and the
-- audience is told to drop it.
create or replace function public.delete_story(p_story_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_media      text;
  v_recipients uuid[];
begin
  select coalesce(array_agg(recipient_id), '{}') into v_recipients
  from public.story_recipients
  where story_id = p_story_id
    and exists (select 1 from public.stories where id = p_story_id and author_id = auth.uid());

  delete from public.stories
  where id = p_story_id and author_id = auth.uid()
  returning media_path into v_media;

  if not found then
    raise exception 'story not found' using errcode = 'P0002';
  end if;

  if v_media is not null then
    insert into public.story_media_trash (object_path) values (v_media)
    on conflict (object_path) do nothing;
  end if;

  perform realtime.send(jsonb_build_object('story_id', p_story_id),
                        'story.deleted', 'user:' || r::text, true)
  from unnest(v_recipients || auth.uid()) as r;
end;
$$;

-- Hard-deletes expired stories (recipients and views cascade), flags their
-- blobs, and flags orphaned uploads (never attached to a story) older than a
-- day. Scheduled below with pg_cron; the stories-cleanup function removes blobs.
create or replace function public.cleanup_expired_stories()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.story_media_trash (object_path)
  select media_path from public.stories
  where expires_at <= now() and media_path is not null
  on conflict (object_path) do nothing;

  delete from public.stories where expires_at <= now();
  get diagnostics v_count = row_count;

  if to_regclass('storage.objects') is not null then
    execute $q$
      insert into public.story_media_trash (object_path)
      select o.name from storage.objects o
      where o.bucket_id = 'vero-stories'
        and o.created_at < now() - interval '25 hours'
        and not exists (select 1 from public.stories s where s.media_path = o.name)
      on conflict (object_path) do nothing
    $q$;
  end if;

  return v_count;
end;
$$;

-- ── Storage authorisation helpers (used by the bucket policies below) ───────

-- Authors upload only into their own folder: <me>/<storyId>/<uuid>.bin
create or replace function public.can_upload_story_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and p_name ~ ('^' || auth.uid()::text
                   || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                   || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$');
$$;

-- Same audience as the story row itself.
create or replace function public.can_read_story_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.stories s
    where s.media_path = p_name
      and (public.is_story_author(s.id) or public.is_story_recipient(s.id))
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Function privileges
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function public.is_story_author(uuid) from public, anon, authenticated;
revoke execute on function public.is_story_recipient(uuid) from public, anon, authenticated;
revoke execute on function public.are_story_contacts(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.story_recipients_after_insert() from public, anon, authenticated;
revoke execute on function public.get_story_audience_devices(uuid[]) from public, anon, authenticated;
revoke execute on function public.post_story(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.mark_story_viewed(uuid) from public, anon, authenticated;
revoke execute on function public.delete_story(uuid) from public, anon, authenticated;
revoke execute on function public.cleanup_expired_stories() from public, anon, authenticated;
revoke execute on function public.can_upload_story_object(text) from public, anon, authenticated;
revoke execute on function public.can_read_story_object(text) from public, anon, authenticated;

grant execute on function public.is_story_author(uuid) to authenticated;
grant execute on function public.is_story_recipient(uuid) to authenticated;
grant execute on function public.get_story_audience_devices(uuid[]) to authenticated;
grant execute on function public.post_story(uuid, uuid, text, text, text, jsonb) to authenticated;
grant execute on function public.mark_story_viewed(uuid) to authenticated;
grant execute on function public.delete_story(uuid) to authenticated;
grant execute on function public.can_upload_story_object(text) to authenticated;
grant execute on function public.can_read_story_object(text) to authenticated;
grant execute on function public.cleanup_expired_stories() to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEDULED CLEANUP (only if pg_cron is enabled on the project)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vero-cleanup-stories', '*/10 * * * *', 'select public.cleanup_expired_stories()');
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRIVATE BUCKET for encrypted story media + policies (Supabase only)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('vero-stories', 'vero-stories', false)
    on conflict (id) do nothing;

    if exists (select 1 from information_schema.columns
               where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
      execute $q$update storage.buckets set file_size_limit = 52428800 where id = 'vero-stories'$q$;
    end if;
  end if;

  if to_regclass('storage.objects') is not null then
    execute $q$drop policy if exists "vero story authors upload encrypted media" on storage.objects$q$;
    execute $q$drop policy if exists "vero story audience downloads encrypted media" on storage.objects$q$;
    execute $q$
      create policy "vero story authors upload encrypted media"
        on storage.objects for insert to authenticated
        with check (bucket_id = 'vero-stories' and public.can_upload_story_object(name))
    $q$;
    execute $q$
      create policy "vero story audience downloads encrypted media"
        on storage.objects for select to authenticated
        using (bucket_id = 'vero-stories' and public.can_read_story_object(name))
    $q$;
  end if;
end;
$$;

insert into supabase_migrations.schema_migrations (version, name) values ('008', 'stories') on conflict do nothing;

-- ================= 009_discovery_linking.sql =================
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

insert into supabase_migrations.schema_migrations (version, name) values ('009', 'discovery_linking') on conflict do nothing;

-- ================= 010_stickers_gifs.sql =================
-- ============================================================================
-- Vero Messenger - stickers & GIFs (server side)
-- ============================================================================
-- Stickers need nothing on the server: bundled stickers travel as encrypted
-- {pack, id} references and custom stickers as ordinary encrypted media.
--
-- GIF search runs through the `gif-search` Edge Function so users' IPs and
-- the provider API key never reach Tenor/GIPHY directly. This migration adds:
--   * app_config + get_app_secret(): operator-set configuration (API keys)
--     readable ONLY by the service role. Vault secrets take precedence.
--   * gif_rate_limit_hit(): a per-user fixed-window rate limiter.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- APP CONFIG (shared with 011/012; every statement is idempotent)
--   Set a key:   insert into public.app_config (key, value) values ('TENOR_API_KEY', '...')
--                on conflict (key) do update set value = excluded.value;
--   or Vault:    select vault.create_secret('...', 'TENOR_API_KEY');
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.app_config (
  key        text primary key check (key ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  value      text not null check (char_length(value) <= 4096),
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;
-- No policies: clients can neither read nor write. Only the service role
-- (which bypasses RLS) and SECURITY DEFINER functions below touch it.
revoke all on public.app_config from public, anon, authenticated;
grant select, insert, update, delete on public.app_config to service_role;

drop trigger if exists app_config_updated_at on public.app_config;
create trigger app_config_updated_at
  before update on public.app_config
  for each row execute function public.set_updated_at();

-- Vault (if installed) first, then app_config.
create or replace function public.get_app_secret(p_key text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_value text;
begin
  if p_key is null or p_key !~ '^[A-Z][A-Z0-9_]{1,63}$' then
    return null;
  end if;
  if to_regclass('vault.decrypted_secrets') is not null then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
      into v_value using p_key;
    if v_value is not null and v_value <> '' then
      return v_value;
    end if;
  end if;
  select value into v_value from public.app_config where key = p_key;
  return v_value;
end;
$$;

revoke execute on function public.get_app_secret(text) from public, anon, authenticated;
grant execute on function public.get_app_secret(text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- GIF SEARCH RATE LIMIT (fixed window per user; called by gif-search only)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.gif_search_usage (
  user_id       uuid not null references auth.users (id) on delete cascade,
  window_start  timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (user_id, window_start)
);

alter table public.gif_search_usage enable row level security;
revoke all on public.gif_search_usage from public, anon, authenticated;
grant select, insert, update, delete on public.gif_search_usage to service_role;

-- Counts one request; returns true while the user is within p_limit per window.
create or replace function public.gif_rate_limit_hit(
  p_user_id uuid,
  p_limit integer default 60,
  p_window_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_count  integer;
begin
  if p_user_id is null or p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit arguments' using errcode = '22023';
  end if;

  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.gif_search_usage as u (user_id, window_start, request_count)
  values (p_user_id, v_window, 1)
  on conflict (user_id, window_start)
  do update set request_count = u.request_count + 1
  returning request_count into v_count;

  -- Keep the table small.
  delete from public.gif_search_usage
  where user_id = p_user_id and window_start < v_window - interval '1 day';

  return v_count <= p_limit;
end;
$$;

revoke execute on function public.gif_rate_limit_hit(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.gif_rate_limit_hit(uuid, integer, integer) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('010', 'stickers_gifs') on conflict do nothing;

-- ================= 011_payments.sql =================
-- ============================================================================
-- Vero Messenger - payments (server side)
-- ============================================================================
-- UPI payments need NOTHING on the server: payment cards (amount, note, the
-- payee's UPI id, reference, status updates) travel only inside E2EE
-- messages, and the money moves inside the user's UPI app.
--
-- This migration only supports the OPTIONAL Razorpay Payment Links feature
-- (edge function `payment-link`), which is off unless the operator sets
-- RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET:
--   * payment_link_merchants: accounts allowed to create links. Links collect
--     money into the OPERATOR's Razorpay account, so this is an explicit
--     allow-list managed with the service role (SQL editor), not self-serve.
--   * payment_links: which link belongs to which creator (for status checks
--     and rate limiting). No amounts, notes, VPAs or conversation ids.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- APP CONFIG (identical, idempotent copy of 010 so this file applies on 001 alone)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.app_config (
  key        text primary key check (key ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  value      text not null check (char_length(value) <= 4096),
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;
revoke all on public.app_config from public, anon, authenticated;
grant select, insert, update, delete on public.app_config to service_role;

drop trigger if exists app_config_updated_at on public.app_config;
create trigger app_config_updated_at
  before update on public.app_config
  for each row execute function public.set_updated_at();

create or replace function public.get_app_secret(p_key text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_value text;
begin
  if p_key is null or p_key !~ '^[A-Z][A-Z0-9_]{1,63}$' then
    return null;
  end if;
  if to_regclass('vault.decrypted_secrets') is not null then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
      into v_value using p_key;
    if v_value is not null and v_value <> '' then
      return v_value;
    end if;
  end if;
  select value into v_value from public.app_config where key = p_key;
  return v_value;
end;
$$;

revoke execute on function public.get_app_secret(text) from public, anon, authenticated;
grant execute on function public.get_app_secret(text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- PAYMENT LINK MERCHANTS (who may create Razorpay links)
--   insert into public.payment_link_merchants (user_id) values ('<uuid>');
-- ─────────────────────────────────────────────────────────────────────────────

create table public.payment_link_merchants (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.payment_link_merchants enable row level security;

create policy "users see their own merchant flag"
  on public.payment_link_merchants for select to authenticated
  using (user_id = (select auth.uid()));

revoke insert, update, delete on public.payment_link_merchants from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- PAYMENT LINKS (rows written by the payment-link function, service role)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.payment_links (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid not null references auth.users (id) on delete cascade,
  provider         text not null default 'razorpay' check (provider in ('razorpay')),
  provider_link_id text not null unique check (char_length(provider_link_id) between 1 and 64),
  short_url        text not null check (short_url ~ '^https://' and char_length(short_url) <= 256),
  status           text not null default 'created'
                   check (status in ('created', 'partially_paid', 'paid', 'expired', 'cancelled')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index payment_links_creator_idx on public.payment_links (creator_id, created_at desc);

create trigger payment_links_updated_at
  before update on public.payment_links
  for each row execute function public.set_updated_at();

alter table public.payment_links enable row level security;

create policy "creators see their payment links"
  on public.payment_links for select to authenticated
  using (creator_id = (select auth.uid()));

revoke insert, update, delete on public.payment_links from anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name) values ('011', 'payments') on conflict do nothing;

-- ================= 012_bots.sql =================
-- ============================================================================
-- Vero Messenger - bots & mini-apps
-- ============================================================================
-- A bot is a real Vero account (auth user + profile with is_bot = true) whose
-- process holds its own device key, like any other client. Chats with bots
-- stay end-to-end encrypted: the server never decrypts anything for a bot.
--
--   * Bot accounts are created only by the `bot-admin` Edge Function (service
--     role), which returns the bot's token to its owner exactly once.
--   * profiles.is_bot can't be set by clients (column grants from 001), only
--     by the trigger below when a bots row is created.
--   * Owners edit description / commands / mini-app / webhook / visibility
--     directly (RLS + column grants). The token hash and webhook URL are not
--     readable by other users.
--   * Optional webhook: if pg_net is installed, each new message in a bot's
--     conversation POSTs {conversation_id, message_id} (no content) to the
--     bot's webhook so serverless bots can wake up and fetch + decrypt it.
-- ============================================================================

alter table public.profiles add column if not exists is_bot boolean not null default false;

create table public.bots (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null unique references public.profiles (id) on delete cascade,
  owner_id     uuid not null references auth.users (id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 64),
  description  text check (description is null or char_length(description) <= 512),
  -- [{ "command": "start", "description": "..." }, ...]
  commands     jsonb not null default '[]'::jsonb
               check (jsonb_typeof(commands) = 'array' and jsonb_array_length(commands) <= 50
                      and pg_column_size(commands) <= 16384),
  -- https only, real host names (no IP literals / localhost)
  mini_app_url text check (mini_app_url is null or (
                 char_length(mini_app_url) <= 512
                 and mini_app_url ~ '^https://([a-z0-9-]+\.)+[a-z]{2,63}(:[0-9]{2,5})?(/[^[:space:]]*)?$')),
  webhook_url  text check (webhook_url is null or (
                 char_length(webhook_url) <= 512
                 and webhook_url ~ '^https://([a-z0-9-]+\.)+[a-z]{2,63}(:[0-9]{2,5})?(/[^[:space:]]*)?$')),
  token_hash   text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  is_public    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (user_id <> owner_id)
);

create index bots_owner_idx on public.bots (owner_id);
create index bots_public_idx on public.bots (is_public) where is_public;

create trigger bots_updated_at
  before update on public.bots
  for each row execute function public.set_updated_at();

-- Validates command entries (shape + lengths). Used by a CHECK-like trigger.
create or replace function public.bot_commands_valid(p_commands jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_commands) = 'array'
     and not exists (
       select 1 from jsonb_array_elements(p_commands) c
       where jsonb_typeof(c) <> 'object'
          or coalesce(c ->> 'command', '') !~ '^[a-z0-9_]{1,32}$'
          or char_length(coalesce(c ->> 'description', '')) > 128
     );
$$;

create or replace function public.bots_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.bot_commands_valid(new.commands) then
    raise exception 'invalid bot commands' using errcode = '22023';
  end if;
  if tg_op = 'INSERT' then
    if exists (select 1 from public.profiles where id = new.owner_id and is_bot) then
      raise exception 'bots cannot own bots' using errcode = '42501';
    end if;
    if (select count(*) from public.bots where owner_id = new.owner_id) >= 20 then
      raise exception 'bot limit reached' using errcode = '54000';
    end if;
  end if;
  return new;
end;
$$;

create trigger bots_before_write
  before insert or update on public.bots
  for each row execute function public.bots_before_write();

-- Flags the bot's profile; the only way is_bot ever becomes true.
create or replace function public.bots_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set is_bot = true where id = new.user_id;
  return null;
end;
$$;

create trigger bots_after_insert
  after insert on public.bots
  for each row execute function public.bots_after_insert();

alter table public.bots enable row level security;

create policy "public bots, own bots and bots you chat with are visible"
  on public.bots for select to authenticated
  using (
    is_public
    or owner_id = (select auth.uid())
    or public.has_shared_conversation(user_id)
  );

create policy "owners update their bots"
  on public.bots for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- Rows are created/deleted by bot-admin (service role). Clients read the
-- public columns only, and owners may change the editable ones.
revoke all on public.bots from anon, authenticated;
grant select (id, user_id, owner_id, name, description, commands, mini_app_url, is_public, created_at, updated_at)
  on public.bots to authenticated;
grant update (description, commands, mini_app_url, webhook_url, is_public) on public.bots to authenticated;

-- The owner's own bots including the webhook URL (never the token hash).
create or replace function public.my_bots()
returns table (
  id uuid, user_id uuid, name text, description text, commands jsonb, mini_app_url text,
  webhook_url text, is_public boolean, created_at timestamptz, username text
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.user_id, b.name, b.description, b.commands, b.mini_app_url,
         b.webhook_url, b.is_public, b.created_at, p.username
  from public.bots b
  join public.profiles p on p.id = b.user_id
  where b.owner_id = auth.uid()
  order by b.created_at desc;
$$;

revoke execute on function public.my_bots() from public, anon;
grant execute on function public.my_bots() to authenticated;
revoke execute on function public.bot_commands_valid(jsonb) from public, anon, authenticated;
revoke execute on function public.bots_before_write() from public, anon, authenticated;
revoke execute on function public.bots_after_insert() from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- WEBHOOK WAKE-UPS (only when pg_net is installed; metadata only, no content)
-- A forged ping is harmless: the bot fetches the message with its own
-- credentials and can only decrypt what was really encrypted to its device.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.bots_notify_webhooks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return null;
  end if;
  for r in
    select b.user_id, b.webhook_url
    from public.bots b
    join public.conversation_members cm
      on cm.user_id = b.user_id and cm.conversation_id = new.conversation_id and cm.left_at is null
    where b.webhook_url is not null and b.user_id <> new.sender_user_id
  loop
    execute 'select net.http_post(url := $1, body := $2, params := ''{}''::jsonb, headers := $3, timeout_milliseconds := 5000)'
      using r.webhook_url,
            jsonb_build_object('type', 'message.new', 'bot_user_id', r.user_id,
                               'conversation_id', new.conversation_id, 'message_id', new.id),
            '{"Content-Type": "application/json"}'::jsonb;
  end loop;
  return null;
end;
$$;

revoke execute on function public.bots_notify_webhooks() from public, anon, authenticated;

create trigger messages_notify_bot_webhooks
  after insert on public.messages
  for each row execute function public.bots_notify_webhooks();

insert into supabase_migrations.schema_migrations (version, name) values ('012', 'bots') on conflict do nothing;

-- ================= 090_cross_feature_wiring.sql =================
-- ============================================================================
-- Cross-feature wiring that has to run after every feature migration.
-- Each feature migration applies on top of 001 alone, so anything that links
-- two features (e.g. 005's push sender with 007's channel posts) lives here.
-- ============================================================================

-- Push notifications for new channel posts (function defined in 005, table in 007).
drop trigger if exists channel_posts_push_after_insert on public.channel_posts;
create trigger channel_posts_push_after_insert
  after insert on public.channel_posts
  for each row execute function public.channel_posts_push_after_insert();

-- ── Calls (002) x push (005) ────────────────────────────────────────────────
-- Call push targets now cover 002's group calls: every current member of the
-- group except the caller, people already in the call, members who muted the
-- group, and anyone blocking / blocked by the caller. 1:1 calls are unchanged
-- (the callee's devices while ringing).
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
    and not cs.is_group
    and cs.status = 'ringing'
    and cs.created_at > now() - interval '2 minutes'
    and (p_requester is null or cs.caller_id = p_requester)
    and not exists (
      select 1 from public.blocks b
      where b.blocker_user_id = cs.callee_id and b.blocked_user_id = cs.caller_id
    )
  union all
  select pt.device_id, pt.user_id, pt.token,
         coalesce(us.notification_previews, false),
         cp.display_name, cs.conversation_id, cs.id, cs.call_type
  from public.call_sessions cs
  join public.profiles cp on cp.id = cs.caller_id
  join public.conversation_members cm
    on cm.conversation_id = cs.conversation_id
   and cm.left_at is null
   and cm.user_id <> cs.caller_id
   and (cm.muted_until is null or cm.muted_until <= now())
  join public.devices d on d.user_id = cm.user_id and d.revoked_at is null
  join public.push_tokens pt on pt.device_id = d.id
  left join public.user_settings us on us.user_id = cm.user_id
  where cs.id = p_call_id
    and cs.is_group
    and cs.status = 'active'
    and cs.created_at > now() - interval '2 minutes'
    and (p_requester is null or cs.caller_id = p_requester)
    and not public.is_blocked_between(cs.caller_id, cm.user_id)
    and not exists (
      select 1 from public.call_participants p
      where p.call_id = cs.id and p.user_id = cm.user_id and p.left_at is null
    );
$$;

revoke execute on function public.get_call_push_targets(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_call_push_targets(uuid, uuid) to service_role;

-- New calls ring from the database when push is configured (pg_net + Vault,
-- see 005). push_sent_at tells the caller's app it needn't ask send-push itself.
create or replace function public.call_sessions_push_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.send_push_event('call', jsonb_build_object('call_id', new.id)) is not null then
    update public.call_sessions set push_sent_at = now() where id = new.id;
  end if;
  return null;
end;
$$;

revoke execute on function public.call_sessions_push_after_insert() from public, anon, authenticated;

drop trigger if exists call_sessions_push_after_insert on public.call_sessions;
create trigger call_sessions_push_after_insert
  after insert on public.call_sessions
  for each row execute function public.call_sessions_push_after_insert();

-- ── Blob cleanup functions on a schedule ────────────────────────────────────
-- cleanup-expired (media) and stories-cleanup delete encrypted blobs from
-- Storage. pg_cron calls them through pg_net with the CRON_SECRET kept in
-- Vault (005's project_url + 010's get_app_secret). No-op until both secrets
-- exist, so this is safe to apply before configuration.
create or replace function public.vero_invoke_cleanup_function(p_name text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text := public.vero_read_secret('project_url');
  v_secret text := public.get_app_secret('CRON_SECRET');
  v_id     bigint;
begin
  if p_name not in ('cleanup-expired', 'stories-cleanup') or v_url is null or v_secret is null
     or to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    return null;
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 30000)'
    into v_id
    using rtrim(v_url, '/') || '/functions/v1/' || p_name, '{}'::jsonb,
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret);
  return v_id;
end;
$$;

revoke execute on function public.vero_invoke_cleanup_function(text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vero-blob-cleanup-media', '*/15 * * * *',
                          $c$select public.vero_invoke_cleanup_function('cleanup-expired')$c$);
    perform cron.schedule('vero-blob-cleanup-stories', '*/30 * * * *',
                          $c$select public.vero_invoke_cleanup_function('stories-cleanup')$c$);
  end if;
end;
$$;

insert into supabase_migrations.schema_migrations (version, name) values ('090', 'cross_feature_wiring') on conflict do nothing;

-- Vault secrets used by push notifications and scheduled blob cleanup
select vault.create_secret('https://fihspzqhrvlsfwbkitgm.supabase.co', 'project_url') where not exists (select 1 from vault.secrets where name = 'project_url');
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'CRON_SECRET') where not exists (select 1 from vault.secrets where name = 'CRON_SECRET');

commit;
select 'Vero database setup complete' as status;
