-- Encrypted media uploads (004_media.sql). Run with scripts/test-db.sh.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned
\o /dev/null

create function pg_temp.as_user(p_id uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_id::text, ''), false);
$$;

create function pg_temp.expect_fail(p_sql text, p_errcode text default null) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED FAILURE but statement succeeded: %', p_sql;
exception when others then
  if sqlerrm like 'EXPECTED FAILURE%' then raise; end if;
  if p_errcode is not null and sqlstate <> p_errcode then
    raise exception 'expected errcode % but got % (%): %', p_errcode, sqlstate, sqlerrm, p_sql;
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
\set hash  '''0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'''
\set mb50  52428800

insert into auth.users (id, raw_user_meta_data) values
  (:alice, '{"username":"alice"}'),
  (:bob,   '{"username":"bob"}'),
  (:carol, '{"username":"carol"}');

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated, service_role;

set role authenticated;
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
insert into ids values ('dm', create_direct_conversation(:bob));

-- ── clients cannot call the upload RPCs ─────────────────────────────────────
select pg_temp.expect_fail(format($$select begin_media_upload(%L, %L, 100, %L, 'supabase', %s)$$,
  (select id from ids where name = 'dm'), :alice, :hash, :mb50));
select pg_temp.expect_fail(format($$select complete_media_upload(gen_random_uuid(), %L, true)$$, :alice));
select pg_temp.expect_fail(format($$select * from media_download_target(gen_random_uuid(), %L)$$, :alice));
select pg_temp.expect_fail($$select cleanup_stale_media_uploads()$$);
select pg_temp.check(true, 'upload/download RPCs are service-role only');
select pg_temp.expect_fail(format($$insert into media (conversation_id, uploader_id, storage_object_id, encrypted_size, encrypted_hash, upload_status)
  values (%L, %L, 'sb:x', 10, %L, 'ready')$$, (select id from ids where name = 'dm'), :alice, :hash));
select pg_temp.check(true, 'clients cannot insert media rows directly');

-- ── begin_media_upload (as the Edge Function) ───────────────────────────────
reset role;
set role service_role;

insert into ids values ('m1', begin_media_upload((select id from ids where name = 'dm'), :alice, 1000, :hash, 'supabase', :mb50));
select pg_temp.check(
  (select upload_status = 'pending' and storage_object_id = 'sb:' || conversation_id || '/' || id
     from media where id = (select id from ids where name = 'm1')),
  'begin creates a pending row with a server-chosen object path');

select pg_temp.expect_fail(format($$select begin_media_upload(%L, %L, 1000, %L, 'supabase', %s)$$,
  (select id from ids where name = 'dm'), :carol, :hash, :mb50), '42501');
select pg_temp.check(true, 'non-members cannot start an upload');
select pg_temp.expect_fail(format($$select begin_media_upload(%L, %L, %s, %L, 'supabase', %s)$$,
  (select id from ids where name = 'dm'), :alice, :mb50 + 1, :hash, :mb50), '54000');
select pg_temp.check(true, 'files over the size cap are refused');
select pg_temp.expect_fail(format($$select begin_media_upload(%L, %L, 0, %L, 'supabase', %s)$$,
  (select id from ids where name = 'dm'), :alice, :hash, :mb50), '22023');
select pg_temp.expect_fail(format($$select begin_media_upload(%L, %L, 10, 'XYZ', 'supabase', %s)$$,
  (select id from ids where name = 'dm'), :alice, :mb50), '22023');
select pg_temp.expect_fail(format($$select begin_media_upload(%L, %L, 10, %L, 'ftp', %s)$$,
  (select id from ids where name = 'dm'), :alice, :hash, :mb50), '22023');
select pg_temp.check(true, 'invalid size, hash and backend are refused');

-- Rate limits: at most 3 pending uploads in this test.
select begin_media_upload((select id from ids where name = 'dm'), :bob, 10, :hash, 'supabase', :mb50, 30, 2);
select begin_media_upload((select id from ids where name = 'dm'), :bob, 10, :hash, 'supabase', :mb50, 30, 2);
select pg_temp.expect_fail(format($$select begin_media_upload(%L, %L, 10, %L, 'supabase', %s, 30, 2)$$,
  (select id from ids where name = 'dm'), :bob, :hash, :mb50), '53400');
select pg_temp.check(true, 'too many unfinished uploads are refused');
select pg_temp.expect_fail(format($$select begin_media_upload(%L, %L, 10, %L, 'supabase', %s, 2, 100)$$,
  (select id from ids where name = 'dm'), :bob, :hash, :mb50), '53400');
select pg_temp.check(true, 'per-minute upload rate limit');

-- ── messages cannot reference unverified media ──────────────────────────────
reset role;
set role authenticated;
select pg_temp.as_user(:alice);
select pg_temp.expect_fail(format($$insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext, message_type, media_id)
  values (%L, %L, %L, 'x', 'media', %L)$$,
  (select id from ids where name = 'dm'), (select id from ids where name = 'alice_dev'), :alice,
  (select id from ids where name = 'm1')), '22023');
select pg_temp.check(true, 'a message cannot reference a pending upload');

