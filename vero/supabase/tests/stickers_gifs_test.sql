-- app_config / get_app_secret access and the GIF search rate limiter (010).
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

-- ── app_config: service role only ───────────────────────────────────────────
set role service_role;
insert into app_config (key, value) values ('TENOR_API_KEY', 'tenor-secret');
select pg_temp.check(get_app_secret('TENOR_API_KEY') = 'tenor-secret', 'service role reads a config secret');
select pg_temp.check(get_app_secret('MISSING_KEY') is null, 'missing config key reads as null');
select pg_temp.check(get_app_secret('bad key; drop table x') is null, 'malformed key names are rejected');
select pg_temp.expect_fail($$insert into app_config (key, value) values ('lower_case', 'x')$$);
select pg_temp.check(true, 'config keys must be UPPER_SNAKE_CASE');
reset role;

set role authenticated;
select pg_temp.as_user(:alice);
select pg_temp.expect_fail($$select get_app_secret('TENOR_API_KEY')$$);
select pg_temp.check(true, 'signed-in users cannot call get_app_secret');
select pg_temp.expect_fail($$select value from app_config$$);
select pg_temp.check(true, 'signed-in users cannot read app_config');
select pg_temp.expect_fail($$insert into app_config (key, value) values ('GIPHY_API_KEY', 'mine')$$);
select pg_temp.expect_fail($$update app_config set value = 'hijacked'$$);
select pg_temp.check(true, 'signed-in users cannot write app_config');
reset role;

set role anon;
select pg_temp.as_user(null);
select pg_temp.expect_fail($$select get_app_secret('TENOR_API_KEY')$$);
select pg_temp.expect_fail($$select value from app_config$$);
select pg_temp.check(true, 'anonymous users cannot read config secrets');
reset role;

select pg_temp.check((select value from app_config where key = 'TENOR_API_KEY') = 'tenor-secret',
  'config value unchanged after hostile writes');

-- Vault secrets take precedence over app_config when Vault is present
-- (Vault stand-in from supabase_stubs.sql).
do $$ begin perform vault.create_secret('from-vault', 'TENOR_API_KEY'); end $$;
set role service_role;
select pg_temp.check(get_app_secret('TENOR_API_KEY') = 'from-vault', 'Vault secret wins over app_config');
reset role;
delete from vault.secrets where name = 'TENOR_API_KEY';

-- ── GIF rate limit ──────────────────────────────────────────────────────────
set role authenticated;
select pg_temp.as_user(:alice);
select pg_temp.expect_fail($$select gif_rate_limit_hit('aaaaaaaa-0000-4000-8000-000000000001', 1000, 60)$$);
select pg_temp.check(true, 'clients cannot call the rate limiter (or raise their own limit)');
select pg_temp.expect_fail($$select * from gif_search_usage$$);
select pg_temp.expect_fail($$delete from gif_search_usage$$);
select pg_temp.check(true, 'clients cannot read or reset usage counters');
reset role;

set role service_role;
select pg_temp.check(gif_rate_limit_hit(:alice, 3, 60), 'request 1 within limit');
select pg_temp.check(gif_rate_limit_hit(:alice, 3, 60), 'request 2 within limit');
select pg_temp.check(gif_rate_limit_hit(:alice, 3, 60), 'request 3 within limit');
select pg_temp.check(not gif_rate_limit_hit(:alice, 3, 60), 'request 4 is rate limited');
select pg_temp.check(gif_rate_limit_hit(:bob, 3, 60), 'limits are per user');
select pg_temp.expect_fail($$select gif_rate_limit_hit(null, 3, 60)$$);
select pg_temp.expect_fail($$select gif_rate_limit_hit('aaaaaaaa-0000-4000-8000-000000000001', 0, 60)$$);
select pg_temp.check(true, 'invalid rate limit arguments are rejected');
reset role;

-- An old window is cleaned up and a new window starts from zero.
insert into gif_search_usage (user_id, window_start, request_count)
values (:alice, now() - interval '3 days', 99);
set role service_role;
select pg_temp.check(gif_rate_limit_hit(:alice, 10, 60), 'new window allows requests again');
reset role;
select pg_temp.check(not exists (select 1 from gif_search_usage where window_start < now() - interval '1 day'),
  'stale usage windows are deleted');

\echo 'ALL STICKER/GIF DATABASE TESTS PASSED'
