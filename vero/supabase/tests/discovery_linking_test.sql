-- Contact discovery, device linking and chat transfer (migration 009).
-- Run with scripts/test-db.sh.
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

create function pg_temp.expect_state(p_sql text, p_state text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED FAILURE but statement succeeded: %', p_sql;
exception when others then
  if sqlerrm like 'EXPECTED FAILURE%' then raise; end if;
  if sqlstate <> p_state then
    raise exception 'expected SQLSTATE % but got % (%)', p_state, sqlstate, sqlerrm;
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

\set dana  '''d0000000-0009-4000-8000-000000000001'''
\set eve   '''e0000000-0009-4000-8000-000000000002'''
\set frank '''f0000000-0009-4000-8000-000000000003'''
\set gina  '''a0000000-0009-4000-8000-000000000004'''

-- Hash vectors shared with tests/discovery.test.ts
\set dana_email_hash  '''645e345205eccdcd97958f6766b048d6add440894c96d549646681f4c461604b'''
\set dana_phone_hash  '''cb6ccfcd02605c85f8eac961890666fdef76db77fab037b15381b7d7be74ec5c'''
\set frank_email_hash '''3bf0b1a3b38495056c540e51371afee0f3bbd566dcf82505b6a4b62f23bad2f2'''
\set frank_phone_hash '''ed36fa59de1a3bbeef436f1b46e8183eafd470a8d0f2390ee589188b996eab7e'''

insert into auth.users (id, email, email_confirmed_at, phone, phone_confirmed_at, raw_user_meta_data) values
  (:dana,  'Dana@Example.com',  now(), '919876543210', now(), '{"username":"dana_d","display_name":"Dana"}'),
  (:eve,   'eve@example.com',   now(), null,           null,  '{"username":"eve_e","display_name":"Eve"}'),
  (:frank, 'frank@example.com', now(), '14155550100',  null,  '{"username":"frank_f","display_name":"Frank"}'),
  (:gina,  'gina@example.com',  null,  null,           null,  '{"username":"gina_g","display_name":"Gina"}');

select pg_temp.check(public.discovery_hash('email', 'dana@example.com') = :dana_email_hash
  and public.discovery_hash('phone', '+919876543210') = :dana_phone_hash,
  'server hash format matches the client vectors');
select pg_temp.check(public.discovery_normalize_phone('919876543210') = '+919876543210'
  and public.discovery_normalize_phone('+1 (415) 555-0100') = '+14155550100'
  and public.discovery_normalize_phone('012') is null, 'auth phone numbers are normalised to E.164');

create temp table t (name text primary key, id uuid, txt text);
grant all on t to authenticated, service_role;

set role authenticated;

-- ── discovery: opt-in ────────────────────────────────────────────────────────
select pg_temp.as_user(:dana);
select pg_temp.check((select not discoverable_by_email and not email_listed from get_discoverability()),
  'discovery is off by default');
select pg_temp.check(
  (select email_listed and phone_listed and phone_hint = '•••3210' from set_discoverability(true, true)),
  'opting in lists verified email and phone');
select pg_temp.expect_fail($$select * from discovery_identifiers$$);
select pg_temp.check(true, 'clients cannot read the identifier table');
select pg_temp.expect_fail($$insert into discovery_settings (user_id, discoverable_by_email) values (auth.uid(), true)$$);
select pg_temp.expect_fail($$update discovery_settings set discoverable_by_phone = false$$);
select pg_temp.check(true, 'discovery settings are only written through the RPC');
select pg_temp.expect_fail($$select public.refresh_discovery_identifiers(auth.uid())$$);
select pg_temp.check(true, 'internal refresh function is not callable by clients');

select pg_temp.as_user(:frank);
select pg_temp.check((select email_listed and not phone_listed from set_discoverability(true, true)),
  'an unverified phone is never listed');
select pg_temp.as_user(:gina);
select pg_temp.check((select not email_listed from set_discoverability(true, false)),
  'an unverified email is never listed');

-- ── discovery: lookup ───────────────────────────────────────────────────────
select pg_temp.as_user(:eve);
select pg_temp.check(
  (select count(*) from discovery_lookup(array[left(:dana_email_hash, 4), left(:dana_phone_hash, 4)])
   where user_id = :dana and identifier_hash in (:dana_email_hash, :dana_phone_hash)) = 2,
  'lookup by prefix returns the full hashes of a discoverable user');
select pg_temp.check(
  (select username from discovery_lookup(array[left(:dana_email_hash, 4)]) where identifier_hash = :dana_email_hash) = 'dana_d',
  'lookup returns the username');
select pg_temp.check(
  not exists (select 1 from discovery_lookup(array[left(:frank_phone_hash, 4)]) where user_id = :frank),
  'unverified phone is not returned');
select pg_temp.check(
  not exists (select 1 from discovery_lookup(array[left(encode(sha256('vero-discovery-v1|email|gina@example.com'), 'hex'), 4)])
              where user_id = :gina),
  'unverified email is not returned');
select pg_temp.check(
  not exists (select 1 from discovery_lookup(array[left(encode(sha256('vero-discovery-v1|email|eve@example.com'), 'hex'), 4)])
              where user_id = :eve),
  'users who did not opt in are never returned');
select pg_temp.expect_state($$select * from discovery_lookup(array['ABCD'])$$, '22023');
select pg_temp.expect_state($$select * from discovery_lookup(array['abcdef'])$$, '22023');
select pg_temp.expect_state($$select * from discovery_lookup(array['ab'])$$, '22023');
select pg_temp.expect_state($$select * from discovery_lookup(array['ab%'])$$, '22023');
select pg_temp.check(true, 'malformed / too long / too short / wildcard prefixes are rejected');

select pg_temp.as_user(:dana);
select pg_temp.check(not exists (select 1 from discovery_lookup(array[left(:dana_email_hash, 4)]) where user_id = :dana),
  'lookup never returns the caller');
insert into blocks (blocked_user_id) values (:eve);
select pg_temp.as_user(:eve);
select pg_temp.check(not exists (select 1 from discovery_lookup(array[left(:dana_email_hash, 4)]) where user_id = :dana),
  'blocked users are not returned');
select pg_temp.as_user(:dana);
delete from blocks where blocked_user_id = :eve;

select pg_temp.check((select not email_listed and not phone_listed from set_discoverability(false, false)),
  'opting out removes the hashes');
select pg_temp.as_user(:eve);
select pg_temp.check(not exists (select 1 from discovery_lookup(array[left(:dana_email_hash, 4)]) where user_id = :dana),
  'after opting out the user is no longer found');
select pg_temp.as_user(:dana);
select * from set_discoverability(true, true) \g /dev/null

-- auth.users changes keep the hashes in sync
reset role;
update auth.users set phone_confirmed_at = now() where id = :frank;
update auth.users set email = 'dana@new.example' where id = :dana;
set role authenticated;
select pg_temp.as_user(:eve);
select pg_temp.check(exists (select 1 from discovery_lookup(array[left(:frank_phone_hash, 4)])
                             where user_id = :frank and identifier_hash = :frank_phone_hash),
  'verifying a phone later lists it (trigger)');
select pg_temp.check(not exists (select 1 from discovery_lookup(array[left(:dana_email_hash, 4)])
                                 where identifier_hash = :dana_email_hash),
  'changing email drops the old hash (trigger)');

-- ── discovery: rate limit ───────────────────────────────────────────────────
select pg_temp.as_user(:frank);
select count(*) from discovery_lookup((select array_agg(lpad(to_hex(g), 4, '0')) from generate_series(0, 1999) g)) \g /dev/null
select count(*) from discovery_lookup((select array_agg(lpad(to_hex(g), 4, '0')) from generate_series(2000, 3999) g)) \g /dev/null
select pg_temp.expect_state($$select count(*) from discovery_lookup((select array_agg(lpad(to_hex(g), 4, '0')) from generate_series(4000, 5999) g))$$, 'PT429');
select pg_temp.check((select prefix_count from discovery_lookup_usage where user_id = auth.uid()) = 4000,
  'daily prefix budget is enforced (rejected requests are not counted)');
select pg_temp.expect_state($$select count(*) from discovery_lookup((select array_agg(lpad(to_hex(g), 4, '0')) from generate_series(0, 2000) g))$$, '22023');
select pg_temp.check(true, 'per-request prefix cap is enforced');

select pg_temp.as_user(:gina);
do $$ begin for i in 1..30 loop perform count(*) from public.discovery_lookup(array['abc']); end loop; end $$;
select pg_temp.expect_state($$select count(*) from discovery_lookup(array['abc'])$$, 'PT429');
select pg_temp.check(true, 'daily request budget is enforced');
select pg_temp.as_user(:eve);
select pg_temp.check((select count(*) from discovery_lookup_usage) = 1, 'users only see their own usage row');
select pg_temp.as_user(null);
select pg_temp.expect_state($$select * from discovery_lookup(array['abcd'])$$, '42501');
select pg_temp.check(true, 'lookup requires a signed-in user');

-- ── resolve_username ────────────────────────────────────────────────────────
select pg_temp.as_user(:eve);
select pg_temp.check((select id from resolve_username(' Dana_D ')) = :dana, 'resolve_username is exact and case-insensitive');
select pg_temp.check((select count(*) from resolve_username('dana')) = 0, 'resolve_username does not prefix-match');

-- ── devices for the linking tests ───────────────────────────────────────────
select pg_temp.as_user(:dana);
with d as (insert into devices (identity_public_key) values (repeat('D', 43)) returning id)
insert into t (name, id) select 'dana_dev', id from d;
select pg_temp.as_user(:eve);
with d as (insert into devices (identity_public_key) values (repeat('E', 43)) returning id)
insert into t (name, id) select 'eve_dev', id from d;

-- ── device linking (service-role functions) ─────────────────────────────────
select pg_temp.as_user(:dana);
select pg_temp.expect_state($$select * from device_link_create(encode(sha256('k'), 'hex'), repeat('W', 43))$$, '42501');
select pg_temp.expect_state(format($$select * from device_link_claim(%L, 'k')$$, gen_random_uuid()), '42501');
select pg_temp.expect_state(format($$select device_link_approve(%L, auth.uid(), %L, repeat('W', 43), repeat('S', 43))$$,
  gen_random_uuid(), (select id from t where name = 'dana_dev')), '42501');
select pg_temp.check(true, 'link functions are not callable by signed-in clients');
reset role;
set role anon;
select pg_temp.expect_state($$select * from device_link_create(encode(sha256('k'), 'hex'), repeat('W', 43))$$, '42501');
select pg_temp.expect_fail($$select * from device_link_requests$$);
select pg_temp.check(true, 'link functions and table are not reachable anonymously');
reset role;

set role service_role;
insert into t (name, id) select 'link1', id from device_link_create(encode(sha256('claim-key-1'), 'hex'), repeat('W', 43), 'Chrome on Linux', '203.0.113.7');
select pg_temp.check((select expires_at between now() + interval '119 seconds' and now() + interval '121 seconds'
                      from device_link_requests where id = (select id from t where name = 'link1')),
  'link requests expire after two minutes');
select pg_temp.check((select secret_hash = encode(sha256('claim-key-1'), 'hex') and client_key_hash <> '203.0.113.7'
                      from device_link_requests where id = (select id from t where name = 'link1')),
  'only hashes of the claim key and client address are stored');
select pg_temp.expect_state($$select * from device_link_create('not-a-hash', repeat('W', 43))$$, '22023');
select pg_temp.expect_state($$select * from device_link_create(encode(sha256('x'), 'hex'), 'short')$$, '22023');
select pg_temp.check(true, 'malformed link requests are rejected');

select pg_temp.check((select device_label from device_link_inspect((select id from t where name = 'link1'))) = 'Chrome on Linux',
  'approver can inspect a pending request');
select pg_temp.check((select status from device_link_claim((select id from t where name = 'link1'), 'wrong-key')) = 'invalid',
  'claim with the wrong key is rejected');
select pg_temp.check((select status from device_link_claim((select id from t where name = 'link1'), 'claim-key-1')) = 'pending',
  'claim before approval reports pending');

select pg_temp.expect_state(format($$select device_link_approve(%L, %L, %L, repeat('X', 43), repeat('S', 43))$$,
  (select id from t where name = 'link1'), 'd0000000-0009-4000-8000-000000000001', (select id from t where name = 'dana_dev')), 'P0002');
select pg_temp.check(true, 'approval must name the ephemeral key from the QR code');
select pg_temp.expect_state(format($$select device_link_approve(%L, %L, %L, repeat('W', 43), repeat('S', 43))$$,
  (select id from t where name = 'link1'), 'd0000000-0009-4000-8000-000000000001', (select id from t where name = 'eve_dev')), '42501');
select pg_temp.check(true, 'approval must come from an active device of the approving account');

select device_link_approve((select id from t where name = 'link1'), :dana, (select id from t where name = 'dana_dev'),
                           repeat('W', 43), repeat('S', 43)) \g /dev/null
select pg_temp.expect_state(format($$select device_link_approve(%L, %L, %L, repeat('W', 43), repeat('S', 43))$$,
  (select id from t where name = 'link1'), 'e0000000-0009-4000-8000-000000000002', (select id from t where name = 'eve_dev')), 'P0002');
select pg_temp.check(true, 'an approved request cannot be approved again (by anyone)');
select pg_temp.check((select count(*) from device_link_inspect((select id from t where name = 'link1'))) = 0,
  'approved requests can no longer be inspected');

select pg_temp.check((select status from device_link_claim((select id from t where name = 'link1'), 'claim-key-2')) = 'invalid'
                     and (select status from device_link_requests where id = (select id from t where name = 'link1')) = 'approved',
  'a wrong key cannot claim an approved request');
select pg_temp.check((select status = 'approved' and user_id = :dana
                      from device_link_claim((select id from t where name = 'link1'), 'claim-key-1')),
  'the holder of the claim key receives the approving account');
select pg_temp.check((select status from device_link_claim((select id from t where name = 'link1'), 'claim-key-1')) = 'used',
  'claims are single-use');

-- expiry
insert into t (name, id) select 'link2', id from device_link_create(encode(sha256('claim-key-2'), 'hex'), repeat('W', 43));
reset role;
update device_link_requests set expires_at = now() - interval '1 second' where id = (select id from t where name = 'link2');
set role service_role;
select pg_temp.expect_state(format($$select device_link_approve(%L, %L, %L, repeat('W', 43), repeat('S', 43))$$,
  (select id from t where name = 'link2'), 'd0000000-0009-4000-8000-000000000001', (select id from t where name = 'dana_dev')), 'P0002');
select pg_temp.check(true, 'an expired request cannot be approved');

insert into t (name, id) select 'link3', id from device_link_create(encode(sha256('claim-key-3'), 'hex'), repeat('W', 43));
select device_link_approve((select id from t where name = 'link3'), :dana, (select id from t where name = 'dana_dev'),
                           repeat('W', 43), repeat('S', 43)) \g /dev/null
reset role;
update device_link_requests set expires_at = now() - interval '1 second' where id = (select id from t where name = 'link3');
set role service_role;
select pg_temp.check((select status from device_link_claim((select id from t where name = 'link3'), 'claim-key-3')) = 'expired',
  'an approved request expires if not claimed in time');

-- cancel
insert into t (name, id) select 'link4', id from device_link_create(encode(sha256('claim-key-4'), 'hex'), repeat('W', 43));
select device_link_cancel((select id from t where name = 'link4'), 'wrong') \g /dev/null
select pg_temp.check((select status from device_link_requests where id = (select id from t where name = 'link4')) = 'pending',
  'cancel needs the claim key');
select device_link_cancel((select id from t where name = 'link4'), 'claim-key-4') \g /dev/null
select pg_temp.check((select status from device_link_claim((select id from t where name = 'link4'), 'claim-key-4')) = 'expired',
  'a cancelled request cannot be claimed');

-- client rate limit
do $$ begin
  for i in 1..20 loop
    perform public.device_link_create(encode(sha256(('rl' || i)::bytea), 'hex'), repeat('W', 43), null, '198.51.100.9');
  end loop;
end $$;
select pg_temp.expect_state($$select * from device_link_create(encode(sha256('rl-x'), 'hex'), repeat('W', 43), null, '198.51.100.9')$$, 'PT429');
select pg_temp.check(true, 'link creation is rate-limited per client address');
reset role;

-- ── history chunks for the claimed link ─────────────────────────────────────
set role authenticated;
select pg_temp.as_user(:dana);
select pg_temp.check((select status from device_link_requests where id = (select id from t where name = 'link1')) = 'claimed',
  'the account can follow its own link request');
select pg_temp.expect_fail($$select secret_hash from device_link_requests$$);
select pg_temp.check(true, 'the claim-key hash is not readable by clients');
insert into device_transfer_chunks (request_id, idx, ciphertext)
select (select id from t where name = 'link1'), g, 'cipher-' || g from generate_series(0, 2) g;
select pg_temp.expect_fail(format($$insert into device_transfer_chunks (request_id, idx, ciphertext) values (%L, 0, 'dup')$$,
  (select id from t where name = 'link1')));
select pg_temp.expect_fail(format($$update device_transfer_chunks set ciphertext = 'x' where request_id = %L$$,
  (select id from t where name = 'link1')));
select pg_temp.check(true, 'uploaded chunks cannot be overwritten');

select pg_temp.as_user(:eve);
select pg_temp.check((select count(*) from device_link_requests) = 0, 'other accounts cannot see link requests');
select pg_temp.check((select count(*) from device_transfer_chunks) = 0, 'other accounts cannot read transfer chunks');
select pg_temp.expect_fail(format($$insert into device_transfer_chunks (request_id, idx, ciphertext) values (%L, 3, 'evil')$$,
  (select id from t where name = 'link1')));
select pg_temp.expect_fail(format($$select finish_transfer_upload(%L, 3)$$, (select id from t where name = 'link1')));
select pg_temp.check(true, 'other accounts cannot write into a transfer');

select pg_temp.as_user(:dana);
select pg_temp.expect_state(format($$select finish_transfer_upload(%L, 4)$$, (select id from t where name = 'link1')), '22023');
select pg_temp.expect_state(format($$select finish_transfer_upload(%L, 2)$$, (select id from t where name = 'link1')), '22023');
select pg_temp.check(true, 'upload completion requires exactly chunks 0..n-1');
select finish_transfer_upload((select id from t where name = 'link1'), 3) \g /dev/null
select pg_temp.check((select total_chunks from device_link_requests where id = (select id from t where name = 'link1')) = 3,
  'finished upload records the chunk count');
select pg_temp.expect_fail(format($$insert into device_transfer_chunks (request_id, idx, ciphertext) values (%L, 3, 'late')$$,
  (select id from t where name = 'link1')));
select pg_temp.check(true, 'no chunks can be added after the upload is sealed');
select pg_temp.check((select count(*) from device_transfer_chunks where request_id = (select id from t where name = 'link1')) = 3,
  'the new device of the same account can read the chunks');
select complete_transfer((select id from t where name = 'link1')) \g /dev/null
select pg_temp.check((select status from device_link_requests where id = (select id from t where name = 'link1')) = 'completed'
                     and (select count(*) from device_transfer_chunks where request_id = (select id from t where name = 'link1')) = 0,
  'completing a transfer deletes the ciphertext');

-- ── transfer to a new phone ─────────────────────────────────────────────────
insert into t (name, id) select 'xfer', id from create_transfer_request(repeat('R', 43));
select pg_temp.check((select purpose = 'transfer' and status = 'pending' and user_id = :dana
                      from device_link_requests where id = (select id from t where name = 'xfer')),
  'a signed-in device can open a transfer request for its own account');
select pg_temp.expect_fail(format($$insert into device_transfer_chunks (request_id, idx, ciphertext) values (%L, 0, 'early')$$,
  (select id from t where name = 'xfer')));
select pg_temp.check(true, 'chunks cannot be uploaded before approval');

select pg_temp.as_user(:eve);
select pg_temp.expect_state(format($$select approve_transfer_request(%L, repeat('R', 43), %L, repeat('S', 43))$$,
  (select id from t where name = 'xfer'), (select id from t where name = 'eve_dev')), 'P0002');
select pg_temp.check(true, 'another account cannot approve the transfer');

select pg_temp.as_user(:dana);
select pg_temp.expect_state(format($$select approve_transfer_request(%L, repeat('Q', 43), %L, repeat('S', 43))$$,
  (select id from t where name = 'xfer'), (select id from t where name = 'dana_dev')), 'P0002');
select pg_temp.expect_state(format($$select approve_transfer_request(%L, repeat('R', 43), %L, repeat('S', 43))$$,
  (select id from t where name = 'xfer'), (select id from t where name = 'eve_dev')), '42501');
select approve_transfer_request((select id from t where name = 'xfer'), repeat('R', 43),
                                (select id from t where name = 'dana_dev'), repeat('S', 43)) \g /dev/null
select pg_temp.expect_state(format($$select approve_transfer_request(%L, repeat('R', 43), %L, repeat('S', 43))$$,
  (select id from t where name = 'xfer'), (select id from t where name = 'dana_dev')), 'P0002');
select pg_temp.check(true, 'transfer approval checks key + device and is single-use');
insert into device_transfer_chunks (request_id, idx, ciphertext) values ((select id from t where name = 'xfer'), 0, 'c0');
select pg_temp.check((select sender_public_key from device_link_requests where id = (select id from t where name = 'xfer')) = repeat('S', 43),
  'the receiver learns the sender''s ephemeral key');
select cancel_transfer((select id from t where name = 'xfer')) \g /dev/null
select pg_temp.check((select count(*) from device_transfer_chunks where request_id = (select id from t where name = 'xfer')) = 0
                     and (select status from device_link_requests where id = (select id from t where name = 'xfer')) = 'cancelled',
  'cancelling a transfer deletes its ciphertext');

-- ── cleanup ─────────────────────────────────────────────────────────────────
reset role;
update device_link_requests set data_expires_at = now() - interval '1 minute' where id = (select id from t where name = 'link3');
select pg_temp.check(public.cleanup_discovery_linking() >= 1, 'cleanup reports removed requests');
select pg_temp.check(not exists (select 1 from device_link_requests where id = (select id from t where name = 'link3')),
  'cleanup removes expired requests');
