-- Calls: statuses, broadcasts, group-call permissions (002_calls.sql).
-- Run with scripts/test-db.sh.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned
\o /dev/null

create function pg_temp.as_user(p_id uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_id::text, ''), false);
$$;

create function pg_temp.expect_fail(p_sql text, p_like text default '%') returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED FAILURE but statement succeeded: %', p_sql;
exception when others then
  if sqlerrm like 'EXPECTED FAILURE%' then raise; end if;
  if sqlerrm not like p_like then
    raise exception 'failed with the wrong error: % (wanted %)', sqlerrm, p_like;
  end if;
end;
$$;

create function pg_temp.check(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAILED: %', p_name; end if;
  raise notice 'ok - %', p_name;
end;
$$;

set client_min_messages = notice;

\set alice '''aaaaaaaa-0000-4000-8000-000000000001'''
\set bob   '''bbbbbbbb-0000-4000-8000-000000000002'''
\set carol '''cccccccc-0000-4000-8000-000000000003'''
\set dave  '''dddddddd-0000-4000-8000-000000000004'''

insert into auth.users (id, raw_user_meta_data) values
  (:alice, '{"username":"alice","display_name":"Alice"}'),
  (:bob,   '{"username":"bob","display_name":"Bob"}'),
  (:carol, '{"username":"carol"}'),
  (:dave,  '{"username":"dave"}');
-- Eight more people for the group-size limit.
insert into auth.users (id, raw_user_meta_data)
select ('f0000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid,
       jsonb_build_object('username', 'extra' || i)
from generate_series(1, 8) i;

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated, anon, service_role;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;

-- Broadcasts sent since the last checkpoint.
create temp table mark (n bigint);
insert into mark values (0);
grant all on mark to authenticated, service_role;
create function pg_temp.sent(p_event text, p_topic text) returns bigint language sql as $$
  select count(*) from realtime.messages
  where id > (select n from mark) and event = p_event and topic = p_topic
$$;
create function pg_temp.checkpoint() returns void language sql as $$
  update mark set n = (select coalesce(max(id), 0) from realtime.messages)
$$;

set role authenticated;

create function pg_temp.add_device(p_user uuid, p_name text, p_key text) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  with d as (insert into devices (identity_public_key) values (repeat(p_key, 43)) returning id)
  insert into ids select p_name, d.id from d;
end;
$$;

select pg_temp.add_device(:alice, 'alice_dev', 'A');
select pg_temp.add_device(:bob,   'bob_dev1',  'B');
select pg_temp.add_device(:bob,   'bob_dev2',  'b');
select pg_temp.add_device(:carol, 'carol_dev', 'C');
select pg_temp.add_device(:dave,  'dave_dev',  'D');
select pg_temp.add_device(('f0000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'x' || i, chr(64 + 10 + i))
from generate_series(1, 8) i;

select pg_temp.as_user(:alice);
insert into ids values ('dm', create_direct_conversation(:bob));
insert into ids values ('dm_carol', create_direct_conversation(:carol));
insert into ids values ('grp', create_group_conversation('Hikers', array[:bob, :carol]::uuid[]));
insert into ids values ('big', create_group_conversation('Big group',
  array(select ('f0000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid from generate_series(1, 8) i)));

-- ════════════════════════════════════════════════════════════════════════════
-- 1:1 calls
-- ════════════════════════════════════════════════════════════════════════════

select pg_temp.expect_fail(format($$select start_direct_call(%L, 'voice', %L)$$, pg_temp.id('dm'), pg_temp.id('bob_dev1')),
  '%unknown device%');
select pg_temp.check(true, 'cannot start a call from someone else''s device');
select pg_temp.expect_fail(format($$select start_direct_call(%L, 'voice', %L)$$, pg_temp.id('grp'), pg_temp.id('alice_dev')));
select pg_temp.check(true, 'start_direct_call refuses group chats');
select pg_temp.expect_fail(format($$select start_direct_call(%L, 'fax', %L)$$, pg_temp.id('dm'), pg_temp.id('alice_dev')));
select pg_temp.check(true, 'invalid call type is rejected');

select pg_temp.checkpoint();
insert into ids values ('c1', start_direct_call(pg_temp.id('dm'), 'video', pg_temp.id('alice_dev')));
reset role;
select pg_temp.check(pg_temp.sent('call.invite', 'user:' || :bob) = 1, 'invite delivered to the callee''s user topic');
select pg_temp.check(
  (select payload->>'caller_device_id' from realtime.messages where event = 'call.invite' order by id desc limit 1)
    = pg_temp.id('alice_dev')::text,
  'invite names the caller''s device (callee devices seal signalling to it)');
set role authenticated;

select pg_temp.check((select status from call_sessions where id = pg_temp.id('c1')) = 'ringing', 'new call is ringing');
select pg_temp.check((select count(*) from call_participants where call_id = pg_temp.id('c1') and left_at is null) = 1,
  'caller device is recorded as a participant');

-- Outsiders
select pg_temp.as_user(:carol);
select pg_temp.check((select count(*) from call_sessions where id = pg_temp.id('c1')) = 0, 'outsider cannot see the call');
select pg_temp.check((select count(*) from call_participants where call_id = pg_temp.id('c1')) = 0, 'outsider cannot see participants');
select pg_temp.expect_fail(format($$select update_call_status(%L, 'ended')$$, pg_temp.id('c1')), '%not a participant%');
select pg_temp.check(true, 'outsider cannot change the call status');
select pg_temp.expect_fail(format($$select answer_call(%L, %L)$$, pg_temp.id('c1'), pg_temp.id('carol_dev')), '%not the callee%');
select pg_temp.check(true, 'outsider cannot answer');
select pg_temp.check(not can_use_realtime_topic('call:' || pg_temp.id('c1'), false)
  and not can_use_group_call_topic('call:' || pg_temp.id('c1')), 'outsider cannot use the call topic');
select set_config('realtime.topic', 'call:' || pg_temp.id('c1'), false);
select pg_temp.check((select count(*) from realtime.messages) = 0, 'outsider receives nothing on call:<id>');
select pg_temp.expect_fail($$insert into realtime.messages (topic, extension, event, payload) values ('x', 'broadcast', 'signal', '{}')$$);
select pg_temp.check(true, 'outsider cannot broadcast on call:<id>');
select pg_temp.expect_fail(format($$insert into call_participants (call_id, user_id, device_id) values (%L, %L, %L)$$,
  pg_temp.id('c1'), :carol, pg_temp.id('carol_dev')));
select pg_temp.check(true, 'participants cannot be inserted directly');

select pg_temp.as_user(:bob);
select set_config('realtime.topic', 'call:' || pg_temp.id('c1'), false);
select pg_temp.check((select count(*) from realtime.messages) > 0, 'callee may receive on call:<id>');

-- Caller cannot answer / decline its own call.
select pg_temp.as_user(:alice);
select pg_temp.expect_fail(format($$select answer_call(%L, %L)$$, pg_temp.id('c1'), pg_temp.id('alice_dev')), '%not the callee%');
select pg_temp.expect_fail(format($$select update_call_status(%L, 'rejected')$$, pg_temp.id('c1')), '%only the callee%');
select pg_temp.expect_fail(format($$select update_call_status(%L, 'busy')$$, pg_temp.id('c1')), '%only the callee%');
select pg_temp.check(true, 'caller cannot answer, decline or report busy');

-- First device wins.
select pg_temp.as_user(:bob);
select pg_temp.expect_fail(format($$select update_call_status(%L, 'cancelled')$$, pg_temp.id('c1')), '%only the caller%');
select pg_temp.check(true, 'callee cannot "cancel"');
select pg_temp.checkpoint();
select pg_temp.check(answer_call(pg_temp.id('c1'), pg_temp.id('bob_dev2')), 'first callee device answers');
select pg_temp.check(not answer_call(pg_temp.id('c1'), pg_temp.id('bob_dev1')), 'second callee device loses');
reset role;
select pg_temp.check(pg_temp.sent('call.status', 'user:' || :alice) = 1
  and pg_temp.sent('call.status', 'user:' || :bob) = 1
  and pg_temp.sent('call.status', 'call:' || pg_temp.id('c1')) = 1,
  'answer broadcasts call.status to both users and the call topic');
select pg_temp.check(
  (select payload->>'answered_device_id' from realtime.messages
   where event = 'call.status' and topic = 'user:' || :bob order by id desc limit 1) = pg_temp.id('bob_dev2')::text,
  'status tells the other callee devices which device answered');
set role authenticated;
select pg_temp.check((select status = 'active' and answered_at is not null and answered_device_id = pg_temp.id('bob_dev2')
  from call_sessions where id = pg_temp.id('c1')), 'call is active with the answering device');
select pg_temp.check((select count(*) from call_participants where call_id = pg_temp.id('c1') and left_at is null) = 2,
  'both devices are participants');

select pg_temp.check(call_heartbeat(pg_temp.id('c1'), pg_temp.id('bob_dev2')), 'heartbeat while in the call');
select pg_temp.check(not call_heartbeat(pg_temp.id('c1'), pg_temp.id('bob_dev1')), 'non-participating device gets no heartbeat');

-- "active" again is a no-op; ending from active = ended for both.
select update_call_status(pg_temp.id('c1'), 'active');
select pg_temp.checkpoint();
select update_call_status(pg_temp.id('c1'), 'rejected');
select pg_temp.check((select status from call_sessions where id = pg_temp.id('c1')) = 'ended',
  'anything but failed after answering means ended');
reset role;
select pg_temp.check(pg_temp.sent('call.status', 'user:' || :alice) = 1, 'hang-up is broadcast to the other side');
set role authenticated;
select pg_temp.check((select count(*) from call_participants where call_id = pg_temp.id('c1') and left_at is null) = 0,
  'participants are closed when the call ends');
select pg_temp.as_user(:alice);
select pg_temp.checkpoint();
select update_call_status(pg_temp.id('c1'), 'missed');
select pg_temp.check((select status from call_sessions where id = pg_temp.id('c1')) = 'ended', 'terminal status is final');
reset role;
select pg_temp.check(pg_temp.sent('call.status', 'user:' || :bob) = 0, 'no broadcast for ignored updates');
set role authenticated;

-- Cancel before answer: callee gets a missed call (status cancelled).
select pg_temp.as_user(:alice);
insert into ids values ('c2', start_direct_call(pg_temp.id('dm'), 'voice', pg_temp.id('alice_dev')));
select pg_temp.checkpoint();
select update_call_status(pg_temp.id('c2'), 'cancelled');
reset role;
select pg_temp.check(pg_temp.sent('call.status', 'user:' || :bob) = 1, 'cancel reaches the ringing callee instantly');
set role authenticated;
select pg_temp.as_user(:bob);
select pg_temp.check((select status from call_sessions where id = pg_temp.id('c2')) = 'cancelled',
  'callee history shows the cancelled call');
select pg_temp.check(not answer_call(pg_temp.id('c2'), pg_temp.id('bob_dev1')), 'a cancelled call cannot be answered');

-- Decline / "ended" while ringing = rejected; busy.
select pg_temp.as_user(:alice);
insert into ids values ('c3', start_direct_call(pg_temp.id('dm'), 'voice', pg_temp.id('alice_dev')));
insert into ids values ('c4', start_direct_call(pg_temp.id('dm'), 'voice', pg_temp.id('alice_dev')));
insert into ids values ('c5', start_direct_call(pg_temp.id('dm'), 'voice', pg_temp.id('alice_dev')));
select pg_temp.as_user(:bob);
select update_call_status(pg_temp.id('c3'), 'ended');
select update_call_status(pg_temp.id('c4'), 'busy');
select update_call_status(pg_temp.id('c5'), 'rejected');
select pg_temp.as_user(:alice);
select pg_temp.check((select status from call_sessions where id = pg_temp.id('c3')) = 'rejected', 'callee hang-up while ringing = rejected');
select pg_temp.check((select status from call_sessions where id = pg_temp.id('c4')) = 'busy', 'busy is recorded');
select pg_temp.check((select status from call_sessions where id = pg_temp.id('c5')) = 'rejected', 'decline is recorded');
select pg_temp.check((select count(*) from call_sessions where conversation_id = pg_temp.id('dm')) = 5,
  'caller sees full call history');
select pg_temp.as_user(:bob);
select pg_temp.check((select count(*) from call_sessions where conversation_id = pg_temp.id('dm')) = 5,
  'callee sees full call history');

-- Ring timeout safety net.
select pg_temp.as_user(:alice);
insert into ids values ('c6', start_direct_call(pg_temp.id('dm'), 'voice', pg_temp.id('alice_dev')));
reset role;
update call_sessions set created_at = now() - interval '2 minutes' where id = pg_temp.id('c6');
select pg_temp.checkpoint();
select expire_stale_calls();
select pg_temp.check((select status from call_sessions where id = pg_temp.id('c6')) = 'missed', 'unanswered calls expire as missed');
select pg_temp.check(pg_temp.sent('call.status', 'user:' || :bob) = 1, 'expiry is broadcast');
set role authenticated;

-- Blocked users cannot call.
select pg_temp.as_user(:carol);
insert into blocks (blocked_user_id) values (:alice);
select pg_temp.as_user(:alice);
select pg_temp.expect_fail(format($$select start_direct_call(%L, 'voice', %L)$$, pg_temp.id('dm_carol'), pg_temp.id('alice_dev')),
  '%cannot call%');
select pg_temp.check(true, 'blocked users cannot be called');
select pg_temp.as_user(:carol);
delete from blocks where blocked_user_id = :alice;

-- ════════════════════════════════════════════════════════════════════════════
-- Group calls
-- ════════════════════════════════════════════════════════════════════════════

select pg_temp.as_user(:dave);
select pg_temp.expect_fail(format($$select start_group_call(%L, 'voice', %L)$$, pg_temp.id('grp'), pg_temp.id('dave_dev')),
  '%not a member%');
select pg_temp.check(true, 'outsiders cannot start a group call');

select pg_temp.as_user(:alice);
select pg_temp.expect_fail(format($$select start_group_call(%L, 'voice', %L)$$, pg_temp.id('dm'), pg_temp.id('alice_dev')));
select pg_temp.check(true, 'start_group_call refuses direct chats');
select pg_temp.checkpoint();
insert into ids values ('g1', start_group_call(pg_temp.id('grp'), 'video', pg_temp.id('alice_dev')));
reset role;
select pg_temp.check(pg_temp.sent('call.invite', 'user:' || :bob) = 1 and pg_temp.sent('call.invite', 'user:' || :carol) = 1,
  'group call invites every other member');
select pg_temp.check(pg_temp.sent('call.invite', 'user:' || :dave) = 0 and pg_temp.sent('call.invite', 'user:' || :alice) = 0,
  'no invite to outsiders or the starter');
select pg_temp.check(pg_temp.sent('call.live', 'conversation:' || pg_temp.id('grp')) = 1, 'open group chats learn the call is live');
set role authenticated;
select pg_temp.check(start_group_call(pg_temp.id('grp'), 'voice', pg_temp.id('alice_dev')) = pg_temp.id('g1'),
  'starting again returns the live call');

select pg_temp.checkpoint();
select pg_temp.check((select count(*) from join_group_call(pg_temp.id('g1'), pg_temp.id('alice_dev'))) = 1, 'starter joins');
select pg_temp.as_user(:bob);
select pg_temp.check((select count(*) from join_group_call(pg_temp.id('g1'), pg_temp.id('bob_dev1'))) = 2,
  'joining returns everyone in the call');
reset role;
select pg_temp.check(pg_temp.sent('call.participant', 'call:' || pg_temp.id('g1')) = 2, 'joins are broadcast on the call topic');
set role authenticated;

-- Members can see and use the call; outsiders can't.
select pg_temp.as_user(:carol);
select pg_temp.check((select count(*) from call_sessions where id = pg_temp.id('g1')) = 1, 'group member sees the live call');
select pg_temp.check((select count(*) from call_participants where call_id = pg_temp.id('g1') and left_at is null) = 2,
  'group member sees who is in the call');
select pg_temp.check(can_use_group_call_topic('call:' || pg_temp.id('g1')), 'group member may use the call topic');
select set_config('realtime.topic', 'call:' || pg_temp.id('g1'), false);
select pg_temp.check((select count(*) from realtime.messages) > 0, 'group member receives on call:<id> (new policy)');
insert into realtime.messages (topic, extension, event, payload) values ('call:' || pg_temp.id('g1'), 'broadcast', 'signal', '{}');
select pg_temp.check(true, 'group member may broadcast signalling');

select pg_temp.as_user(:dave);
select pg_temp.check((select count(*) from call_sessions where id = pg_temp.id('g1')) = 0, 'outsider cannot see the group call');
select pg_temp.check((select count(*) from call_participants where call_id = pg_temp.id('g1')) = 0,
  'outsider cannot see group call participants');
select pg_temp.check(not can_use_group_call_topic('call:' || pg_temp.id('g1'))
  and not can_use_realtime_topic('call:' || pg_temp.id('g1'), false), 'outsider cannot use the group call topic');
select set_config('realtime.topic', 'call:' || pg_temp.id('g1'), false);
select pg_temp.check((select count(*) from realtime.messages) = 0, 'outsider receives nothing on the group call topic');
select pg_temp.expect_fail(format($$select * from join_group_call(%L, %L)$$, pg_temp.id('g1'), pg_temp.id('dave_dev')),
  '%not a member%');
select pg_temp.check(true, 'outsider cannot join the group call');
select pg_temp.expect_fail(format($$select leave_call(%L, %L)$$, pg_temp.id('g1'), pg_temp.id('dave_dev')));
select pg_temp.check(true, 'outsider cannot leave (touch) the group call');
select pg_temp.expect_fail(format($$select update_call_status(%L, 'ended')$$, pg_temp.id('g1')));
select pg_temp.check(true, 'update_call_status does not apply to group calls');

-- Media flags
select pg_temp.as_user(:bob);
select pg_temp.checkpoint();
select set_call_media_state(pg_temp.id('g1'), pg_temp.id('bob_dev1'), true, false, true);
select pg_temp.check((select audio_muted and not video_enabled and screen_sharing from call_participants
  where call_id = pg_temp.id('g1') and device_id = pg_temp.id('bob_dev1') and left_at is null), 'media flags are stored');
reset role;
select pg_temp.check((select payload->>'action' = 'media' and (payload->>'audio_muted')::boolean
  from realtime.messages where event = 'call.participant' and id > (select n from mark)), 'media flags are broadcast');
set role authenticated;
select pg_temp.as_user(:carol);
select pg_temp.expect_fail(format($$select set_call_media_state(%L, %L, false, false, false)$$,
  pg_temp.id('g1'), pg_temp.id('bob_dev1')), '%unknown device%');
select pg_temp.as_user(:bob);
select pg_temp.check((select audio_muted from call_participants where call_id = pg_temp.id('g1')
  and device_id = pg_temp.id('bob_dev1') and left_at is null), 'nobody else can change my flags');

-- Moving to another device
select pg_temp.check((select count(*) from join_group_call(pg_temp.id('g1'), pg_temp.id('bob_dev2'))) = 2,
  'joining from a second device moves me (still 2 people)');
select pg_temp.check((select count(*) from call_participants where call_id = pg_temp.id('g1')
  and device_id = pg_temp.id('bob_dev1') and left_at is null) = 0, 'my first device left');

-- Removed members lose access.
select pg_temp.as_user(:carol);
select pg_temp.check((select count(*) from join_group_call(pg_temp.id('g1'), pg_temp.id('carol_dev'))) = 3, 'carol joins');
select pg_temp.as_user(:alice);
select remove_group_member(pg_temp.id('grp'), :carol);
select pg_temp.as_user(:carol);
select pg_temp.check(not can_use_group_call_topic('call:' || pg_temp.id('g1')), 'removed member loses the call topic');
select pg_temp.check((select count(*) from call_participants where call_id = pg_temp.id('g1')) = 0,
  'removed member no longer sees participants');
select pg_temp.expect_fail(format($$select * from join_group_call(%L, %L)$$, pg_temp.id('g1'), pg_temp.id('carol_dev')));
select pg_temp.check(true, 'removed member cannot re-join');

-- Lost heartbeats
reset role;
update call_participants set last_seen_at = now() - interval '5 minutes'
 where call_id = pg_temp.id('g1') and device_id = pg_temp.id('carol_dev');
select pg_temp.checkpoint();
select expire_stale_calls();
select pg_temp.check((select left_at is not null from call_participants
  where call_id = pg_temp.id('g1') and device_id = pg_temp.id('carol_dev')), 'silent devices are dropped');
select pg_temp.check((select count(*) from realtime.messages where id > (select n from mark)
  and event = 'call.participant' and payload->>'action' = 'left') = 1, 'drop is broadcast');
set role authenticated;

-- Leaving; the last one out ends the call.
select pg_temp.as_user(:bob);
select leave_call(pg_temp.id('g1'), pg_temp.id('bob_dev2'));
select pg_temp.check((select status from call_sessions where id = pg_temp.id('g1')) = 'active', 'call stays live while someone is in it');
select pg_temp.as_user(:alice);
select pg_temp.checkpoint();
select leave_call(pg_temp.id('g1'), pg_temp.id('alice_dev'));
select pg_temp.check((select status = 'ended' and ended_at is not null from call_sessions where id = pg_temp.id('g1')),
  'last one out ends the group call');
reset role;
select pg_temp.check(pg_temp.sent('call.status', 'call:' || pg_temp.id('g1')) = 1
  and pg_temp.sent('call.live', 'conversation:' || pg_temp.id('grp')) = 1, 'end of group call is broadcast');
set role authenticated;
select pg_temp.expect_fail(format($$select * from join_group_call(%L, %L)$$, pg_temp.id('g1'), pg_temp.id('alice_dev')), '%ended%');
select pg_temp.check(true, 'an ended group call cannot be joined');
insert into ids values ('g2', start_group_call(pg_temp.id('grp'), 'voice', pg_temp.id('alice_dev')));
select pg_temp.check(pg_temp.id('g2') <> pg_temp.id('g1'), 'a new group call can start after the last one ended');
select leave_call(pg_temp.id('g2'), pg_temp.id('alice_dev'));

-- 8-person limit (alice + 8 extras = 9 people).
select pg_temp.as_user(:alice);
insert into ids values ('g3', start_group_call(pg_temp.id('big'), 'voice', pg_temp.id('alice_dev')));
select count(*) from join_group_call(pg_temp.id('g3'), pg_temp.id('alice_dev'));
do $$
begin
  for i in 1..7 loop
    perform pg_temp.as_user(('f0000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid);
    perform count(*) from public.join_group_call(pg_temp.id('g3'), pg_temp.id('x' || i));
  end loop;
end;
$$;
select pg_temp.check((select count(*) from call_participants where call_id = pg_temp.id('g3') and left_at is null) = 8,
  'eight people are in the call');
select pg_temp.as_user('f0000000-0000-4000-8000-000000000008');
select pg_temp.expect_fail(format($$select * from join_group_call(%L, %L)$$, pg_temp.id('g3'), pg_temp.id('x8')), '%full%');
select pg_temp.check(true, 'the ninth person is told the call is full');
select pg_temp.as_user(:alice);
select pg_temp.check((select count(*) from join_group_call(pg_temp.id('g3'), pg_temp.id('alice_dev'))) = 8,
  're-joining from the same device does not count twice');
select leave_call(pg_temp.id('g3'), pg_temp.id('alice_dev'));
select pg_temp.as_user('f0000000-0000-4000-8000-000000000008');
select pg_temp.check((select count(*) from join_group_call(pg_temp.id('g3'), pg_temp.id('x8'))) = 8,
  'a seat frees up when someone leaves');

-- ── Push targets (090 wiring of 005's get_call_push_targets) ─────────────────
select pg_temp.as_user(:alice);
insert into push_tokens (device_id, token, platform) values (pg_temp.id('alice_dev'), 'ExponentPushToken[alice]', 'ios');
select pg_temp.as_user(:bob);
insert into push_tokens (device_id, token, platform) values (pg_temp.id('bob_dev1'), 'ExponentPushToken[bob]', 'ios');
select pg_temp.as_user(:carol);
insert into push_tokens (device_id, token, platform) values (pg_temp.id('carol_dev'), 'ExponentPushToken[carol]', 'android');
select pg_temp.as_user(:dave);
insert into push_tokens (device_id, token, platform) values (pg_temp.id('dave_dev'), 'ExponentPushToken[dave]', 'android');
select pg_temp.as_user(:alice);
insert into ids values ('pg', create_group_conversation('Push group', array[:bob, :carol, :dave]::uuid[]));
select pg_temp.as_user(:dave);
insert into blocks (blocked_user_id) values (:alice);
select pg_temp.as_user(:alice);
insert into ids values ('pgc', start_group_call(pg_temp.id('pg'), 'voice', pg_temp.id('alice_dev')));
select count(*) from join_group_call(pg_temp.id('pgc'), pg_temp.id('alice_dev'));
insert into ids values ('pdc', start_direct_call(pg_temp.id('dm'), 'video', pg_temp.id('alice_dev')));
reset role;
set role service_role;
select pg_temp.check((select array_agg(device_id order by device_id) from get_call_push_targets(pg_temp.id('pgc'), :alice))
  = (select array_agg(id order by id) from ids where name in ('bob_dev1', 'carol_dev')),
  'group call push rings members (not the caller, not someone who blocked them)');
select pg_temp.check((select count(*) from get_call_push_targets(pg_temp.id('pgc'), :bob)) = 0,
  'only the caller may trigger the group call push');
select pg_temp.check((select array_agg(device_id) from get_call_push_targets(pg_temp.id('pdc'), :alice))
  = array[pg_temp.id('bob_dev1')], '1:1 call push still rings only the callee');
select pg_temp.check((select push_sent_at is null from call_sessions where id = pg_temp.id('pgc')),
  'without pg_net/Vault the database does not claim the push (the app asks send-push)');
reset role;
set role authenticated;
select pg_temp.as_user(:carol);
select count(*) from join_group_call(pg_temp.id('pgc'), pg_temp.id('carol_dev'));
select pg_temp.as_user(:bob);
select mute_conversation(pg_temp.id('pg'), now() + interval '1 hour');
reset role;
set role service_role;
select pg_temp.check((select count(*) from get_call_push_targets(pg_temp.id('pgc'), :alice)) = 0,
  'people already in the call and members who muted the group are not rung');
reset role;
set role authenticated;
select pg_temp.as_user(:alice);

-- Service-role-only helpers
select pg_temp.expect_fail($$select get_turn_config()$$);
select pg_temp.expect_fail($$select expire_stale_calls()$$);
select pg_temp.expect_fail(format($$select broadcast_call_status(%L)$$, pg_temp.id('g3')));
select pg_temp.check(true, 'TURN config and internal helpers are not callable by users');
reset role;
set role service_role;
select pg_temp.check(get_turn_config() = '{}'::jsonb, 'TURN config is empty without Vault secrets');
reset role;

-- Anonymous
set role anon;
select pg_temp.as_user(null);
select pg_temp.expect_fail(format($$select start_direct_call(%L, 'voice', %L)$$, pg_temp.id('dm'), pg_temp.id('alice_dev')));
select pg_temp.expect_fail(format($$select * from join_group_call(%L, %L)$$, pg_temp.id('g3'), pg_temp.id('alice_dev')));
select pg_temp.check(true, 'anonymous users cannot call');
reset role;

\echo 'ALL CALL TESTS PASSED'
