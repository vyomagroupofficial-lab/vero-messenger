-- ============================================================================
-- 004 - Direct-to-Storage encrypted media uploads
-- ============================================================================
-- Before: the whole ciphertext went through the media-upload Edge Function as
-- one base64 body (memory/body/time limits, ~15 MB max).
-- Now:
--   1. media-upload {action:"create"} -> begin_media_upload() checks membership,
--      size and rate limits and creates a *pending* media row, then the
--      function hands out a signed upload URL for
--      vero-media/<conversation_id>/<media_id>.
--   2. The app uploads the ciphertext straight to Storage.
--   3. media-upload {action:"confirm"} streams the object, checks its size and
--      BLAKE2b-256 against the row, and calls complete_media_upload().
-- Messages can only reference media that is `ready`; pending uploads that are
-- never confirmed are swept by cleanup_stale_media_uploads().
-- ============================================================================

alter table public.media
  add column if not exists upload_status text not null default 'ready'
    check (upload_status in ('pending', 'ready')),
  add column if not exists confirmed_at timestamptz;
-- Existing rows were verified by the old upload path; new rows start pending.
alter table public.media alter column upload_status set default 'pending';

alter table public.media
  add constraint media_encrypted_hash_format check (encrypted_hash ~ '^[0-9a-f]{64}$') not valid;

comment on column public.media.storage_object_id is
  'Backend-prefixed id of the ENCRYPTED blob: sb:<conversation_id>/<media_id> (Supabase Storage) or drive:<fileId>';
comment on column public.media.upload_status is
  'pending: upload URL issued, object not verified yet; ready: size + hash verified, may be referenced by messages';

create index if not exists media_pending_idx on public.media (created_at) where upload_status = 'pending';
create index if not exists media_uploader_created_idx on public.media (uploader_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- begin_media_upload: service role only (called by the media-upload function
-- after it authenticated the caller). Returns the new media id.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.begin_media_upload(
  p_conversation_id uuid,
  p_uploader_id     uuid,
  p_encrypted_size  bigint,
  p_encrypted_hash  text,
  p_backend         text,
  p_max_bytes       bigint,
  p_max_per_minute  integer default 30,
  p_max_pending     integer default 20
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  if not public.is_conversation_member(p_conversation_id, p_uploader_id) then
    raise exception 'not a member of this conversation' using errcode = '42501';
  end if;
  if p_encrypted_size is null or p_encrypted_size <= 0 then
    raise exception 'invalid size' using errcode = '22023';
  end if;
  if p_encrypted_size > p_max_bytes then
    raise exception 'file too large' using errcode = '54000';
  end if;
  if p_encrypted_hash is null or p_encrypted_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid hash' using errcode = '22023';
  end if;
  if p_backend not in ('supabase', 'drive') then
    raise exception 'invalid backend' using errcode = '22023';
  end if;

  -- Serialise concurrent uploads of one user so the limits below can't be raced.
  perform pg_advisory_xact_lock(hashtextextended('vero.media.' || p_uploader_id::text, 0));

  if (select count(*) from public.media
      where uploader_id = p_uploader_id and created_at > now() - interval '1 minute') >= p_max_per_minute then
    raise exception 'too many uploads' using errcode = '53400';
  end if;
  if (select count(*) from public.media
      where uploader_id = p_uploader_id and upload_status = 'pending' and deleted_at is null) >= p_max_pending then
    raise exception 'too many unfinished uploads' using errcode = '53400';
  end if;

  insert into public.media (id, conversation_id, uploader_id, storage_object_id, encrypted_size, encrypted_hash, upload_status)
  values (
    v_id,
    p_conversation_id,
    p_uploader_id,
    case p_backend
      when 'supabase' then 'sb:' || p_conversation_id::text || '/' || v_id::text
      else 'drive:pending'
    end,
    p_encrypted_size,
    p_encrypted_hash,
    'pending'
  );
  return v_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- complete_media_upload: service role only. p_ok=false marks the row deleted so
-- cleanup-expired removes whatever was uploaded. Returns true if a pending row
-- of that uploader was updated.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.complete_media_upload(
  p_media_id    uuid,
  p_uploader_id uuid,
  p_ok          boolean,
  p_object_id   text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_ok then
    update public.media
       set upload_status = 'ready',
           confirmed_at = now(),
           storage_object_id = coalesce(p_object_id, storage_object_id)
     where id = p_media_id
       and uploader_id = p_uploader_id
       and upload_status = 'pending'
       and deleted_at is null;
  else
    update public.media
       set deleted_at = now(),
           storage_object_id = coalesce(p_object_id, storage_object_id)
     where id = p_media_id
       and uploader_id = p_uploader_id
       and upload_status = 'pending'
       and deleted_at is null;
  end if;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- cleanup_stale_media_uploads: pending uploads that were never confirmed are
-- marked deleted (signed upload URLs expire after 2 hours).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.cleanup_stale_media_uploads(p_older_than interval default interval '6 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.media
     set deleted_at = now()
   where upload_status = 'pending'
     and deleted_at is null
     and created_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- media_download_target: service role only (media-download function). Returns
-- the stored object only to a current member of the media's conversation, and
-- only once the upload was verified. Same empty result for "missing", "not
-- yours", "deleted" and "not ready", so ids can't be probed.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.media_download_target(p_media_id uuid, p_user_id uuid)
returns table (storage_object_id text, encrypted_size bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select m.storage_object_id, m.encrypted_size
  from public.media m
  where m.id = p_media_id
    and m.deleted_at is null
    and m.upload_status = 'ready'
    and public.is_conversation_member(m.conversation_id, p_user_id);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Messages may only reference verified, live media. (Separate trigger so the
-- messages_before_insert function from 001 stays untouched.)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.messages_check_media_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.media_id is not null and not exists (
    select 1 from public.media
    where id = new.media_id and upload_status = 'ready' and deleted_at is null
  ) then
    raise exception 'media upload is not complete' using errcode = '22023';
  end if;
  return new;
end;
$$;

create or replace trigger messages_check_media_ready
  before insert on public.messages
  for each row execute function public.messages_check_media_ready();

-- Clients still only READ media rows (RLS policy from 001); writes go through
-- the functions above with the service role.
revoke execute on function public.begin_media_upload(uuid, uuid, bigint, text, text, bigint, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.complete_media_upload(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke execute on function public.cleanup_stale_media_uploads(interval) from public, anon, authenticated;
revoke execute on function public.messages_check_media_ready() from public, anon, authenticated;
revoke execute on function public.media_download_target(uuid, uuid) from public, anon, authenticated;
grant execute on function public.media_download_target(uuid, uuid) to service_role;
grant execute on function public.begin_media_upload(uuid, uuid, bigint, text, text, bigint, integer, integer) to service_role;
grant execute on function public.complete_media_upload(uuid, uuid, boolean, text) to service_role;
grant execute on function public.cleanup_stale_media_uploads(interval) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Bucket hardening: private, ciphertext only, 50 MB per object (the Supabase
-- free-plan cap). Still no storage.objects policies: clients only ever use
-- signed URLs minted by the Edge Functions.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public)
    values ('vero-media', 'vero-media', false)
    on conflict (id) do nothing;

    update storage.buckets
       set public = false,
           file_size_limit = 52428800,
           allowed_mime_types = array['application/octet-stream']
     where id = 'vero-media';
  end if;
end;
$$;

-- Sweep stale pending uploads together with expired messages (if pg_cron is on).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vero-cleanup-stale-uploads', '17 * * * *', 'select public.cleanup_stale_media_uploads()');
  end if;
end;
$$;
