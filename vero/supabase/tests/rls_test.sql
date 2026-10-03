-- Schema / RLS / RPC behaviour tests. Run with scripts/test-db.sh.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned

create function pg_temp.as_user(p_id uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_id::text, ''), false);
$$;

create function pg_temp.expect_fail(p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED FAILURE but statement succeeded: %', p_sql;
exception when others then
  if sqlerrm like 'EXPECTED FAILURE%' then raise; end if;
end;
$$;

create function pg_temp.check(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAILED: %', p_name; end if;
  raise notice 'ok - %', p_name;
end;
$$;

set client_min_messages = notice;

-- Fixed ids for readability
\set alice '''aaaaaaaa-0000-4000-8000-000000000001'''
\set bob   '''bbbbbbbb-0000-4000-8000-000000000002'''
\set carol '''cccccccc-0000-4000-8000-000000000003'''

insert into auth.users (id, raw_user_meta_data) values
  (:alice, '{"username":"Alice","display_name":"Alice A"}'),
  (:bob,   '{"username":"bob","display_name":"Bob B"}'),
  (:carol, '{"username":"carol_c","display_name":"Carol"}');

select pg_temp.check((select username from profiles where id = :alice) = 'alice',
  'profile is created from sign-up metadata (username lower-cased)');

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated;

set role authenticated;

-- ── devices ──────────────────────────────────────────────────────────────────
select pg_temp.as_user(:alice);
with d as (insert into devices (identity_public_key) values (repeat('A', 43)) returning id)
insert into ids select 'alice_dev', id from d;
select pg_temp.as_user(:bob);
with d as (insert into devices (identity_public_key) values (repeat('B', 43)) returning id)
insert into ids select 'bob_dev', id from d;
select pg_temp.as_user(:carol);
with d as (insert into devices (identity_public_key) values (repeat('C', 43)) returning id)
insert into ids select 'carol_dev', id from d;

select pg_temp.as_user(:alice);
select pg_temp.expect_fail($$update devices set identity_public_key = repeat('Z', 43)$$);
select pg_temp.check(true, 'device identity key is immutable');
select pg_temp.expect_fail(format($$insert into devices (user_id, identity_public_key) values (%L, %L)$$, 'bbbbbbbb-0000-4000-8000-000000000002', repeat('X', 43)));
select pg_temp.check(true, 'cannot register a device for another user');
select pg_temp.check((select count(*) from devices) = 1, 'users only see their own device rows');
select pg_temp.expect_fail($$update profiles set username = 'hacker'$$);
select pg_temp.check(true, 'username cannot be changed via direct update');

-- ── direct conversations ─────────────────────────────────────────────────────
select pg_temp.expect_fail($$insert into conversations (conversation_type) values ('direct')$$);
select pg_temp.expect_fail(format($$insert into conversation_members (conversation_id, user_id) select id, %L from conversations$$, 'cccccccc-0000-4000-8000-000000000003'));
select pg_temp.check(true, 'conversations/members cannot be written directly');

insert into ids values ('dm', create_direct_conversation(:bob));
select pg_temp.check(create_direct_conversation(:bob) = (select id from ids where name = 'dm'),
  'create_direct_conversation is idempotent');

insert into messages (id, conversation_id, sender_device_id, sender_user_id, ciphertext)
select 'dddddddd-0000-4000-8000-000000000001', (select id from ids where name = 'dm'),
       (select id from ids where name = 'alice_dev'), :carol, '{"v":2}';
select pg_temp.check((select sender_user_id from messages limit 1) = :alice,
  'sender_user_id is derived from the device, not trusted from the client');
select pg_temp.expect_fail(format($$insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext) values (%L, %L, %L, 'x')$$,
  (select id from ids where name = 'dm'), (select id from ids where name = 'bob_dev'), 'aaaaaaaa-0000-4000-8000-000000000001'));
select pg_temp.check(true, 'cannot send from someone else''s device');

reset role;
select pg_temp.check(exists (select 1 from realtime.messages where event = 'message.new'
  and topic = 'conversation:' || (select id from ids where name = 'dm')), 'insert broadcasts message.new on the private topic');
select pg_temp.check((select count(*) from realtime.messages where event = 'inbox.message') = 2,
  'insert pings every member''s inbox topic');
set role authenticated;

select pg_temp.as_user(:bob);
select pg_temp.check((select count(*) from messages) = 1, 'recipient can read the conversation');
select pg_temp.check((select count(*) from get_conversation_devices((select id from ids where name = 'dm'))) = 2,
  'recipient list = all active devices of current members');
select pg_temp.check((select count(*) from get_device_keys(array[(select id from ids where name = 'alice_dev')])) = 1,
  'conversation partner can fetch sender key');

select pg_temp.as_user(:carol);
select pg_temp.check((select count(*) from messages) = 0, 'outsider cannot read messages');
select pg_temp.check((select count(*) from conversations) = 0, 'outsider cannot see conversation');
select pg_temp.check((select count(*) from conversation_members) = 0, 'outsider cannot see members');
select pg_temp.check((select count(*) from get_conversation_devices((select id from ids where name = 'dm'))) = 0,
  'outsider gets no recipient keys');
select pg_temp.check((select count(*) from get_device_keys(array[(select id from ids where name = 'alice_dev')])) = 0,
  'outsider cannot fetch device keys of strangers');
select pg_temp.expect_fail(format($$insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext) values (%L, %L, %L, 'x')$$,
  (select id from ids where name = 'dm'), (select id from ids where name = 'carol_dev'), 'cccccccc-0000-4000-8000-000000000003'));
