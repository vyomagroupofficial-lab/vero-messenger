-- Tests for 006_messaging: control messages, delete-for-everyone window,
-- forwarding media, encrypted self-sync, pin/archive. Run with scripts/test-db.sh.
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

-- Like expect_fail, but the error message must contain p_like.
create function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED FAILURE but statement succeeded: %', p_sql;
exception when others then
  if sqlerrm like 'EXPECTED FAILURE%' then raise; end if;
  if sqlerrm not like '%' || p_like || '%' then
    raise exception 'unexpected error "%" for: %', sqlerrm, p_sql;
  end if;
end;
$$;

create function pg_temp.check(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAILED: %', p_name; end if;
  raise notice 'ok - %', p_name;
end;
$$;

-- Broadcasts are checked as the table owner (realtime.messages has RLS).
create function pg_temp.rt(p_event text, p_topic text default null) returns bigint
language sql security definer as $$
  select count(*) from realtime.messages where event = p_event and (p_topic is null or topic = p_topic)
$$;
create function pg_temp.rt_clear() returns void language sql security definer as $$
  delete from realtime.messages
$$;

set client_min_messages = notice;

\set alice '''a6000000-0000-4000-8000-000000000001'''
\set bob   '''b6000000-0000-4000-8000-000000000002'''
\set carol '''c6000000-0000-4000-8000-000000000003'''
\set dave  '''d6000000-0000-4000-8000-000000000004'''
\set erin  '''e6000000-0000-4000-8000-000000000005'''

insert into auth.users (id, raw_user_meta_data) values
  (:alice, '{"username":"m_alice","display_name":"Alice"}'),
  (:bob,   '{"username":"m_bob","display_name":"Bob"}'),
  (:carol, '{"username":"m_carol","display_name":"Carol"}'),
  (:dave,  '{"username":"m_dave","display_name":"Dave"}'),
  (:erin,  '{"username":"m_erin","display_name":"Erin"}');

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated;
create function pg_temp.id(p text) returns uuid language sql as $$ select id from ids where name = p $$;

set role authenticated;

-- Devices (alice has two)
select pg_temp.as_user(:alice);
with d as (insert into devices (identity_public_key) values (repeat('A', 43)) returning id)
insert into ids select 'alice_dev', id from d;
with d as (insert into devices (identity_public_key, device_label) values (repeat('a', 43), 'Laptop') returning id)
insert into ids select 'alice_dev2', id from d;
select pg_temp.as_user(:bob);
with d as (insert into devices (identity_public_key) values (repeat('B', 43)) returning id)
insert into ids select 'bob_dev', id from d;
select pg_temp.as_user(:carol);
with d as (insert into devices (identity_public_key) values (repeat('C', 43)) returning id)
insert into ids select 'carol_dev', id from d;

-- Conversations: alice<->bob, alice<->carol, alice<->dave, alice<->erin, group(alice,bob,carol)
select pg_temp.as_user(:alice);
insert into ids values ('dm_bob', create_direct_conversation(:bob));
insert into ids values ('dm_carol', create_direct_conversation(:carol));
insert into ids values ('dm_dave', create_direct_conversation(:dave));
insert into ids values ('dm_erin', create_direct_conversation(:erin));
insert into ids values ('group', create_group_conversation('Team', array[:bob, :carol]::uuid[]));

-- ── control message type ─────────────────────────────────────────────────────
insert into messages (id, conversation_id, sender_device_id, sender_user_id, ciphertext, message_type)
values ('16000000-0000-4000-8000-000000000001', pg_temp.id('dm_bob'), pg_temp.id('alice_dev'), :alice, '{"v":2}', 'text');
insert into messages (id, conversation_id, sender_device_id, sender_user_id, ciphertext, message_type)
values ('16000000-0000-4000-8000-000000000002', pg_temp.id('dm_bob'), pg_temp.id('alice_dev'), :alice, '{"v":2}', 'control');
select pg_temp.check((select message_type from messages where id = '16000000-0000-4000-8000-000000000002') = 'control',
  'control messages are accepted');
select pg_temp.check(pg_temp.rt('message.new', 'conversation:' || pg_temp.id('dm_bob')::text) = 2,
  'control messages are broadcast like any other ciphertext');
select pg_temp.expect_error(format($$insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext, message_type)
  values (%L, %L, %L, '{}', 'edit')$$, pg_temp.id('dm_bob'), pg_temp.id('alice_dev'), :alice), 'messages_message_type_check');
