-- Tests for 005_settings_push_backup: privacy settings, last seen, presence
-- topics, mutes, the push trigger (pg_net stub), push target RPCs, backup
-- storage policies (storage stub). Run with scripts/test-db.sh.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned
\o /dev/null

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

-- pg_net stand-in (created here, not in supabase_stubs.sql, because other
-- tests bring their own): records requests instead of sending them.
create schema net;
create table net.http_request_queue (
  id                   bigserial primary key,
  method               text not null,
  url                  text not null,
  headers              jsonb,
  body                 jsonb,
  timeout_milliseconds integer
);
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                              headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
                              timeout_milliseconds integer default 5000)
returns bigint language sql as $$
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', url, headers, body, timeout_milliseconds) returning id
$$;

\set alice '''aaaaaaaa-0000-4000-8000-000000000001'''
\set bob   '''bbbbbbbb-0000-4000-8000-000000000002'''
\set carol '''cccccccc-0000-4000-8000-000000000003'''
\set dave  '''dddddddd-0000-4000-8000-000000000004'''

insert into auth.users (id, raw_user_meta_data) values
  (:alice, '{"username":"alice","display_name":"Alice"}'),
  (:bob,   '{"username":"bob","display_name":"Bob"}'),
  (:carol, '{"username":"carol","display_name":"Carol"}'),
  (:dave,  '{"username":"dave","display_name":"Dave"}');

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated, service_role;
create function pg_temp.id(p_name text) returns uuid language sql stable as $$
  select id from ids where name = p_name
$$;

-- ── setup: devices, a direct chat (alice-bob) and a group (alice, bob, carol)
set role authenticated;
select pg_temp.as_user(:alice);
with d as (insert into devices (identity_public_key) values (repeat('A', 43)) returning id)
insert into ids select 'alice_dev', id from d;
select pg_temp.as_user(:bob);
with d as (insert into devices (identity_public_key) values (repeat('B', 43)) returning id)
insert into ids select 'bob_dev', id from d;
with d as (insert into devices (identity_public_key) values (repeat('b', 43)) returning id)
insert into ids select 'bob_dev2', id from d;
select pg_temp.as_user(:carol);
with d as (insert into devices (identity_public_key) values (repeat('C', 43)) returning id)
insert into ids select 'carol_dev', id from d;
select pg_temp.as_user(:dave);
with d as (insert into devices (identity_public_key) values (repeat('D', 43)) returning id)
insert into ids select 'dave_dev', id from d;

select pg_temp.as_user(:alice);
insert into ids values ('dm', create_direct_conversation(:bob));
insert into ids values ('grp', create_group_conversation('Hikers', array[:bob, :carol]::uuid[]));

-- ═════════════════════════════════════════════════════════════════════════════
-- user_settings
-- ═════════════════════════════════════════════════════════════════════════════
reset role;
select pg_temp.check((select count(*) from user_settings) = 4, 'every profile gets a settings row automatically');
select pg_temp.check((select not notification_previews and read_receipts and typing_indicators and show_online
                             and last_seen = 'everyone' and default_disappearing_seconds = 0
                      from user_settings where user_id = :alice), 'defaults: previews off, everything else on');
set role authenticated;

select pg_temp.as_user(:alice);
select pg_temp.check((select count(*) from user_settings) = 1, 'users read only their own settings');
update user_settings set read_receipts = false where user_id = :bob;
reset role;
select pg_temp.check((select read_receipts from user_settings where user_id = :bob), 'users cannot change someone else''s settings');
set role authenticated;
select pg_temp.as_user(:alice);
select pg_temp.expect_fail(format($$insert into user_settings (user_id) values (%L)$$, 'dddddddd-0000-4000-8000-000000000004'));
select pg_temp.check(true, 'users cannot create settings rows for others');
select pg_temp.expect_fail($$update user_settings set last_seen = 'friends'$$);
select pg_temp.check(true, 'last_seen visibility is validated');
select pg_temp.expect_fail($$update user_settings set default_disappearing_seconds = -5$$);
select pg_temp.check(true, 'default disappearing timer is validated');
update user_settings set default_disappearing_seconds = 86400;
select pg_temp.check((select default_disappearing_seconds from user_settings) = 86400, 'owner updates own settings');
update user_settings set default_disappearing_seconds = 0;

