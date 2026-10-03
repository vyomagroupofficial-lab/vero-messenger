-- Payment link records and merchant allow-list (011).
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
\set bob   '''bbbbbbbb-0000-4000-8000-000000000002'''

insert into auth.users (id, raw_user_meta_data) values
  (:alice, '{"username":"alice"}'),
  (:bob,   '{"username":"bob"}');

-- Server-side records written by the payment-link function (service role).
set role service_role;
insert into payment_link_merchants (user_id) values (:alice);
insert into payment_links (creator_id, provider_link_id, short_url) values (:alice, 'plink_A1', 'https://rzp.io/i/abc');
select pg_temp.expect_fail($$insert into payment_links (creator_id, provider_link_id, short_url) values ('aaaaaaaa-0000-4000-8000-000000000001', 'plink_A2', 'http://evil.example')$$);
select pg_temp.check(true, 'payment links must be https');
select pg_temp.check(get_app_secret('RAZORPAY_KEY_ID') is null, 'Razorpay is unconfigured by default');
reset role;

select pg_temp.check(not exists (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'payment_links'
    and column_name in ('amount', 'amount_paise', 'vpa', 'note', 'conversation_id')),
  'no amounts, notes, VPAs or conversation ids are stored server-side');

set role authenticated;
select pg_temp.as_user(:alice);
select pg_temp.check((select count(*) from payment_links) = 1, 'creators see their own links');
select pg_temp.check((select count(*) from payment_link_merchants) = 1, 'merchants see their own flag');

select pg_temp.as_user(:bob);
select pg_temp.check((select count(*) from payment_links) = 0, 'other users cannot see links');
select pg_temp.check((select count(*) from payment_link_merchants) = 0, 'other users cannot see merchant flags');
select pg_temp.expect_fail($$insert into payment_link_merchants (user_id) values ('bbbbbbbb-0000-4000-8000-000000000002')$$);
select pg_temp.check(true, 'users cannot make themselves merchants');
select pg_temp.expect_fail($$insert into payment_links (creator_id, provider_link_id, short_url) values ('bbbbbbbb-0000-4000-8000-000000000002', 'x', 'https://rzp.io/i/x')$$);
select pg_temp.as_user(:alice);
select pg_temp.expect_fail($$update payment_links set status = 'paid'$$);
select pg_temp.expect_fail($$delete from payment_links$$);
select pg_temp.check(true, 'link records are written only by the service role');
reset role;

select pg_temp.check((select status from payment_links where provider_link_id = 'plink_A1') = 'created',
  'link status unchanged after client writes');

\echo 'ALL PAYMENT DATABASE TESTS PASSED'