select pg_temp.check(true, 'unknown message types are still rejected');
select pg_temp.expect_error(format($$insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext, message_type, reply_to_message_id)
  values (%L, %L, %L, '{}', 'control', '16000000-0000-4000-8000-000000000001')$$, pg_temp.id('dm_bob'), pg_temp.id('alice_dev'), :alice),
  'control messages cannot reference');
select pg_temp.check(true, 'control messages cannot carry replies or media');
select pg_temp.check(
  (select count(*) from pg_constraint where conrelid = 'public.messages'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%message_type%') = 1,
  'exactly one message_type check remains');

-- ── delete for everyone ──────────────────────────────────────────────────────
select pg_temp.as_user(:bob);
insert into messages (id, conversation_id, sender_device_id, sender_user_id, ciphertext)
values ('16000000-0000-4000-8000-000000000003', pg_temp.id('dm_bob'), pg_temp.id('bob_dev'), :bob, '{"v":2}');
select pg_temp.expect_error($$select delete_message('16000000-0000-4000-8000-000000000001')$$, 'message not found');
select pg_temp.check(true, 'cannot delete someone else''s message');

select pg_temp.as_user(:alice);
select pg_temp.rt_clear();
\o /dev/null
select delete_message('16000000-0000-4000-8000-000000000001');
\o
select pg_temp.check(
  (select deleted_at is not null and ciphertext = '' from messages where id = '16000000-0000-4000-8000-000000000001'),
  'sender deletes own recent message for everyone (ciphertext wiped, row kept as tombstone)');
select pg_temp.check(
  pg_temp.rt('message.deleted', 'conversation:' || pg_temp.id('dm_bob')::text) = 1,
  'deletion is broadcast on the conversation topic');
select pg_temp.check(
  pg_temp.rt('inbox.deleted', 'user:' || :alice) = 1 and pg_temp.rt('inbox.deleted', 'user:' || :bob) = 1
  and pg_temp.rt('inbox.deleted') = 2,
  'deletion pings every member inbox (incl. sender''s other devices)');
select pg_temp.expect_error($$select delete_message('16000000-0000-4000-8000-000000000001')$$, 'message not found');
select pg_temp.check(true, 'a message cannot be deleted twice');

select pg_temp.as_user(:bob);
select pg_temp.check(
  (select count(*) from messages where deleted_at > now() - interval '1 minute') = 1,
  'members can sync deletions by deleted_at');

-- 48-hour window (time travel as the table owner)
select pg_temp.as_user(:alice);
insert into messages (id, conversation_id, sender_device_id, sender_user_id, ciphertext)
values ('16000000-0000-4000-8000-000000000004', pg_temp.id('dm_bob'), pg_temp.id('alice_dev'), :alice, '{"v":2}');
reset role;
update messages set created_at = now() - interval '49 hours' where id = '16000000-0000-4000-8000-000000000004';
set role authenticated;
select pg_temp.expect_error($$select delete_message('16000000-0000-4000-8000-000000000004')$$, 'within 48 hours');
select pg_temp.check(true, 'delete for everyone is refused after 48 hours');
reset role;
update messages set created_at = now() - interval '47 hours' where id = '16000000-0000-4000-8000-000000000004';
set role authenticated;
\o /dev/null
select delete_message('16000000-0000-4000-8000-000000000004');
\o
select pg_temp.check(true, 'delete for everyone works just inside the window');

select pg_temp.expect_fail($$update messages set ciphertext = 'x' where id = '16000000-0000-4000-8000-000000000003'$$);
select pg_temp.check(true, 'messages still cannot be updated directly');

-- ── forwarding media ─────────────────────────────────────────────────────────
reset role;
insert into media (id, conversation_id, uploader_id, storage_object_id, encrypted_size, encrypted_hash) values
  ('26000000-0000-4000-8000-000000000001', (select id from ids where name = 'dm_bob'), :bob, 'sb:blob1', 100, repeat('a', 64)),
  ('26000000-0000-4000-8000-000000000002', (select id from ids where name = 'dm_bob'), :bob, 'sb:blob2', 100, repeat('b', 64)),
  ('26000000-0000-4000-8000-000000000003', (select id from ids where name = 'dm_bob'), :bob, 'sb:blob3', 100, repeat('c', 64));
set role authenticated;
select pg_temp.as_user(:bob);
insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext, message_type, media_id)
values (pg_temp.id('dm_bob'), pg_temp.id('bob_dev'), :bob, '{"v":2}', 'media', '26000000-0000-4000-8000-000000000001');
insert into messages (id, conversation_id, sender_device_id, sender_user_id, ciphertext, message_type, media_id)
values ('16000000-0000-4000-8000-000000000005', pg_temp.id('dm_bob'), pg_temp.id('bob_dev'), :bob, '{"v":2}', 'media', '26000000-0000-4000-8000-000000000002');
-- blob3 has no message: not forwardable