-- Pending media is not downloadable.
reset role;
set role service_role;
select pg_temp.check(
  not exists (select 1 from media_download_target((select id from ids where name = 'm1'), :bob)),
  'pending uploads cannot be downloaded');

-- ── complete_media_upload ───────────────────────────────────────────────────
select pg_temp.check(
  not complete_media_upload((select id from ids where name = 'm1'), :bob, true),
  'only the uploader can confirm');
select pg_temp.check(
  complete_media_upload((select id from ids where name = 'm1'), :alice, true),
  'uploader confirms the verified object');
select pg_temp.check(
  (select upload_status = 'ready' and confirmed_at is not null from media where id = (select id from ids where name = 'm1')),
  'confirmed media is ready');
select pg_temp.check(
  not complete_media_upload((select id from ids where name = 'm1'), :alice, true),
  'confirm is one-shot');

reset role;
set role authenticated;
select pg_temp.as_user(:alice);
insert into messages (id, conversation_id, sender_device_id, sender_user_id, ciphertext, message_type, media_id)
values ('dddddddd-0000-4000-8000-0000000000a1', (select id from ids where name = 'dm'),
        (select id from ids where name = 'alice_dev'), :alice, 'x', 'media', (select id from ids where name = 'm1'));
select pg_temp.check(true, 'a message can reference verified media');

-- Bob may not attach Alice's upload to his own message (001 rule still holds).
select pg_temp.as_user(:bob);
select pg_temp.expect_fail(format($$insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext, message_type, media_id)
  values (%L, %L, %L, 'x', 'media', %L)$$,
  (select id from ids where name = 'dm'), (select id from ids where name = 'bob_dev'), :bob,
  (select id from ids where name = 'm1')));
select pg_temp.check(true, 'media can only be sent by its uploader');

-- ── downloads ───────────────────────────────────────────────────────────────
reset role;
set role service_role;
select pg_temp.check(
  (select storage_object_id from media_download_target((select id from ids where name = 'm1'), :bob))
    = (select storage_object_id from media where id = (select id from ids where name = 'm1')),
  'members get the object to download');
select pg_temp.check(
  not exists (select 1 from media_download_target((select id from ids where name = 'm1'), :carol)),
  'non-members get nothing');

-- Members see the record through RLS; outsiders don't.
reset role;
set role authenticated;
select pg_temp.as_user(:bob);
select pg_temp.check(exists (select 1 from media where id = (select id from ids where name = 'm1')), 'members see media rows');
select pg_temp.as_user(:carol);
select pg_temp.check(not exists (select 1 from media where id = (select id from ids where name = 'm1')), 'outsiders do not see media rows');

-- Deleting the message for everyone hides the media and queues the blob.
select pg_temp.as_user(:alice);
select delete_message('dddddddd-0000-4000-8000-0000000000a1');
reset role;
set role service_role;
select pg_temp.check(
  not exists (select 1 from media_download_target((select id from ids where name = 'm1'), :bob)),
  'deleted media cannot be downloaded');
select pg_temp.check(
  (select deleted_at is not null from media where id = (select id from ids where name = 'm1')),
  'deleted media is queued for blob cleanup');

-- ── failed verification / stale uploads ─────────────────────────────────────
insert into ids values ('m2', begin_media_upload((select id from ids where name = 'dm'), :alice, 10, :hash, 'supabase', :mb50));
select pg_temp.check(
  complete_media_upload((select id from ids where name = 'm2'), :alice, false),
  'a failed verification is recorded');
select pg_temp.check(
  (select deleted_at is not null and upload_status = 'pending' from media where id = (select id from ids where name = 'm2')),
  'a failed upload is queued for cleanup and never becomes ready');

insert into ids values ('m3', begin_media_upload((select id from ids where name = 'dm'), :alice, 10, :hash, 'drive', :mb50));
select pg_temp.check(
  (select storage_object_id from media where id = (select id from ids where name = 'm3')) = 'drive:pending',
  'drive uploads start without a file id');
select pg_temp.check(
  complete_media_upload((select id from ids where name = 'm3'), :alice, true, 'drive:abc123'),
  'drive confirm records the real file id');
select pg_temp.check(
  (select storage_object_id from media where id = (select id from ids where name = 'm3')) = 'drive:abc123',
  'drive file id stored');

reset role;
update media set created_at = now() - interval '7 hours' where uploader_id = :bob;
set role service_role;
select pg_temp.check(cleanup_stale_media_uploads() = 2, 'stale pending uploads are swept');
select pg_temp.check(
  (select count(*) from media where uploader_id = :bob and deleted_at is null) = 0,
  'swept uploads are marked deleted');

-- Old rows (before 004) are ready; the bucket is locked down.
reset role;
select pg_temp.check(
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'media' and column_name = 'upload_status') like '''pending''%',
  'new rows default to pending');
select pg_temp.check(
  (select not public and file_size_limit = 52428800 and allowed_mime_types = array['application/octet-stream']
     from storage.buckets where id = 'vero-media'),
  'vero-media bucket: private, 50 MB, ciphertext only');

-- ── anon ────────────────────────────────────────────────────────────────────
set role anon;
select pg_temp.as_user(null);
select pg_temp.check((select count(*) from media) = 0, 'anonymous users cannot read media rows');
reset role;

\echo 'ALL MEDIA TESTS PASSED'
