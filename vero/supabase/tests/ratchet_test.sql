-- X3DH prekeys: RLS / RPC behaviour tests (003_ratchet.sql). Run with scripts/test-db.sh.
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

-- base64url key material of the right sizes
create function pg_temp.k(p_c text) returns text language sql as $$ select repeat(p_c, 43) $$;
create function pg_temp.sig(p_c text) returns text language sql as $$ select repeat(p_c, 86) $$;
create function pg_temp.opks(p_from int, p_n int) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i, 'public_key', repeat(chr(65 + i % 26), 43)) order by i), '[]')
  from generate_series(p_from, p_from + p_n - 1) i
$$;

set client_min_messages = notice;

\set alice '''aaaaaaaa-0000-4000-8000-000000000001'''
\set bob   '''bbbbbbbb-0000-4000-8000-000000000002'''
\set carol '''cccccccc-0000-4000-8000-000000000003'''

insert into auth.users (id, raw_user_meta_data) values
  (:alice, '{"username":"alice"}'),
  (:bob,   '{"username":"bob"}'),
  (:carol, '{"username":"carol"}');

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated;

set role authenticated;

select pg_temp.as_user(:alice);
with d as (insert into devices (identity_public_key) values (repeat('A', 43)) returning id)
insert into ids select 'alice_dev', id from d;
with d as (insert into devices (identity_public_key) values (repeat('Z', 43)) returning id)
insert into ids select 'alice_dev2', id from d;
with d as (insert into devices (identity_public_key) values (repeat('Y', 43)) returning id)
insert into ids select 'alice_legacy', id from d;
select pg_temp.as_user(:bob);
with d as (insert into devices (identity_public_key) values (repeat('B', 43)) returning id)
insert into ids select 'bob_dev', id from d;
select pg_temp.as_user(:carol);
with d as (insert into devices (identity_public_key) values (repeat('C', 43)) returning id)
insert into ids select 'carol_dev', id from d;

-- Alice and Bob share a direct chat; Carol is a stranger to both.
select pg_temp.as_user(:alice);
select create_direct_conversation(:bob);

-- ── signing keys ─────────────────────────────────────────────────────────────
select publish_device_signing_key((select id from ids where name = 'alice_dev'), pg_temp.k('s'), pg_temp.sig('x'));
select publish_device_signing_key((select id from ids where name = 'alice_dev'), pg_temp.k('s'), pg_temp.sig('x'));
select pg_temp.check(true, 'publishing the same signing key twice is idempotent');

select pg_temp.expect_fail(format($$select publish_device_signing_key(%L, %L, %L)$$,
  (select id from ids where name = 'alice_dev'), pg_temp.k('t'), pg_temp.sig('x')));
select pg_temp.check(true, 'a device''s signing key cannot be replaced');

select pg_temp.expect_fail(format($$select publish_device_signing_key(%L, %L, %L)$$,
  (select id from ids where name = 'bob_dev'), pg_temp.k('s'), pg_temp.sig('x')));
select pg_temp.check(true, 'cannot publish a signing key for someone else''s device');

select pg_temp.expect_fail(format($$select publish_device_signing_key(%L, %L, %L)$$,
  (select id from ids where name = 'alice_dev2'), 'short', pg_temp.sig('x')));
select pg_temp.expect_fail(format($$select publish_device_signing_key(%L, %L, %L)$$,
  (select id from ids where name = 'alice_dev2'), pg_temp.k('s'), repeat('+', 86)));
select pg_temp.check(true, 'malformed signing keys / signatures are refused');

select pg_temp.expect_fail($$update devices set signing_public_key = repeat('q', 43), identity_signature = repeat('q', 86)$$);
select pg_temp.check(true, 'signing keys cannot be changed with a direct UPDATE');

-- ── uploads ──────────────────────────────────────────────────────────────────
select pg_temp.expect_fail(format($$select upload_prekeys(%L, %L::jsonb, '[]')$$,
  (select id from ids where name = 'alice_dev2'),
  jsonb_build_object('id', 1, 'public_key', pg_temp.k('p'), 'signature', pg_temp.sig('q'))));
select pg_temp.check(true, 'prekeys need a published signing key first');

