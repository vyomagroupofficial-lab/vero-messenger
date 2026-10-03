-- Bots table RLS, is_bot flag, command/URL validation, webhook pings (012).
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

\set alice '''aaaaaaaa-0000-4000-8000-000000000001'''
\set carol '''cccccccc-0000-4000-8000-000000000003'''
\set dave  '''dddddddd-0000-4000-8000-000000000004'''
\set bot   '''b0b0b0b0-0000-4000-8000-000000000005'''
\set hash  '''aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'''

insert into auth.users (id, raw_user_meta_data) values
  (:alice, '{"username":"alice"}'),
  (:carol, '{"username":"carol"}'),
  (:dave,  '{"username":"dave"}'),
  (:bot,   '{"username":"echo_bot","display_name":"Echo"}');

-- Stand-in for pg_net so the webhook trigger can be observed.
create schema net;
create table net.calls (url text, body jsonb);
create function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer)
returns bigint language sql as $$ insert into net.calls values (url, body); select 1::bigint $$;
grant usage on schema net to authenticated;
grant insert on net.calls to authenticated;

select pg_temp.check(not (select is_bot from profiles where id = :bot), 'profiles are not bots by default');

-- ── creation (service role, as the bot-admin function does) ─────────────────
set role service_role;
insert into bots (user_id, owner_id, name, description, commands, token_hash, webhook_url)
values (:bot, :alice, 'Echo', 'Repeats what you say',
        '[{"command":"start","description":"Say hi"},{"command":"echo","description":"Echo text"}]',
        :hash, 'https://bots.example.com/hook');
select pg_temp.expect_fail($$insert into bots (user_id, owner_id, name, token_hash) values ('dddddddd-0000-4000-8000-000000000004', 'b0b0b0b0-0000-4000-8000-000000000005', 'Nested', repeat('b', 64))$$);
select pg_temp.check(true, 'bots cannot own bots');
reset role;

select pg_temp.check((select is_bot from profiles where id = :bot), 'creating a bot row flags its profile is_bot');

-- ── owner ───────────────────────────────────────────────────────────────────
set role authenticated;
select pg_temp.as_user(:alice);
select pg_temp.check((select count(*) from bots where owner_id = :alice) = 1, 'owner sees their private bot');
select pg_temp.expect_fail($$select token_hash from bots$$);
select pg_temp.check(true, 'token hash is not readable');
select pg_temp.expect_fail($$select webhook_url from bots$$);
select pg_temp.check((select webhook_url from my_bots()) = 'https://bots.example.com/hook', 'owner reads webhook via my_bots()');
select pg_temp.check((select username from my_bots()) = 'echo_bot', 'my_bots() includes the bot username');

update bots set description = 'Echoes', is_public = true,
  commands = '[{"command":"help","description":"Show help"}]', mini_app_url = 'https://app.example.com/mini'
where user_id = :bot;
select pg_temp.check((select description from bots where user_id = :bot) = 'Echoes', 'owner edits description/commands/mini-app/visibility');

select pg_temp.expect_fail($$update bots set token_hash = repeat('c', 64)$$);
select pg_temp.expect_fail($$update bots set owner_id = 'cccccccc-0000-4000-8000-000000000003'$$);
select pg_temp.expect_fail($$update bots set name = 'Renamed'$$);
select pg_temp.check(true, 'owner cannot change token hash, owner or name directly');
select pg_temp.expect_fail($$insert into bots (user_id, owner_id, name, token_hash) values ('dddddddd-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', 'X', repeat('d', 64))$$);
select pg_temp.expect_fail($$delete from bots$$);
select pg_temp.check(true, 'clients cannot create or delete bot rows (bot-admin only)');

select pg_temp.expect_fail($$update bots set commands = '[{"command":"Bad Command"}]'$$);
select pg_temp.expect_fail($$update bots set commands = '{"command":"x"}'$$);
select pg_temp.check(true, 'malformed command lists are rejected');
select pg_temp.expect_fail($$update bots set mini_app_url = 'http://app.example.com'$$);
select pg_temp.expect_fail($$update bots set mini_app_url = 'javascript:alert(1)'$$);
select pg_temp.expect_fail($$update bots set mini_app_url = 'https://127.0.0.1/x'$$);
select pg_temp.expect_fail($$update bots set webhook_url = 'https://localhost/hook'$$);
select pg_temp.check(true, 'mini-app and webhook URLs must be https with a real host name');