set role anon;
select pg_temp.expect_fail($$select * from user_settings$$);
select pg_temp.check(true, 'anonymous users cannot read settings');
set role authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- mute
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.as_user(:bob);
select mute_conversation(pg_temp.id('dm'), now() + interval '8 hours');
select pg_temp.check((select count(*) from get_conversation_mutes()) = 1, 'mute for 8 hours is listed');
select pg_temp.check((select muted_until > now() + interval '7 hours' from get_conversation_mutes()), 'mute expiry stored');
select mute_conversation(pg_temp.id('dm'), 'infinity');
select pg_temp.check((select muted_until = 'infinity' from get_conversation_mutes()), 'mute "always" uses infinity');
select pg_temp.check(mute_conversation(pg_temp.id('dm'), null) is null, 'null unmutes');
select pg_temp.check((select count(*) from get_conversation_mutes()) = 0, 'unmuted chat is no longer listed');
select mute_conversation(pg_temp.id('dm'), now() - interval '1 hour');
select pg_temp.check((select count(*) from get_conversation_mutes()) = 0, 'a time in the past unmutes');
select pg_temp.as_user(:alice);
select pg_temp.check((select count(*) from get_conversation_mutes()) = 0, 'mutes are per member');
select pg_temp.as_user(:dave);
select pg_temp.expect_fail(format($$select mute_conversation(%L, now() + interval '1 hour')$$, pg_temp.id('dm')));
select pg_temp.check(true, 'non-members cannot mute a chat');
select pg_temp.expect_fail($$update conversation_members set muted_until = now() + interval '1 day'$$);
select pg_temp.check(true, 'muted_until is only writable through the RPC');

-- ═════════════════════════════════════════════════════════════════════════════
-- last seen
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.as_user(:alice);
select touch_last_seen();
select pg_temp.check(get_last_seen(:alice) is not null, 'users see their own last seen');
select pg_temp.expect_fail($$select * from user_last_seen$$);
select pg_temp.check(true, 'last seen table is not readable directly');
select pg_temp.expect_fail($$select last_seen_at from profiles$$);
select pg_temp.check(true, 'profiles carry no last seen column');

select pg_temp.as_user(:bob);
select pg_temp.check(get_last_seen(:alice) is not null, 'everyone: a contact sees last seen');
select pg_temp.as_user(:dave);
select pg_temp.check(get_last_seen(:alice) is not null, 'everyone: a stranger sees last seen');

select pg_temp.as_user(:alice);
update user_settings set last_seen = 'contacts';
select pg_temp.as_user(:bob);
select pg_temp.check(get_last_seen(:alice) is not null, 'contacts: direct-chat partner sees last seen');
select pg_temp.as_user(:carol);
select pg_temp.check(get_last_seen(:alice) is null, 'contacts: a group-only member does not');
select pg_temp.as_user(:dave);
select pg_temp.check(get_last_seen(:alice) is null, 'contacts: a stranger does not');

select pg_temp.as_user(:alice);
update user_settings set last_seen = 'nobody';
reset role;
select pg_temp.check(not exists (select 1 from user_last_seen where user_id = :alice), 'switching to nobody erases the stored time');
set role authenticated;
select touch_last_seen();
reset role;
select pg_temp.check(not exists (select 1 from user_last_seen where user_id = :alice), 'nobody: heartbeats store nothing');
set role authenticated;
select pg_temp.as_user(:bob);
select pg_temp.check(get_last_seen(:alice) is null, 'nobody: contacts see nothing');

select pg_temp.as_user(:alice);
update user_settings set last_seen = 'everyone';
select touch_last_seen();
reset role;
update user_last_seen set last_seen_at = now() - interval '30 seconds' where user_id = :alice;
set role authenticated;
select touch_last_seen();
reset role;
select pg_temp.check((select last_seen_at < now() - interval '20 seconds' from user_last_seen where user_id = :alice),
  'heartbeats are throttled to one write a minute');