select pg_temp.as_user(:alice);
insert into ids values ('fwd_media', forward_media('26000000-0000-4000-8000-000000000001', pg_temp.id('group')));
select pg_temp.check(
  (select storage_object_id = 'sb:blob1' and uploader_id = :alice and conversation_id = pg_temp.id('group')
     from media where id = pg_temp.id('fwd_media')),
  'forward_media creates a row in the target chat pointing at the same blob, owned by the forwarder');
insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext, message_type, media_id)
values (pg_temp.id('group'), pg_temp.id('alice_dev'), :alice, '{"v":2}', 'media', pg_temp.id('fwd_media'));
select pg_temp.check(true, 'the forwarded media can be attached to a message in the target chat');
select pg_temp.expect_fail(format($$insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext, message_type, media_id)
  values (%L, %L, %L, '{}', 'media', '26000000-0000-4000-8000-000000000001')$$, pg_temp.id('group'), pg_temp.id('alice_dev'), :alice));
select pg_temp.check(true, 'the source media row itself still cannot be attached elsewhere');
select pg_temp.expect_error($$select forward_media('26000000-0000-4000-8000-000000000003', (select id from ids where name = 'group'))$$, 'media not found');
select pg_temp.check(true, 'media not attached to a live message cannot be forwarded');
select pg_temp.check(forward_media('26000000-0000-4000-8000-000000000001', pg_temp.id('dm_erin')) is not null,
  'the same media can be forwarded to several of your chats');
select pg_temp.expect_error($$select forward_media('26000000-0000-4000-8000-000000000001', gen_random_uuid())$$, 'not a member');
select pg_temp.check(true, 'unknown target chats are rejected');

select pg_temp.as_user(:carol);
select pg_temp.expect_error($$select forward_media('26000000-0000-4000-8000-000000000001', (select id from ids where name = 'group'))$$, 'media not found');
select pg_temp.check(true, 'outsiders cannot forward media from a chat they are not in');
select pg_temp.check((select count(*) from media where id = '26000000-0000-4000-8000-000000000001') = 0,
  'outsiders cannot see the source media row');

select pg_temp.as_user(:bob);
select pg_temp.expect_error($$select forward_media('26000000-0000-4000-8000-000000000001', (select id from ids where name = 'dm_carol'))$$, 'not a member');
select pg_temp.check(true, 'cannot forward into a chat you are not a member of');

\o /dev/null
select delete_message('16000000-0000-4000-8000-000000000005');
\o
select pg_temp.as_user(:alice);
select pg_temp.expect_error($$select forward_media('26000000-0000-4000-8000-000000000002', (select id from ids where name = 'group'))$$, 'media not found');
select pg_temp.check(true, 'media of a deleted message cannot be forwarded');

-- ── encrypted self sync ──────────────────────────────────────────────────────
select pg_temp.as_user(:alice);
select pg_temp.rt_clear();
insert into self_sync_events (sender_device_id, ciphertext) values (pg_temp.id('alice_dev'), '{"v":2}');
select pg_temp.check((select count(*) from self_sync_events) = 1 and (select user_id from self_sync_events) = :alice,
  'a user stores an encrypted sync event from their own device');
select pg_temp.check(pg_temp.rt('self.sync', 'user:' || :alice) = 1 and pg_temp.rt('self.sync') = 1,
  'sync events ping only the owner''s personal topic');
select pg_temp.expect_fail(format($$insert into self_sync_events (sender_device_id, ciphertext) values (%L, 'x')$$, pg_temp.id('bob_dev')));
select pg_temp.check(true, 'cannot write a sync event from someone else''s device');
insert into self_sync_events (user_id, sender_device_id, ciphertext) values (:bob, pg_temp.id('alice_dev'), 'x');
select pg_temp.check((select count(*) from self_sync_events where user_id = :alice) = 2,
  'cannot write sync events into another user''s stream (owner is derived from the device)');
select pg_temp.expect_fail($$update self_sync_events set ciphertext = 'y'$$);
select pg_temp.check(true, 'sync events are immutable');

select pg_temp.as_user(:bob);
select pg_temp.check((select count(*) from self_sync_events) = 0, 'other users cannot read someone''s sync events');
delete from self_sync_events;
select pg_temp.as_user(:alice);
select pg_temp.check((select count(*) from self_sync_events) = 2, 'other users cannot delete someone''s sync events');