-- ── other users ─────────────────────────────────────────────────────────────
select pg_temp.as_user(:carol);
select pg_temp.check((select count(*) from bots) = 1, 'public bots are visible in the directory');
select pg_temp.check((select count(*) from my_bots()) = 0, 'my_bots() shows only your own bots');
update bots set description = 'pwned';
select pg_temp.check(not exists (select 1 from bots where description = 'pwned'), 'non-owners cannot edit a bot');
select pg_temp.expect_fail($$update profiles set is_bot = false$$);
select pg_temp.check(true, 'users cannot set the is_bot flag');

select pg_temp.as_user(:alice);
update bots set is_public = false;
select pg_temp.as_user(:dave);
select pg_temp.check((select count(*) from bots) = 0, 'private bots are hidden from strangers');

-- Someone chatting with a private bot can see its commands.
select pg_temp.as_user(:carol);
select pg_temp.check((select count(*) from bots) = 0, 'private bot hidden before chatting');
create temp table ids (name text primary key, id uuid);
insert into ids values ('dm', create_direct_conversation(:bot));
select pg_temp.check((select count(*) from bots) = 1, 'chat partners of a private bot see its command menu');

-- ── webhook wake-up ping ────────────────────────────────────────────────────
with d as (insert into devices (identity_public_key) values (repeat('C', 43)) returning id)
insert into ids select 'carol_dev', id from d;
insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext)
select (select id from ids where name = 'dm'), (select id from ids where name = 'carol_dev'), :carol, '{"v":2}';
reset role;
select pg_temp.check((select count(*) from net.calls) = 1, 'new message pings the bot webhook');
select pg_temp.check((select body ? 'ciphertext' from net.calls limit 1) is false
  and (select body ->> 'conversation_id' from net.calls limit 1) = (select id::text from ids where name = 'dm'),
  'webhook ping carries ids only, never ciphertext');

-- Messages sent BY the bot don't ping its own webhook.
set role authenticated;
select pg_temp.as_user(:bot);
with d as (insert into devices (identity_public_key) values (repeat('E', 43)) returning id)
insert into ids select 'bot_dev', id from d;
insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext)
select (select id from ids where name = 'dm'), (select id from ids where name = 'bot_dev'), :bot, '{"v":2}';
reset role;
select pg_temp.check((select count(*) from net.calls) = 1, 'bot replies do not ping its own webhook');

-- Without pg_net the trigger is a no-op.
drop schema net cascade;
set role authenticated;
select pg_temp.as_user(:carol);
insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext)
select (select id from ids where name = 'dm'), (select id from ids where name = 'carol_dev'), :carol, '{"v":2}';
select pg_temp.check(true, 'messages still send when pg_net is not installed');
reset role;

-- ── per-owner bot limit ─────────────────────────────────────────────────────
insert into auth.users (id, raw_user_meta_data)
select ('eeeeeeee-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, jsonb_build_object('username', 'limit_bot_' || g)
from generate_series(1, 21) g;
set role service_role;
insert into bots (user_id, owner_id, name, token_hash)
select ('eeeeeeee-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, :dave, 'Bot ' || g, repeat('f', 64)
from generate_series(1, 20) g;
select pg_temp.expect_fail($$insert into bots (user_id, owner_id, name, token_hash) values ('eeeeeeee-0000-4000-8000-000000000021', 'dddddddd-0000-4000-8000-000000000004', 'One too many', repeat('f', 64))$$);
select pg_temp.check(true, 'an owner can have at most 20 bots');
reset role;

-- Deleting the bot account removes its bot row.
delete from auth.users where id = :bot;
select pg_temp.check(not exists (select 1 from bots where user_id = :bot), 'deleting the bot user deletes the bot');

\echo 'ALL BOT DATABASE TESTS PASSED'
