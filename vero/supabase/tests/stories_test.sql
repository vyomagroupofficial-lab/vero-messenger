-- Stories: RLS / RPC behaviour tests (008_stories.sql). Run with scripts/test-db.sh.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned
-- Only the 'ok - ...' notices and the final echo are printed.
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

\set alice '''aaaaaaaa-0000-4000-8000-000000000001'''
\set bob   '''bbbbbbbb-0000-4000-8000-000000000002'''
\set carol '''cccccccc-0000-4000-8000-000000000003'''
\set dave  '''dddddddd-0000-4000-8000-000000000004'''
\set eve   '''eeeeeeee-0000-4000-8000-000000000005'''
\set s1    '''51515151-0000-4000-8000-000000000001'''
\set s2    '''52525252-0000-4000-8000-000000000002'''
\set s3    '''53535353-0000-4000-8000-000000000003'''
\set s4    '''54545454-0000-4000-8000-000000000004'''

insert into auth.users (id, raw_user_meta_data) values
  (:alice, '{"username":"alice"}'),
  (:bob,   '{"username":"bob"}'),
  (:carol, '{"username":"carol"}'),
  (:dave,  '{"username":"dave"}'),
  (:eve,   '{"username":"eve"}');

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated;

set role authenticated;

-- Devices
select pg_temp.as_user(:alice);
with d as (insert into devices (identity_public_key) values (repeat('A', 43)) returning id)
insert into ids select 'alice_dev', id from d;
select pg_temp.as_user(:bob);
with d as (insert into devices (identity_public_key) values (repeat('B', 43)) returning id)
insert into ids select 'bob_dev', id from d;
select pg_temp.as_user(:carol);
with d as (insert into devices (identity_public_key) values (repeat('C', 43)) returning id)
insert into ids select 'carol_dev', id from d;
select pg_temp.as_user(:dave);
with d as (insert into devices (identity_public_key) values (repeat('D', 43)) returning id)
insert into ids select 'dave_dev', id from d;
select pg_temp.as_user(:eve);
with d as (insert into devices (identity_public_key) values (repeat('E', 43)) returning id)
insert into ids select 'eve_dev', id from d;

-- Alice's contacts: bob, carol, dave (direct chats). Eve is a stranger.
select pg_temp.as_user(:alice);
select create_direct_conversation(:bob);
select create_direct_conversation(:carol);
select create_direct_conversation(:dave);

-- ── audience devices ─────────────────────────────────────────────────────────
select pg_temp.check(
  (select count(*) from get_story_audience_devices(array[:bob, :eve]::uuid[])) = 2,
  'audience devices = my devices + contacts'' devices (strangers excluded)');
select pg_temp.check(
  not exists (select 1 from get_story_audience_devices(array[:eve]::uuid[]) where user_id = :eve),
  'cannot fetch a stranger''s device keys through stories');

-- ── posting ──────────────────────────────────────────────────────────────────
select pg_temp.check(
  post_story(:s1, (select id from ids where name = 'alice_dev'), 'text', '{"v":2,"n":"x","c":"y","k":{}}',
    null, jsonb_build_array(
      jsonb_build_object('user_id', :bob, 'key_slots', jsonb_build_object((select id from ids where name = 'bob_dev'), 'slotB')),
      jsonb_build_object('user_id', :carol, 'key_slots', jsonb_build_object((select id from ids where name = 'carol_dev'), 'slotC')),
      jsonb_build_object('user_id', :eve, 'key_slots', jsonb_build_object((select id from ids where name = 'eve_dev'), 'slotE')),
      jsonb_build_object('user_id', 'not-a-uuid', 'key_slots', '{}'::jsonb)
    )) = 2,
  'post_story accepts contacts and silently drops strangers / junk');

select pg_temp.expect_fail(format($$select post_story(%L, %L, 'text', 'x', null, '[]')$$,
  '59595959-0000-4000-8000-000000000009', (select id from ids where name = 'bob_dev')));
select pg_temp.check(true, 'cannot post from someone else''s device');

select pg_temp.expect_fail(format($$insert into stories (id, author_id, author_device_id, story_type, ciphertext) values (%L, %L, %L, 'text', 'x')$$,
  '59595959-0000-4000-8000-000000000009', 'aaaaaaaa-0000-4000-8000-000000000001', (select id from ids where name = 'alice_dev')));
select pg_temp.expect_fail(format($$insert into story_recipients (story_id, recipient_id, key_slots) values (%L, %L, '{}')$$,
  '51515151-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004'));
select pg_temp.check(true, 'stories / recipients cannot be written directly');

select pg_temp.expect_fail(format($$select post_story(%L, %L, 'media', 'x', %L, '[]')$$,
  '59595959-0000-4000-8000-000000000009', (select id from ids where name = 'alice_dev'),
  'bbbbbbbb-0000-4000-8000-000000000002/59595959-0000-4000-8000-000000000009/11111111-1111-4111-8111-111111111111.bin'));
select pg_temp.check(true, 'media path must live under the author''s own folder');