update user_last_seen set last_seen_at = now() - interval '5 minutes' where user_id = :alice;
set role authenticated;
select touch_last_seen();
reset role;
select pg_temp.check((select last_seen_at > now() - interval '5 seconds' from user_last_seen where user_id = :alice),
  'heartbeat after the throttle window updates last seen');
set role authenticated;

select pg_temp.as_user(:bob);
update user_settings set last_seen = 'nobody';
select pg_temp.check(get_last_seen(:alice) is null, 'reciprocal: hiding your own last seen hides everyone else''s');
update user_settings set last_seen = 'everyone';
select pg_temp.check(get_last_seen(:alice) is not null, 'visible again after sharing your own');
insert into blocks (blocked_user_id) values (:alice);
select pg_temp.check(get_last_seen(:alice) is null, 'blocking hides last seen (blocker side)');
select pg_temp.as_user(:alice);
select touch_last_seen();
select pg_temp.as_user(:bob);
select touch_last_seen();
select pg_temp.as_user(:alice);
select pg_temp.check(get_last_seen(:bob) is null, 'blocking hides last seen (blocked side)');
select pg_temp.as_user(:bob);
delete from blocks where blocked_user_id = :alice;
set role anon;
select pg_temp.expect_fail(format($$select get_last_seen(%L)$$, 'aaaaaaaa-0000-4000-8000-000000000001'));
select pg_temp.check(true, 'anonymous users cannot query last seen');
set role authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- read receipts backstop
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.as_user(:bob);
update user_settings set read_receipts = false;
select mark_conversation_receipt(pg_temp.id('dm'), 'read');
select pg_temp.check((select last_read_at is null and last_delivered_at is not null from conversation_members
                      where conversation_id = pg_temp.id('dm') and user_id = :bob),
  'read receipts off: read watermark never moves (delivered still does)');
update user_settings set read_receipts = true;
select mark_conversation_receipt(pg_temp.id('dm'), 'read');
select pg_temp.check((select last_read_at is not null from conversation_members
                      where conversation_id = pg_temp.id('dm') and user_id = :bob), 'read receipts on: read watermark moves');

-- ═════════════════════════════════════════════════════════════════════════════
-- presence topics
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.as_user(:alice);
select pg_temp.check(can_use_presence_topic('presence:' || :alice, true), 'users track presence on their own topic');
select pg_temp.as_user(:bob);
select pg_temp.check(not can_use_presence_topic('presence:' || :alice, true), 'nobody else can track on it');
select pg_temp.check(can_use_presence_topic('presence:' || :alice, false), 'chat partners can watch it');
select pg_temp.as_user(:carol);
select pg_temp.check(can_use_presence_topic('presence:' || :alice, false), 'group members can watch it');
select pg_temp.as_user(:dave);
select pg_temp.check(not can_use_presence_topic('presence:' || :alice, false), 'strangers cannot watch it');
select pg_temp.check(not can_use_presence_topic('presence:not-a-uuid', false), 'malformed presence topics are rejected');
select pg_temp.check(not can_use_presence_topic('conversation:' || :alice, false), 'other topic kinds are rejected');

select pg_temp.as_user(:alice);
update user_settings set show_online = false;
select pg_temp.as_user(:bob);
select pg_temp.check(not can_use_presence_topic('presence:' || :alice, false), 'show online off: nobody can watch');
select pg_temp.as_user(:alice);
update user_settings set show_online = true;
select pg_temp.as_user(:bob);
update user_settings set show_online = false;
select pg_temp.check(not can_use_presence_topic('presence:' || :alice, false), 'reciprocal: hiding your online status hides others''');
update user_settings set show_online = true;

-- realtime.messages RLS applies to presence
select set_config('realtime.topic', 'presence:' || :alice, false);
select pg_temp.expect_fail(format($$insert into realtime.messages (topic, extension, payload) values (%L, 'presence', '{}')$$,
  'presence:' || 'aaaaaaaa-0000-4000-8000-000000000001'));
select pg_temp.check(true, 'realtime RLS: others cannot track on a user''s presence topic');
select pg_temp.as_user(:alice);
insert into realtime.messages (topic, extension, payload) values ('presence:' || :alice, 'presence', '{}');
select pg_temp.check(true, 'realtime RLS: the user can track on their own presence topic');
select pg_temp.as_user(:bob);
select pg_temp.check((select count(*) from realtime.messages where extension = 'presence') = 1, 'realtime RLS: a chat partner receives presence');
select pg_temp.as_user(:dave);
select pg_temp.check((select count(*) from realtime.messages where extension = 'presence') = 0, 'realtime RLS: a stranger does not');
select set_config('realtime.topic', '', false);