select pg_temp.check(
  upload_prekeys((select id from ids where name = 'alice_dev'),
    jsonb_build_object('id', 7, 'public_key', pg_temp.k('p'), 'signature', pg_temp.sig('q')),
    pg_temp.opks(1, 3)) = 3,
  'upload_prekeys stores the signed prekey and one-time prekeys and returns the count');
select pg_temp.check(upload_prekeys((select id from ids where name = 'alice_dev'), null, pg_temp.opks(1, 3)) = 3,
  're-uploading the same one-time prekey ids is a no-op');
select pg_temp.check(
  (select one_time_count = 3 and signed_prekey_id = 7 from get_prekey_status((select id from ids where name = 'alice_dev'))),
  'get_prekey_status reports the pool and the served signed prekey');

select pg_temp.expect_fail(format($$select upload_prekeys(%L, null, %L::jsonb)$$,
  (select id from ids where name = 'alice_dev'), pg_temp.opks(100, 101)));
select pg_temp.check(true, 'at most 100 one-time prekeys per upload');
select pg_temp.expect_fail(format($$select upload_prekeys(%L, null, %L::jsonb)$$,
  (select id from ids where name = 'alice_dev'), '[{"id": 9, "public_key": "x"}]'));
select pg_temp.expect_fail(format($$select upload_prekeys(%L, '{"id": "x"}'::jsonb, null)$$,
  (select id from ids where name = 'alice_dev')));
select pg_temp.check(true, 'malformed prekeys are refused');

select pg_temp.as_user(:bob);
select pg_temp.expect_fail(format($$select upload_prekeys(%L, null, %L::jsonb)$$,
  (select id from ids where name = 'alice_dev'), pg_temp.opks(50, 2)));
select pg_temp.expect_fail(format($$select * from get_prekey_status(%L)$$, (select id from ids where name = 'alice_dev')));
select pg_temp.check(true, 'cannot upload to or inspect someone else''s device');

select pg_temp.expect_fail($$select count(*) from one_time_prekeys$$);
select pg_temp.expect_fail($$select count(*) from signed_prekeys$$);
select pg_temp.expect_fail(format($$insert into one_time_prekeys (device_id, key_id, public_key) values (%L, 99, %L)$$,
  (select id from ids where name = 'alice_dev'), pg_temp.k('e')));
select pg_temp.expect_fail($$delete from one_time_prekeys$$);
select pg_temp.check(true, 'prekey tables are not directly readable or writable');

-- ── claiming ─────────────────────────────────────────────────────────────────
select pg_temp.check(
  (select signing_public_key = pg_temp.k('s') from get_device_signing_keys(array[(select id from ids where name = 'alice_dev')])),
  'get_device_signing_keys serves contacts'' signing keys');

create temp table claimed (round int, device_id uuid, opk_id int, spk_id int, signing text);
grant all on claimed to authenticated;

insert into claimed select 1, device_id, one_time_prekey_id, signed_prekey_id, signing_public_key
  from claim_prekey_bundle(array[(select id from ids where name = 'alice_dev'), (select id from ids where name = 'alice_dev2'),
                                 (select id from ids where name = 'alice_legacy')]);
select pg_temp.check((select count(*) from claimed) = 1,
  'only devices with a signing key and a signed prekey are returned');
select pg_temp.check((select opk_id = 1 and spk_id = 7 and signing = pg_temp.k('s') from claimed where round = 1),
  'a bundle carries the signed prekey and the oldest one-time prekey');

insert into claimed select 2, device_id, one_time_prekey_id, signed_prekey_id, signing_public_key
  from claim_prekey_bundle(array[(select id from ids where name = 'alice_dev')]);
insert into claimed select 3, device_id, one_time_prekey_id, signed_prekey_id, signing_public_key
  from claim_prekey_bundle(array[(select id from ids where name = 'alice_dev'), (select id from ids where name = 'alice_dev')]);
select pg_temp.check((select array_agg(opk_id order by round) from claimed) = array[1, 2, 3],
  'each claim consumes a different one-time prekey (a repeated id is claimed once)');

insert into claimed select 4, device_id, one_time_prekey_id, signed_prekey_id, signing_public_key
  from claim_prekey_bundle(array[(select id from ids where name = 'alice_dev')]);
select pg_temp.check((select opk_id is null and spk_id = 7 from claimed where round = 4),
  'an exhausted pool still yields a bundle without a one-time prekey');