-- Media story s2 for bob only
select pg_temp.check(
  post_story(:s2, (select id from ids where name = 'alice_dev'), 'media', 'cipher',
    'aaaaaaaa-0000-4000-8000-000000000001/52525252-0000-4000-8000-000000000002/11111111-1111-4111-8111-111111111111.bin',
    jsonb_build_array(jsonb_build_object('user_id', :bob, 'key_slots', jsonb_build_object((select id from ids where name = 'bob_dev'), 'slotB'))))
  = 1, 'media story posted');

reset role;
select pg_temp.check((select count(*) from realtime.messages where event = 'story.new' and topic = 'user:' || :bob) = 2,
  'recipient gets a story.new ping per story');
select pg_temp.check((select count(*) from realtime.messages where event = 'story.new' and topic = 'user:' || :eve) = 0,
  'non-audience gets no ping');
select pg_temp.check(not exists (select 1 from realtime.messages where event = 'story.new' and payload ? 'ciphertext'),
  'story.new ping carries no content');
set role authenticated;

-- ── reading ──────────────────────────────────────────────────────────────────
select pg_temp.as_user(:bob);
select pg_temp.check((select count(*) from stories) = 2, 'recipient reads the stories shared with them');
select pg_temp.check((select count(*) from story_recipients) = 2
  and (select bool_and(recipient_id = :bob) from story_recipients), 'recipient only sees their own key slots');

select pg_temp.as_user(:carol);
select pg_temp.check((select count(*) from stories) = 1, 'carol sees only s1 (not the bob-only media story)');

select pg_temp.as_user(:dave);
select pg_temp.check((select count(*) from stories) = 0, 'contact outside the audience cannot read the story');
select pg_temp.check((select count(*) from story_recipients) = 0, 'non-recipient sees no key slots');
select pg_temp.expect_fail(format($$select mark_story_viewed(%L)$$, '51515151-0000-4000-8000-000000000001'));
select pg_temp.check(true, 'non-recipient cannot record a view');

select pg_temp.as_user(:eve);
select pg_temp.check((select count(*) from stories) = 0, 'stranger cannot read the story');

select pg_temp.as_user(:alice);
select pg_temp.check((select count(*) from stories) = 2, 'author reads own stories');
select pg_temp.check((select count(*) from story_recipients where story_id = :s1) = 2, 'author sees the audience list');

-- ── storage helpers ─────────────────────────────────────────────────────────
select pg_temp.check(can_upload_story_object('aaaaaaaa-0000-4000-8000-000000000001/52525252-0000-4000-8000-000000000002/22222222-2222-4222-8222-222222222222.bin'),
  'author may upload into own folder');
select pg_temp.check(not can_upload_story_object('bbbbbbbb-0000-4000-8000-000000000002/52525252-0000-4000-8000-000000000002/22222222-2222-4222-8222-222222222222.bin'),
  'author may not upload into someone else''s folder');
select pg_temp.check(not can_upload_story_object('aaaaaaaa-0000-4000-8000-000000000001/../x.bin'),
  'malformed object names are rejected');
select pg_temp.as_user(:bob);
select pg_temp.check(can_read_story_object('aaaaaaaa-0000-4000-8000-000000000001/52525252-0000-4000-8000-000000000002/11111111-1111-4111-8111-111111111111.bin'),
  'recipient may download the story blob');
select pg_temp.as_user(:carol);
select pg_temp.check(not can_read_story_object('aaaaaaaa-0000-4000-8000-000000000001/52525252-0000-4000-8000-000000000002/11111111-1111-4111-8111-111111111111.bin'),
  'non-recipient may not download the story blob');

-- ── views ────────────────────────────────────────────────────────────────────
select pg_temp.as_user(:bob);
select mark_story_viewed(:s1);
select mark_story_viewed(:s1);
select pg_temp.check((select count(*) from story_views) = 0, 'viewer cannot read view receipts');
select pg_temp.expect_fail(format($$insert into story_views (story_id, viewer_id) values (%L, %L)$$,
  '51515151-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003'));
select pg_temp.check(true, 'views cannot be forged by direct insert');

select pg_temp.as_user(:carol);
select pg_temp.check((select count(*) from story_views) = 0, 'other recipients cannot see who viewed');

select pg_temp.as_user(:alice);
select mark_story_viewed(:s1);
select pg_temp.check((select count(*) from story_views where story_id = :s1) = 1
  and (select viewer_id from story_views where story_id = :s1) = :bob,
  'only the author sees views (idempotent; author''s own view not recorded)');
reset role;
select pg_temp.check((select count(*) from realtime.messages where event = 'story.viewed' and topic = 'user:' || :alice) = 1,
  'author is pinged once per new viewer');
set role authenticated;