-- ── pin / archive ────────────────────────────────────────────────────────────
select pg_temp.as_user(:alice);
select pg_temp.check(pin_conversation(pg_temp.id('dm_bob'), true) is not null, 'pin own chat');
\o /dev/null
select pin_conversation(pg_temp.id('dm_carol'), true);
\o
\o /dev/null
select pin_conversation(pg_temp.id('dm_dave'), true);
\o
select pg_temp.check(pin_conversation(pg_temp.id('dm_bob'), true) is not null, 're-pinning an already pinned chat is allowed at the limit');
select pg_temp.expect_error($$select pin_conversation((select id from ids where name = 'dm_erin'), true)$$, 'up to 3');
select pg_temp.check(true, 'at most 3 chats can be pinned');
select pg_temp.check(pin_conversation(pg_temp.id('dm_dave'), false) is null, 'unpin');
select pg_temp.check(pin_conversation(pg_temp.id('dm_erin'), true) is not null, 'a freed slot can be reused');
select pg_temp.check((select count(*) from conversation_prefs where pinned_at is not null) = 3, 'three pinned rows');
select pg_temp.check(pg_temp.rt('prefs.changed', 'user:' || :alice) > 0 and pg_temp.rt('prefs.changed') = pg_temp.rt('prefs.changed', 'user:' || :alice),
  'pin changes sync to the user''s other devices');

\o /dev/null
select archive_conversation(pg_temp.id('dm_bob'), true);
\o
select pg_temp.check(
  (select archived_at is not null and pinned_at is null from conversation_prefs where conversation_id = pg_temp.id('dm_bob')),
  'archiving a chat unpins it');
\o /dev/null
select pin_conversation(pg_temp.id('dm_bob'), true);
\o
select pg_temp.check(
  (select archived_at is null and pinned_at is not null from conversation_prefs where conversation_id = pg_temp.id('dm_bob')),
  'pinning an archived chat unarchives it');
select pg_temp.check(archive_conversation(pg_temp.id('group'), true) is not null, 'archive a group');
select pg_temp.check(archive_conversation(pg_temp.id('group'), false) is null, 'unarchive');

select pg_temp.expect_fail(format($$insert into conversation_prefs (user_id, conversation_id, pinned_at) values (%L, %L, now())$$, :alice, pg_temp.id('dm_dave')));
select pg_temp.expect_fail(format($$update conversation_prefs set pinned_at = now() where conversation_id = %L$$, pg_temp.id('dm_dave')));
select pg_temp.check(true, 'conversation_prefs cannot be written directly (limit can''t be bypassed)');

select pg_temp.as_user(:bob);
select pg_temp.check((select count(*) from conversation_prefs) = 0, 'co-members cannot see whether you pinned/archived a chat');
select pg_temp.check(archive_conversation(pg_temp.id('dm_bob'), true) is not null, 'members manage their own prefs independently');
select pg_temp.as_user(:alice);
select pg_temp.check(
  (select archived_at is null and pinned_at is not null from conversation_prefs where conversation_id = pg_temp.id('dm_bob')),
  'another member''s archive does not change your row');

select pg_temp.as_user(:carol);
select pg_temp.expect_error($$select pin_conversation((select id from ids where name = 'dm_bob'), true)$$, 'not a member');
select pg_temp.expect_error($$select archive_conversation((select id from ids where name = 'dm_bob'), true)$$, 'not a member');
select pg_temp.check(true, 'outsiders cannot pin or archive a chat they are not in');

select pg_temp.as_user(null);
select pg_temp.expect_fail($$select pin_conversation((select id from ids where name = 'dm_bob'), true)$$);
select pg_temp.check(true, 'signed-out callers are denied');

-- A chat you left can still be archived, but no longer pinned.
select pg_temp.as_user(:carol);
\o /dev/null
select remove_group_member(pg_temp.id('group'), :carol);
\o
select pg_temp.check(archive_conversation(pg_temp.id('group'), true) is not null, 'a left chat can be archived');
select pg_temp.expect_error($$select pin_conversation((select id from ids where name = 'group'), true)$$, 'not a member');
select pg_temp.check(true, 'a left chat cannot be pinned');

reset role;
select pg_temp.check(not has_function_privilege('anon', 'public.pin_conversation(uuid, boolean)', 'execute'),
  'anon cannot call pin_conversation');
select pg_temp.check(not has_function_privilege('authenticated', 'public.cleanup_self_sync_events()', 'execute'),
  'clients cannot run the sync cleanup');

\echo ALL MESSAGING TESTS PASSED