select pg_temp.as_user(:alice);
select pg_temp.check((select one_time_count = 0 from get_prekey_status((select id from ids where name = 'alice_dev'))),
  'claimed one-time prekeys are deleted');

select pg_temp.as_user(:carol);
select pg_temp.check(
  (select count(*) from claim_prekey_bundle(array[(select id from ids where name = 'alice_dev')])) = 0,
  'strangers cannot claim bundles');
select pg_temp.check(
  (select count(*) from get_device_signing_keys(array[(select id from ids where name = 'alice_dev')])) = 0,
  'strangers cannot read signing keys');

-- Own devices: Alice's second device may claim her first device's bundle.
select pg_temp.as_user(:alice);
select upload_prekeys((select id from ids where name = 'alice_dev'), null, pg_temp.opks(10, 2));
select pg_temp.check(
  (select one_time_prekey_id = 10 from claim_prekey_bundle(array[(select id from ids where name = 'alice_dev')])),
  'a user can claim bundles of their own other devices');

-- Rate limit: past 1000 one-time prekeys per hour, bundles come without one.
reset role;
update prekey_claim_usage set claimed = 1000 where user_id = :bob;
set role authenticated;
select pg_temp.as_user(:bob);
select pg_temp.check(
  (select one_time_prekey_id is null from claim_prekey_bundle(array[(select id from ids where name = 'alice_dev')])),
  'draining is rate-limited (no one-time prekey beyond the hourly budget)');
select pg_temp.as_user(:alice);
select pg_temp.check((select one_time_count = 1 from get_prekey_status((select id from ids where name = 'alice_dev'))),
  'the rate-limited claim did not consume a one-time prekey');

-- ── concurrency: FOR UPDATE SKIP LOCKED ──────────────────────────────────────
-- A second connection locks the oldest one-time prekey in an open transaction;
-- a concurrent claim must neither block nor hand out that key.
select upload_prekeys((select id from ids where name = 'alice_dev'), null, pg_temp.opks(20, 2));
reset role;
delete from prekey_claim_usage;
create extension if not exists dblink;
select dblink_connect('locker', 'dbname=' || current_database());
select dblink_exec('locker', 'begin');
select * from dblink('locker', format(
  'select key_id from public.one_time_prekeys where device_id = %L order by created_at, key_id limit 1 for update',
  (select id from ids where name = 'alice_dev'))) as t(key_id int);
set lock_timeout = '3s';
set role authenticated;
select pg_temp.as_user(:bob);
truncate claimed;
insert into claimed select 5, device_id, one_time_prekey_id, signed_prekey_id, signing_public_key
  from claim_prekey_bundle(array[(select id from ids where name = 'alice_dev')]);
reset role;
select pg_temp.check((select opk_id from claimed where round = 5) = 20,
  'a locked one-time prekey is skipped, not waited for (key 11 is locked by another transaction)');
select dblink_exec('locker', 'rollback');
select dblink_disconnect('locker');
reset lock_timeout;
select pg_temp.check((select count(*) from one_time_prekeys where key_id = 11) = 1,
  'the skipped key is still available after the other transaction ends');

-- ── revocation ───────────────────────────────────────────────────────────────
set role authenticated;
select pg_temp.as_user(:alice);
update devices set revoked_at = now() where id = (select id from ids where name = 'alice_dev');
select pg_temp.as_user(:bob);
select pg_temp.check(
  (select count(*) from claim_prekey_bundle(array[(select id from ids where name = 'alice_dev')])) = 0,
  'revoked devices have no bundle');
reset role;
select pg_temp.check(
  not exists (select 1 from one_time_prekeys where device_id = (select id from ids where name = 'alice_dev'))
  and not exists (select 1 from signed_prekeys where device_id = (select id from ids where name = 'alice_dev')),
  'revoking a device deletes its prekeys');

-- ── anon ─────────────────────────────────────────────────────────────────────
set role anon;
select pg_temp.as_user(null);
select pg_temp.expect_fail($$select * from claim_prekey_bundle(array[gen_random_uuid()])$$);
select pg_temp.expect_fail($$select upload_prekeys(gen_random_uuid(), null, null)$$);
select pg_temp.check(true, 'anonymous users cannot claim or upload prekeys');
reset role;

\echo 'ALL RATCHET TESTS PASSED'