-- ── privacy setting (own row only) ───────────────────────────────────────────
select pg_temp.as_user(:alice);
insert into story_privacy (audience, except_user_ids) values ('contacts_except', array[:dave]::uuid[]);
select pg_temp.as_user(:bob);
select pg_temp.check((select count(*) from story_privacy) = 0, 'privacy settings are private');
select pg_temp.expect_fail(format($$insert into story_privacy (user_id, audience) values (%L, 'only')$$, 'aaaaaaaa-0000-4000-8000-000000000001'));
select pg_temp.check(true, 'cannot write someone else''s privacy setting');
update story_privacy set audience = 'only';
select pg_temp.as_user(:alice);
select pg_temp.check((select audience from story_privacy) = 'contacts_except', 'others cannot update my privacy setting');

-- ── delete (author only) ─────────────────────────────────────────────────────
select pg_temp.as_user(:bob);
select pg_temp.expect_fail(format($$select delete_story(%L)$$, '52525252-0000-4000-8000-000000000002'));
select pg_temp.check(true, 'recipient cannot delete the author''s story');
select pg_temp.as_user(:alice);
select delete_story(:s2);
select pg_temp.check(not exists (select 1 from stories where id = :s2), 'author deletes own story early');
reset role;
select pg_temp.check(exists (select 1 from story_media_trash
  where object_path like 'aaaaaaaa-0000-4000-8000-000000000001/52525252-%'), 'deleted story blob is flagged for removal');
select pg_temp.check(exists (select 1 from realtime.messages where event = 'story.deleted' and topic = 'user:' || :bob),
  'audience is told the story was deleted');
set role authenticated;

-- ── expiry ───────────────────────────────────────────────────────────────────
select pg_temp.as_user(:alice);
select post_story(:s3, (select id from ids where name = 'alice_dev'), 'media', 'cipher',
  'aaaaaaaa-0000-4000-8000-000000000001/53535353-0000-4000-8000-000000000003/33333333-3333-4333-8333-333333333333.bin',
  jsonb_build_array(jsonb_build_object('user_id', :bob, 'key_slots', '{"d":"s"}'::jsonb)));
reset role;
update stories set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where id = :s3;
select pg_temp.expect_fail($$update stories set expires_at = created_at + interval '2 days'$$);
select pg_temp.check(true, 'a story can never live longer than 24 hours');
set role authenticated;

select pg_temp.as_user(:bob);
select pg_temp.check(not exists (select 1 from stories where id = :s3), 'expired story is invisible to recipients');
select pg_temp.check(not exists (select 1 from story_recipients where story_id = :s3), 'expired story key slots are invisible');
select pg_temp.expect_fail(format($$select mark_story_viewed(%L)$$, '53535353-0000-4000-8000-000000000003'));
select pg_temp.check(true, 'expired story cannot be viewed');
select pg_temp.check(not can_read_story_object('aaaaaaaa-0000-4000-8000-000000000001/53535353-0000-4000-8000-000000000003/33333333-3333-4333-8333-333333333333.bin'),
  'expired story blob cannot be downloaded');
select pg_temp.as_user(:alice);
select pg_temp.check(not exists (select 1 from stories where id = :s3), 'expired story is invisible to its author too');

select pg_temp.expect_fail($$select cleanup_expired_stories()$$);
select pg_temp.check(true, 'clients cannot run the cleanup');
select pg_temp.expect_fail(format($$select are_story_contacts(%L, %L)$$, 'bbbbbbbb-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003'));
select pg_temp.check(true, 'contact graph helper is not exposed to clients');

reset role;
set role service_role;
select pg_temp.check(cleanup_expired_stories() = 1, 'cleanup hard-deletes expired stories');
reset role;
select pg_temp.check(not exists (select 1 from stories where id = :s3)
  and not exists (select 1 from story_recipients where story_id = :s3), 'expired rows are gone (cascade)');
select pg_temp.check(exists (select 1 from story_media_trash where object_path like '%/53535353-%'),
  'expired story blob is flagged for removal');
set role authenticated;

-- ── blocking hides stories immediately ──────────────────────────────────────
select pg_temp.as_user(:alice);
select post_story(:s4, (select id from ids where name = 'alice_dev'), 'text', 'cipher', null,
  jsonb_build_array(jsonb_build_object('user_id', :carol, 'key_slots', '{"d":"s"}'::jsonb)));
select pg_temp.as_user(:carol);
select pg_temp.check(exists (select 1 from stories where id = :s4), 'carol sees s4 before blocking');
insert into blocks (blocked_user_id) values (:alice);
select pg_temp.check(not exists (select 1 from stories where id = :s4), 'blocking the author hides their stories');
select pg_temp.as_user(:alice);
select pg_temp.check((select count(*) from get_story_audience_devices(array[:carol]::uuid[]) where user_id = :carol) = 0,
  'blocked users drop out of the audience');

-- ── anon ─────────────────────────────────────────────────────────────────────
reset role;
set role anon;
select pg_temp.as_user(null);
select pg_temp.expect_fail($$select count(*) from stories$$);
select pg_temp.expect_fail($$select post_story(gen_random_uuid(), gen_random_uuid(), 'text', 'x', null, '[]')$$);
select pg_temp.check(true, 'anonymous users cannot touch stories');
reset role;

\echo 'ALL STORY TESTS PASSED'