-- ═════════════════════════════════════════════════════════════════════════════
-- push trigger + targets
-- ═════════════════════════════════════════════════════════════════════════════
reset role;
select pg_temp.check((select count(*) from vault.secrets where name = 'push_webhook_secret') = 1,
  'migration creates the webhook secret in Vault');
select pg_temp.check((select char_length(decrypted_secret) = 64 from vault.decrypted_secrets where name = 'push_webhook_secret'),
  'webhook secret is 256 bits of hex');
set role authenticated;

select pg_temp.as_user(:bob);
insert into push_tokens (device_id, token, platform) values (pg_temp.id('bob_dev'), 'ExponentPushToken[bob-1]', 'android');
insert into push_tokens (device_id, token, platform) values (pg_temp.id('bob_dev2'), 'ExponentPushToken[bob-2]', 'ios');
select pg_temp.as_user(:alice);
insert into push_tokens (device_id, token, platform) values (pg_temp.id('alice_dev'), 'ExponentPushToken[alice-1]', 'ios');
select pg_temp.as_user(:carol);
insert into push_tokens (device_id, token, platform) values (pg_temp.id('carol_dev'), 'ExponentPushToken[carol-1]', 'android');

-- No project_url yet: the trigger must be a silent no-op.
select pg_temp.as_user(:alice);
insert into messages (id, conversation_id, sender_device_id, ciphertext)
values ('10000000-0000-4000-8000-000000000001', pg_temp.id('dm'), pg_temp.id('alice_dev'), 'secret-ciphertext-1');
reset role;
select pg_temp.check((select count(*) from net.http_request_queue) = 0, 'without project_url no request is queued (and the insert succeeds)');
select vault.create_secret('https://example.supabase.co', 'project_url');
set role authenticated;

select pg_temp.as_user(:alice);
insert into messages (id, conversation_id, sender_device_id, ciphertext)
values ('10000000-0000-4000-8000-000000000002', pg_temp.id('dm'), pg_temp.id('alice_dev'), 'secret-ciphertext-2');
reset role;
select pg_temp.check((select count(*) from net.http_request_queue) = 1, 'new message queues one push request');
select pg_temp.check((select url = 'https://example.supabase.co/functions/v1/send-push' from net.http_request_queue),
  'request goes to the send-push function');
select pg_temp.check((select headers ->> 'x-webhook-secret' = (select decrypted_secret from vault.decrypted_secrets where name = 'push_webhook_secret')
                      from net.http_request_queue), 'request carries the Vault webhook secret');
select pg_temp.check((select body = jsonb_build_object('message_id', '10000000-0000-4000-8000-000000000002',
                                                      'conversation_id', pg_temp.id('dm'), 'type', 'message')
                      from net.http_request_queue), 'request body is ids only');
select pg_temp.check((select position('secret-ciphertext' in body::text) = 0 from net.http_request_queue),
  'ciphertext never leaves the database');
set role authenticated;

select pg_temp.as_user(:alice);
insert into messages (conversation_id, sender_device_id, ciphertext, message_type)
values (pg_temp.id('dm'), pg_temp.id('alice_dev'), 'r', 'reaction');
insert into messages (conversation_id, sender_device_id, ciphertext, message_type)
values (pg_temp.id('dm'), pg_temp.id('alice_dev'), 's', 'system');
reset role;
select pg_temp.check((select count(*) from net.http_request_queue) = 1, 'reactions and system messages do not push');

-- Webhook secret check (service role only)
create temp table hook_secret as select decrypted_secret as v from vault.decrypted_secrets where name = 'push_webhook_secret';
grant select on hook_secret to service_role;
set role service_role;
select pg_temp.check(verify_push_webhook_secret((select v from hook_secret)),
  'correct webhook secret verifies');