select pg_temp.check(true, 'outsider cannot post into a conversation');
select pg_temp.check(not can_use_realtime_topic('conversation:' || (select id from ids where name = 'dm'), false),
  'outsider cannot join the realtime topic');
select pg_temp.check(not can_use_realtime_topic('conversation:not-a-uuid', false), 'malformed topic is rejected');

-- realtime.messages RLS really applies
set realtime.topic = '';
select set_config('realtime.topic', 'conversation:' || (select id from ids where name = 'dm'), false);
select pg_temp.check((select count(*) from realtime.messages) = 0, 'outsider receives no realtime rows');
select pg_temp.as_user(:bob);
select pg_temp.check((select count(*) from realtime.messages) > 0, 'member receives realtime rows');

-- ── receipts, deletes ────────────────────────────────────────────────────────
select mark_conversation_receipt((select id from ids where name = 'dm'), 'read');
select pg_temp.check((select last_read_at is not null from conversation_members where user_id = :bob
  and conversation_id = (select id from ids where name = 'dm')), 'read receipt watermark stored');

select pg_temp.expect_fail($$select delete_message('dddddddd-0000-4000-8000-000000000001')$$);
select pg_temp.check(true, 'cannot delete someone else''s message');
select pg_temp.as_user(:alice);
select delete_message('dddddddd-0000-4000-8000-000000000001');
select pg_temp.check((select ciphertext = '' and deleted_at is not null from messages
  where id = 'dddddddd-0000-4000-8000-000000000001'), 'delete for everyone wipes ciphertext');

-- ── blocks ───────────────────────────────────────────────────────────────────
select pg_temp.as_user(:bob);
insert into blocks (blocked_user_id) values (:alice);
select pg_temp.as_user(:alice);
select pg_temp.expect_fail(format($$insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext) values (%L, %L, %L, 'x')$$,
  (select id from ids where name = 'dm'), (select id from ids where name = 'alice_dev'), 'aaaaaaaa-0000-4000-8000-000000000001'));
select pg_temp.check(true, 'blocked sender cannot message in a direct chat');
select pg_temp.as_user(:bob);
delete from blocks;

-- ── groups ───────────────────────────────────────────────────────────────────
select pg_temp.as_user(:alice);
insert into ids values ('grp', create_group_conversation('Team', array[:bob, :carol]::uuid[]));
select pg_temp.as_user(:carol);
select pg_temp.check((select count(*) from get_conversation_devices((select id from ids where name = 'grp'))) = 3,
  'group recipient list contains every member device');
select pg_temp.as_user(:bob);
select pg_temp.expect_fail(format($$select remove_group_member(%L, %L)$$, (select id from ids where name = 'grp'), 'cccccccc-0000-4000-8000-000000000003'));
select pg_temp.check(true, 'non-admin cannot remove members');
select pg_temp.as_user(:alice);
select remove_group_member((select id from ids where name = 'grp'), :carol);
select pg_temp.check((select count(*) from get_conversation_devices((select id from ids where name = 'grp'))) = 2,
  'removed member no longer receives keys for new messages');
select pg_temp.as_user(:carol);
select pg_temp.check((select count(*) from conversations where id = (select id from ids where name = 'grp')) = 0,
  'removed member loses access to the group');

-- ── search & calls ───────────────────────────────────────────────────────────
select pg_temp.as_user(:alice);
select pg_temp.check((select count(*) from search_profiles('%%')) = 0, 'LIKE wildcards in search are escaped');
select pg_temp.check((select count(*) from search_profiles('bo')) = 1, 'directory search finds users by prefix');

select start_call((select id from ids where name = 'dm'), 'voice');
reset role;
select pg_temp.check(exists (select 1 from realtime.messages where event = 'call.invite'
  and topic = 'user:bbbbbbbb-0000-4000-8000-000000000002'), 'call invite delivered to callee topic');
set role authenticated;
select pg_temp.as_user(:carol);
select pg_temp.check((select count(*) from call_sessions) = 0, 'outsiders cannot see call sessions');

-- ── anon ─────────────────────────────────────────────────────────────────────
reset role;
set role anon;
select pg_temp.as_user(null);
select pg_temp.check((select count(*) from profiles) = 0, 'anonymous users see no profiles');
select pg_temp.expect_fail($$select create_direct_conversation('bbbbbbbb-0000-4000-8000-000000000002')$$);
select pg_temp.check(username_available('newname'), 'username_available is callable before sign-up');
reset role;

\echo 'ALL DATABASE TESTS PASSED'
