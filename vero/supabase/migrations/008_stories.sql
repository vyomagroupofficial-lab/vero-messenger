-- ============================================================================
-- Vero Messenger - Stories / Status (end-to-end encrypted, 24 hours)
-- ============================================================================
-- Security model
--   * A story is encrypted on the author's device exactly like a message
--     (src/core/crypto/primitives.ts envelope v2, bound to
--     "story:<authorId>|<storyId>|<authorDeviceId>"). The server stores:
--       stories.ciphertext          envelope body + the AUTHOR's own device slots
--       story_recipients.key_slots  the content-key slots for ONE recipient's devices
--     so each recipient only ever downloads their own key slots.
--   * The audience is resolved on the author's device at post time (from the
--     synced story_privacy setting) and must be the author's contacts (people
--     they share an active, unblocked direct chat with). post_story() drops
--     anyone else.
--   * RLS: a story row is readable only by its author and its recipients and
--     only until it expires. Views are visible only to the author.
--   * Encrypted media lives in the private `vero-stories` Storage bucket under
--     <authorId>/<storyId>/<uuid>.bin; storage policies reuse the same story
--     authorisation. Expired/deleted stories flag their blob in
--     story_media_trash; the `stories-cleanup` Edge Function removes them.
--   * Realtime: recipients get a content-free `story.new` ping on their
--     private user:<id> topic.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- STORY PRIVACY (synced per-user setting; own row only)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.story_privacy (
  user_id        uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  audience       text not null default 'contacts'
                 check (audience in ('contacts', 'contacts_except', 'only')),
  except_user_ids uuid[] not null default '{}' check (cardinality(except_user_ids) <= 2000),
  only_user_ids   uuid[] not null default '{}' check (cardinality(only_user_ids) <= 2000),
  -- Authors whose stories this user has muted (sorted to the bottom of the tray).
  muted_user_ids  uuid[] not null default '{}' check (cardinality(muted_user_ids) <= 2000),
  updated_at     timestamptz not null default now()
);

create trigger story_privacy_updated_at
  before update on public.story_privacy
  for each row execute function public.set_updated_at();

alter table public.story_privacy enable row level security;

create policy "users manage their own story privacy"
  on public.story_privacy for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.story_privacy from anon, authenticated;
grant select, insert, update, delete on public.story_privacy to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- STORIES, RECIPIENTS, VIEWS
-- ─────────────────────────────────────────────────────────────────────────────

create table public.stories (
  -- Client-generated: the id is bound into the envelope's associated data.
  id               uuid primary key,
  author_id        uuid not null references public.profiles (id) on delete cascade,
  author_device_id uuid not null references public.devices (id) on delete cascade,
  -- Coarse type only; text vs photo vs video, colours, captions are encrypted.
  story_type       text not null check (story_type in ('text', 'media')),
  ciphertext       text not null check (char_length(ciphertext) between 1 and 65536),
  media_path       text check (media_path is null or char_length(media_path) <= 200),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default (now() + interval '24 hours'),
  check (expires_at > created_at and expires_at <= created_at + interval '24 hours'),
  check ((story_type = 'media') = (media_path is not null))
);

create index stories_author_idx on public.stories (author_id, created_at desc);
create index stories_expiry_idx on public.stories (expires_at);
create unique index stories_media_path_idx on public.stories (media_path) where media_path is not null;