select pg_temp.check(not verify_push_webhook_secret(repeat('0', 64)), 'wrong webhook secret is rejected');
select pg_temp.check(not verify_push_webhook_secret(''), 'empty webhook secret is rejected');
select pg_temp.check(not verify_push_webhook_secret(null), 'missing webhook secret is rejected');

select pg_temp.check((select count(*) from get_message_push_targets('10000000-0000-4000-8000-000000000002')) = 2,
  'targets: every device of every other member');
select pg_temp.check(not exists (select 1 from get_message_push_targets('10000000-0000-4000-8000-000000000002') where user_id = :alice),
  'targets: never the sender''s own devices');
select pg_temp.check((select bool_and(not previews) from get_message_push_targets('10000000-0000-4000-8000-000000000002')),
  'targets: previews off by default');
reset role;
update user_settings set notification_previews = true where user_id = :bob;
set role service_role;
select pg_temp.check((select bool_and(previews) and min(sender_name) = 'Alice' from get_message_push_targets('10000000-0000-4000-8000-000000000002')),
  'targets: previews follow the recipient''s setting');
reset role;

set role authenticated;
select pg_temp.as_user(:bob);
select pg_temp.expect_fail($$select * from get_message_push_targets('10000000-0000-4000-8000-000000000002')$$);
select pg_temp.check(true, 'clients cannot call the push target RPCs');
select pg_temp.expect_fail($$select verify_push_webhook_secret('x')$$);
select pg_temp.check(true, 'clients cannot probe the webhook secret');
select pg_temp.expect_fail($$select send_push_event('message', '{}')$$);
select pg_temp.check(true, 'clients cannot queue arbitrary pushes');
select pg_temp.expect_fail($$select * from vault.decrypted_secrets$$);
select pg_temp.check(true, 'clients cannot read Vault');

-- Muting suppresses the request and the targets.
select mute_conversation(pg_temp.id('dm'), now() + interval '1 hour');
select pg_temp.as_user(:alice);
insert into messages (id, conversation_id, sender_device_id, ciphertext)
values ('10000000-0000-4000-8000-000000000003', pg_temp.id('dm'), pg_temp.id('alice_dev'), 'x');
reset role;
select pg_temp.check((select count(*) from net.http_request_queue) = 1, 'muted chat: no push request');
set role service_role;
select pg_temp.check((select count(*) from get_message_push_targets('10000000-0000-4000-8000-000000000003')) = 0,
  'muted chat: no targets');
reset role;

-- Group: bob's dm mute does not affect the group.
set role authenticated;
select pg_temp.as_user(:alice);
insert into messages (id, conversation_id, sender_device_id, ciphertext)
values ('10000000-0000-4000-8000-000000000004', pg_temp.id('grp'), pg_temp.id('alice_dev'), 'x');
reset role;
select pg_temp.check((select count(*) from net.http_request_queue) = 2, 'group message pushes');
set role service_role;
select pg_temp.check((select count(*) from get_message_push_targets('10000000-0000-4000-8000-000000000004')) = 3,
  'group targets: bob''s two devices and carol''s');
select pg_temp.check((select group_name = 'Hikers' and conversation_type = 'group'
                      from get_message_push_targets('10000000-0000-4000-8000-000000000004') limit 1), 'group targets carry the group name');
reset role;

-- Blocking the sender drops the blocker from group pushes.
set role authenticated;
select pg_temp.as_user(:carol);
insert into blocks (blocked_user_id) values (:alice);
reset role;
set role service_role;
select pg_temp.check(not exists (select 1 from get_message_push_targets('10000000-0000-4000-8000-000000000004') where user_id = :carol),
  'members who blocked the sender are not woken');
reset role;

-- Revoking a device deletes its push token.
set role authenticated;
select pg_temp.as_user(:bob);
update devices set revoked_at = now() where id = pg_temp.id('bob_dev2');
reset role;
select pg_temp.check(not exists (select 1 from push_tokens where device_id = pg_temp.id('bob_dev2')), 'revoking a device clears its push token');
select pg_temp.check(exists (select 1 from push_tokens where device_id = pg_temp.id('bob_dev')), 'other devices keep their tokens');