create table public.story_recipients (
  story_id     uuid not null references public.stories (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  -- deviceId -> base64(boxNonce || box(contentKey || binding)) for THIS recipient's devices
  key_slots    jsonb not null
               check (jsonb_typeof(key_slots) = 'object' and pg_column_size(key_slots) <= 16384),
  primary key (story_id, recipient_id)
);

create index story_recipients_recipient_idx on public.story_recipients (recipient_id);

create table public.story_views (
  story_id  uuid not null references public.stories (id) on delete cascade,
  viewer_id uuid not null references public.profiles (id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer_id)
);

-- Blobs waiting to be removed from the `vero-stories` bucket.
create table public.story_media_trash (
  object_path text primary key,
  flagged_at  timestamptz not null default now()
);

-- ── Helpers (SECURITY DEFINER so policies never recurse) ────────────────────

-- Caller authored this story and it has not expired.
create or replace function public.is_story_author(p_story_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.stories
    where id = p_story_id and author_id = auth.uid() and expires_at > now()
  );
$$;

-- Caller is in the story's audience, it has not expired, and neither side has
-- blocked the other since it was posted.
create or replace function public.is_story_recipient(p_story_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.story_recipients r
    join public.stories s on s.id = r.story_id
    where r.story_id = p_story_id
      and r.recipient_id = auth.uid()
      and s.expires_at > now()
      and not public.is_blocked_between(s.author_id, r.recipient_id)
  );
$$;

-- "Contacts" for stories = people sharing an active, unblocked direct chat.
-- Internal only (not granted): it would otherwise reveal who talks to whom.
create or replace function public.are_story_contacts(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select a <> b
     and not public.is_blocked_between(a, b)
     and exists (
       select 1
       from public.conversations c
       join public.conversation_members ma on ma.conversation_id = c.id and ma.user_id = a and ma.left_at is null
       join public.conversation_members mb on mb.conversation_id = c.id and mb.user_id = b and mb.left_at is null
       where c.conversation_type = 'direct'
     );
$$;

alter table public.stories enable row level security;
alter table public.story_recipients enable row level security;
alter table public.story_views enable row level security;
alter table public.story_media_trash enable row level security;

create policy "authors and recipients read live stories"
  on public.stories for select to authenticated
  using (
    (author_id = (select auth.uid()) and expires_at > now())
    or public.is_story_recipient(id)
  );

create policy "recipients read their own key slots; authors read the audience"
  on public.story_recipients for select to authenticated
  using (
    (recipient_id = (select auth.uid()) and public.is_story_recipient(story_id))
    or public.is_story_author(story_id)
  );

create policy "only the author sees who viewed a story"
  on public.story_views for select to authenticated
  using (public.is_story_author(story_id));

-- Every write goes through the RPCs below; the trash is service-role only.
revoke all on public.stories from anon, authenticated;
revoke all on public.story_recipients from anon, authenticated;
revoke all on public.story_views from anon, authenticated;
revoke all on public.story_media_trash from anon, authenticated;
grant select on public.stories to authenticated;
grant select on public.story_recipients to authenticated;
grant select on public.story_views to authenticated;
grant select, insert, delete on public.story_media_trash to service_role;

-- ── Realtime ping (no content) to every recipient ───────────────────────────

create or replace function public.story_recipients_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author uuid;
begin
  select author_id into v_author from public.stories where id = new.story_id;
  perform realtime.send(
    jsonb_build_object('story_id', new.story_id, 'author_id', v_author),
    'story.new',
    'user:' || new.recipient_id::text,
    true
  );
  return null;
end;
$$;

create trigger story_recipients_after_insert
  after insert on public.story_recipients
  for each row execute function public.story_recipients_after_insert();

-- ─────────────────────────────────────────────────────────────────────────────
-- RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- Active device keys of the caller and of the given users who are the caller's
-- story contacts: the devices a new story's content key is wrapped for.
create or replace function public.get_story_audience_devices(p_user_ids uuid[])
returns table (device_id uuid, user_id uuid, identity_public_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.user_id, d.identity_public_key
  from public.devices d
  where d.revoked_at is null
    and auth.uid() is not null
    and cardinality(coalesce(p_user_ids, '{}')) <= 2000
    and (
      d.user_id = auth.uid()
      or (d.user_id = any (p_user_ids) and public.are_story_contacts(auth.uid(), d.user_id))
    );
$$;

-- Posts a story. p_recipients = [{ "user_id": uuid, "key_slots": { deviceId: slot } }].
-- Recipients who are not the caller's contacts (or are blocked) are dropped.
-- Returns the number of recipients accepted.
create or replace function public.post_story(
  p_story_id   uuid,
  p_device_id  uuid,
  p_story_type text,
  p_ciphertext text,
  p_media_path text,
  p_recipients jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_count integer;
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_story_id is null then
    raise exception 'story id required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.devices where id = p_device_id and user_id = v_me and revoked_at is null
  ) then
    raise exception 'device is not registered to this user' using errcode = '42501';
  end if;
  if p_story_type not in ('text', 'media') then
    raise exception 'invalid story type' using errcode = '22023';
  end if;
  if p_story_type = 'media' and (
       p_media_path is null
       or p_media_path !~ ('^' || v_me::text || '/' || p_story_id::text
                           || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$')
     ) then
    raise exception 'media must be uploaded under <you>/<story>/' using errcode = '22023';
  end if;
  if p_story_type = 'text' and p_media_path is not null then
    raise exception 'text stories have no media' using errcode = '22023';
  end if;
  if p_recipients is null or jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) > 2000 then
    raise exception 'invalid recipients' using errcode = '22023';
  end if;

  insert into public.stories (id, author_id, author_device_id, story_type, ciphertext, media_path)
  values (p_story_id, v_me, p_device_id, p_story_type, p_ciphertext, p_media_path);

  with parsed as (
    select case when e ->> 'user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (e ->> 'user_id')::uuid end as user_id,
           e -> 'key_slots' as key_slots
    from jsonb_array_elements(p_recipients) as e
    where jsonb_typeof(e) = 'object'
  ),
  valid as (
    select distinct on (user_id) user_id, key_slots
    from parsed
    where user_id is not null
      and jsonb_typeof(key_slots) = 'object'
      and key_slots <> '{}'::jsonb
      and public.are_story_contacts(v_me, user_id)
  )
  insert into public.story_recipients (story_id, recipient_id, key_slots)
  select p_story_id, user_id, key_slots from valid;
  get diagnostics v_count = row_count;

  -- Let the author's other devices refresh too.
  perform realtime.send(jsonb_build_object('story_id', p_story_id, 'author_id', v_me),
                        'story.new', 'user:' || v_me::text, true);
  return v_count;
end;
$$;

-- Records that the caller viewed a story (the client skips this when the
-- user has turned read receipts off). Idempotent; pings the author.
create or replace function public.mark_story_viewed(p_story_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author uuid;
begin
  if public.is_story_author(p_story_id) then
    return;
  end if;
  if not public.is_story_recipient(p_story_id) then
    raise exception 'story not found' using errcode = 'P0002';
  end if;

  insert into public.story_views (story_id, viewer_id)
  values (p_story_id, auth.uid())
  on conflict (story_id, viewer_id) do nothing;

  if found then
    select author_id into v_author from public.stories where id = p_story_id;
    perform realtime.send(jsonb_build_object('story_id', p_story_id, 'viewer_id', auth.uid()),
                          'story.viewed', 'user:' || v_author::text, true);
  end if;
end;
$$;

-- Author deletes a story early. Its blob is flagged for removal and the
-- audience is told to drop it.
create or replace function public.delete_story(p_story_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_media      text;
  v_recipients uuid[];
begin
  select coalesce(array_agg(recipient_id), '{}') into v_recipients
  from public.story_recipients
  where story_id = p_story_id
    and exists (select 1 from public.stories where id = p_story_id and author_id = auth.uid());

  delete from public.stories
  where id = p_story_id and author_id = auth.uid()
  returning media_path into v_media;

  if not found then
    raise exception 'story not found' using errcode = 'P0002';
  end if;

  if v_media is not null then
    insert into public.story_media_trash (object_path) values (v_media)
    on conflict (object_path) do nothing;
  end if;

  perform realtime.send(jsonb_build_object('story_id', p_story_id),
                        'story.deleted', 'user:' || r::text, true)
  from unnest(v_recipients || auth.uid()) as r;
end;
$$;

-- Hard-deletes expired stories (recipients and views cascade), flags their
-- blobs, and flags orphaned uploads (never attached to a story) older than a
-- day. Scheduled below with pg_cron; the stories-cleanup function removes blobs.
create or replace function public.cleanup_expired_stories()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.story_media_trash (object_path)
  select media_path from public.stories
  where expires_at <= now() and media_path is not null
  on conflict (object_path) do nothing;

  delete from public.stories where expires_at <= now();
  get diagnostics v_count = row_count;

  if to_regclass('storage.objects') is not null then
    execute $q$
      insert into public.story_media_trash (object_path)
      select o.name from storage.objects o
      where o.bucket_id = 'vero-stories'
        and o.created_at < now() - interval '25 hours'
        and not exists (select 1 from public.stories s where s.media_path = o.name)
      on conflict (object_path) do nothing
    $q$;
  end if;

  return v_count;
end;
$$;

-- ── Storage authorisation helpers (used by the bucket policies below) ───────

-- Authors upload only into their own folder: <me>/<storyId>/<uuid>.bin
create or replace function public.can_upload_story_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and p_name ~ ('^' || auth.uid()::text
                   || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                   || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$');
$$;

-- Same audience as the story row itself.
create or replace function public.can_read_story_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.stories s
    where s.media_path = p_name
      and (public.is_story_author(s.id) or public.is_story_recipient(s.id))
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Function privileges
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function public.is_story_author(uuid) from public, anon, authenticated;
revoke execute on function public.is_story_recipient(uuid) from public, anon, authenticated;
revoke execute on function public.are_story_contacts(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.story_recipients_after_insert() from public, anon, authenticated;
revoke execute on function public.get_story_audience_devices(uuid[]) from public, anon, authenticated;
revoke execute on function public.post_story(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.mark_story_viewed(uuid) from public, anon, authenticated;
revoke execute on function public.delete_story(uuid) from public, anon, authenticated;
revoke execute on function public.cleanup_expired_stories() from public, anon, authenticated;
revoke execute on function public.can_upload_story_object(text) from public, anon, authenticated;
revoke execute on function public.can_read_story_object(text) from public, anon, authenticated;

grant execute on function public.is_story_author(uuid) to authenticated;
grant execute on function public.is_story_recipient(uuid) to authenticated;
grant execute on function public.get_story_audience_devices(uuid[]) to authenticated;
grant execute on function public.post_story(uuid, uuid, text, text, text, jsonb) to authenticated;
grant execute on function public.mark_story_viewed(uuid) to authenticated;
grant execute on function public.delete_story(uuid) to authenticated;
grant execute on function public.can_upload_story_object(text) to authenticated;
grant execute on function public.can_read_story_object(text) to authenticated;
grant execute on function public.cleanup_expired_stories() to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEDULED CLEANUP (only if pg_cron is enabled on the project)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vero-cleanup-stories', '*/10 * * * *', 'select public.cleanup_expired_stories()');
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRIVATE BUCKET for encrypted story media + policies (Supabase only)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('vero-stories', 'vero-stories', false)
    on conflict (id) do nothing;

    if exists (select 1 from information_schema.columns
               where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
      execute $q$update storage.buckets set file_size_limit = 52428800 where id = 'vero-stories'$q$;
    end if;
  end if;

  if to_regclass('storage.objects') is not null then
    execute $q$drop policy if exists "vero story authors upload encrypted media" on storage.objects$q$;
    execute $q$drop policy if exists "vero story audience downloads encrypted media" on storage.objects$q$;
    execute $q$
      create policy "vero story authors upload encrypted media"
        on storage.objects for insert to authenticated
        with check (bucket_id = 'vero-stories' and public.can_upload_story_object(name))
    $q$;
    execute $q$
      create policy "vero story audience downloads encrypted media"
        on storage.objects for select to authenticated
        using (bucket_id = 'vero-stories' and public.can_read_story_object(name))
    $q$;
  end if;
end;
$$;