-- Calls
set role authenticated;
select pg_temp.as_user(:bob);
select mute_conversation(pg_temp.id('dm'), null);
select pg_temp.as_user(:alice);
insert into ids values ('call', start_call(pg_temp.id('dm'), 'video'));
reset role;
set role service_role;
select pg_temp.check((select count(*) from get_call_push_targets(pg_temp.id('call'))) = 1, 'call targets: the callee''s active devices');
select pg_temp.check((select caller_name = 'Alice' and call_type = 'video' from get_call_push_targets(pg_temp.id('call'))),
  'call targets carry caller and type');
select pg_temp.check((select count(*) from get_call_push_targets(pg_temp.id('call'), :alice)) = 1, 'the caller may request the call push');
select pg_temp.check((select count(*) from get_call_push_targets(pg_temp.id('call'), :bob)) = 0, 'nobody else may');
reset role;
update call_sessions set status = 'ended' where id = pg_temp.id('call');
set role service_role;
select pg_temp.check((select count(*) from get_call_push_targets(pg_temp.id('call'))) = 0, 'no push once the call stopped ringing');
select pg_temp.check(send_push_event('call', jsonb_build_object('call_id', pg_temp.id('call'))) is not null,
  'send_push_event is reusable for calls');
reset role;
select pg_temp.check((select body ->> 'type' = 'call' from net.http_request_queue order by id desc limit 1), 'call push request has type call');

-- Channel posts (the trigger is created after 007, as documented)
create trigger channel_posts_push_after_insert after insert on public.channel_posts
  for each row execute function public.channel_posts_push_after_insert();
set role authenticated;
select pg_temp.as_user(:alice);
insert into ids values ('ch', create_channel('Trail News', 'trail_news', 'Updates', 'public'));
select pg_temp.as_user(:bob);
select follow_channel(pg_temp.id('ch'));
select pg_temp.as_user(:carol);
select follow_channel(pg_temp.id('ch'));
select set_channel_muted(pg_temp.id('ch'), true);
select pg_temp.as_user(:alice);
insert into channel_posts (channel_id, body) values (pg_temp.id('ch'), 'Trail closed');
reset role;
insert into ids select 'post', id from channel_posts where channel_id = pg_temp.id('ch');
select pg_temp.check((select body = jsonb_build_object('post_id', pg_temp.id('post'), 'type', 'channel_post')
                      from net.http_request_queue order by id desc limit 1), 'channel post queues a push with the post id only');
set role service_role;
select pg_temp.check((select array_agg(distinct user_id) = array[:bob]::uuid[] from get_channel_post_push_targets(pg_temp.id('post'))),
  'channel targets: non-muted followers only');
reset role;

-- ═════════════════════════════════════════════════════════════════════════════
-- backup storage
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.check((select not public from storage.buckets where id = 'vero-backups'), 'backup bucket is private');
set role authenticated;
select pg_temp.as_user(:alice);
insert into storage.objects (bucket_id, name) values ('vero-backups', :alice || '/backup.bin');
select pg_temp.check(true, 'users upload into their own backup folder');
select pg_temp.expect_fail(format($$insert into storage.objects (bucket_id, name) values ('vero-backups', %L)$$,
  'bbbbbbbb-0000-4000-8000-000000000002/backup.bin'));
select pg_temp.check(true, 'users cannot upload into someone else''s folder');
select pg_temp.expect_fail($$insert into storage.objects (bucket_id, name) values ('vero-backups', 'backup.bin')$$);
select pg_temp.check(true, 'uploads outside a user folder are rejected');
update storage.objects set updated_at = now() where bucket_id = 'vero-backups';
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'vero-backups') = 1, 'owner lists own backup');

select pg_temp.as_user(:bob);
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'vero-backups') = 0, 'others cannot see the backup');
update storage.objects set metadata = '{"x":1}' where bucket_id = 'vero-backups';
delete from storage.objects where bucket_id = 'vero-backups';
reset role;
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'vero-backups' and metadata is null) = 1,
  'others cannot overwrite or delete the backup');
set role authenticated;
select pg_temp.as_user(:alice);
delete from storage.objects where bucket_id = 'vero-backups';
reset role;
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'vero-backups') = 0, 'owner deletes own backup');

\o
\echo ALL SETTINGS/PUSH/BACKUP TESTS PASSED
