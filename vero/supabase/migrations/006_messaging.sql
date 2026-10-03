-- ============================================================================
-- Vero Messenger - 006: core messaging features
-- ============================================================================
-- Edits, delete-for-everyone window, forwarding, starred-message sync,
-- pinned / archived chats.
--
-- Security / privacy notes
--   * Edits travel as end-to-end encrypted CONTROL messages. The server only
--     learns a new coarse message_type 'control' (it cannot tell an edit from
--     any other control payload, nor which message was edited). Recipients
--     check sender and 15-minute window on device.
--   * delete_message() keeps its signature; it is replaced to enforce a
--     48-hour window and to ping members' inboxes so chat lists (and devices
--     that don't have the chat open) learn about the deletion.
--   * forward_media() lets a member reuse an encrypted blob they can already
--     download in another conversation they belong to, without re-uploading.
--     The file key never reaches the server; it is re-wrapped inside the new
--     E2EE message. Blobs are reference-counted by storage_object_id (see
--     the cleanup-expired Edge Function).
--   * Stars are synced between a user's OWN devices as encrypted
--     self_sync_events (ciphertext addressed to the user's devices only), so
--     the server learns neither which messages are starred nor even that an
--     event is about stars.
--   * Pin / archive state lives in conversation_prefs (own rows only) rather
--     than on conversation_members, whose rows are readable by every
--     co-member: whether you pinned or archived a chat is nobody else's
--     business. Writes go through pin_conversation() / archive_conversation().
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- MESSAGE TYPE: add 'control' (edits and other encrypted control payloads)
-- ─────────────────────────────────────────────────────────────────────────────
-- 001 created an unnamed CHECK. Drop whichever message_type CHECK exists and
-- recreate it, keeping every value already allowed (another migration may
-- have added some) plus 'control'.

do $$
declare
  r       record;
  v_types text[] := array['text', 'media', 'reaction', 'system'];
begin
  for r in
    select c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.conrelid = 'public.messages'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%message_type%'
  loop
    v_types := v_types || array(select m[1] from regexp_matches(r.def, '''([a-z_]+)''', 'g') as m);
    execute format('alter table public.messages drop constraint %I', r.conname);
  end loop;
  v_types := array(select distinct t from unnest(v_types || array['control']) as t order by t);
  execute format(
    'alter table public.messages add constraint messages_message_type_check check (message_type = any (%L::text[]))',
    v_types);
end;
$$;

-- Control messages carry everything inside the ciphertext.
create or replace function public.messages_control_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.message_type = 'control'
     and (new.media_id is not null or new.reply_to_message_id is not null) then
    raise exception 'control messages cannot reference media or replies' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger messages_control_check
  before insert on public.messages
  for each row execute function public.messages_control_check();

-- Devices that were offline catch up on deletions with
-- "deleted_at > <last sync>" (RLS limits it to their conversations).
create index messages_deleted_idx on public.messages (deleted_at) where deleted_at is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- DELETE FOR EVERYONE (48-hour window)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.delete_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg public.messages;
begin
  select * into v_msg
  from public.messages
  where id = p_message_id
    and sender_user_id = auth.uid()
    and deleted_at is null
  for update;

  if not found then
    raise exception 'message not found' using errcode = 'P0002';
  end if;

  if v_msg.created_at < now() - interval '48 hours' then
    raise exception 'messages can only be deleted for everyone within 48 hours' using errcode = '22023';
  end if;

  update public.messages
     set deleted_at = now(), ciphertext = '', expires_at = null
   where id = p_message_id;

  if v_msg.media_id is not null then
    update public.media set deleted_at = now() where id = v_msg.media_id and deleted_at is null;
  end if;

  perform realtime.send(jsonb_build_object('id', p_message_id, 'conversation_id', v_msg.conversation_id),
                        'message.deleted', 'conversation:' || v_msg.conversation_id::text, true);

  -- Chats that aren't open (and the sender's other devices) update their lists.
  perform realtime.send(
    jsonb_build_object('conversation_id', v_msg.conversation_id, 'message_id', p_message_id),
    'inbox.deleted',
    'user:' || cm.user_id::text,
    true
  )
  from public.conversation_members cm
  where cm.conversation_id = v_msg.conversation_id and cm.left_at is null;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- FORWARDING MEDIA WITHOUT RE-UPLOAD
-- ─────────────────────────────────────────────────────────────────────────────
-- Creates a media row in p_conversation_id that points at the same encrypted
-- blob. Allowed only when the caller can already download the source (member
-- of its conversation, attached to a live message) and is a member of the
-- target. The new row is owned by the caller, so the usual
-- messages_before_insert check (media uploaded by the sender, same
-- conversation) applies unchanged.

create or replace function public.forward_media(p_media_id uuid, p_conversation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_src    public.media;
  v_recent integer;
  v_id     uuid;
begin
  if v_me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select * into v_src from public.media where id = p_media_id;
  -- Same error for "missing" and "not yours" so ids can't be probed.
  if not found
     or v_src.deleted_at is not null
     or not public.is_conversation_member(v_src.conversation_id)
     or not exists (
       select 1 from public.messages msg
       where msg.media_id = p_media_id
         and msg.conversation_id = v_src.conversation_id
         and msg.deleted_at is null
         and (msg.expires_at is null or msg.expires_at > now())
     ) then
    raise exception 'media not found' using errcode = 'P0002';
  end if;

  if not public.is_conversation_member(p_conversation_id) then
    raise exception 'not a member of the target conversation' using errcode = '42501';
  end if;

  select count(*) into v_recent
  from public.media
  where uploader_id = v_me and created_at > now() - interval '1 minute';
  if v_recent >= 60 then
    raise exception 'too many attachments, slow down' using errcode = '54000';
  end if;

  insert into public.media (conversation_id, uploader_id, storage_object_id, encrypted_size, encrypted_hash)
  values (p_conversation_id, v_me, v_src.storage_object_id, v_src.encrypted_size, v_src.encrypted_hash)
  returning id into v_id;

  return v_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENCRYPTED SYNC BETWEEN A USER'S OWN DEVICES (stars, ...)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.self_sync_events (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  sender_device_id uuid not null references public.devices (id) on delete cascade,
  -- Envelope addressed to the user's own devices only (opaque to the server).
  ciphertext       text not null check (char_length(ciphertext) between 1 and 65536),
  created_at       timestamptz not null default now()
);

create index self_sync_events_user_created_idx on public.self_sync_events (user_id, created_at);

alter table public.self_sync_events enable row level security;

create policy "users read their own sync events"
  on public.self_sync_events for select to authenticated
  using (user_id = (select auth.uid()));

create policy "users write their own sync events"
  on public.self_sync_events for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "users delete their own sync events"
  on public.self_sync_events for delete to authenticated
  using (user_id = (select auth.uid()));

revoke update on public.self_sync_events from anon, authenticated;
revoke all on public.self_sync_events from anon;

create or replace function public.self_sync_events_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner  uuid;
  v_recent integer;
begin
  select user_id into v_owner
  from public.devices
  where id = new.sender_device_id and revoked_at is null;

  if v_owner is null or v_owner is distinct from auth.uid() then
    raise exception 'sender device is not registered to this user' using errcode = '42501';
  end if;

  new.user_id    := v_owner;
  new.created_at := now();

  select count(*) into v_recent
  from public.self_sync_events
  where user_id = v_owner and created_at > now() - interval '1 minute';
  if v_recent >= 120 then
    raise exception 'too many sync events, slow down' using errcode = '54000';
  end if;

  return new;
end;
$$;

create trigger self_sync_events_before_insert
  before insert on public.self_sync_events
  for each row execute function public.self_sync_events_before_insert();

create or replace function public.self_sync_events_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(jsonb_build_object('id', new.id), 'self.sync', 'user:' || new.user_id::text, true);
  return null;
end;
$$;

create trigger self_sync_events_after_insert
  after insert on public.self_sync_events
  for each row execute function public.self_sync_events_after_insert();

-- Old sync events are dropped; a device offline for longer gets the state
-- through device transfer instead.
create or replace function public.cleanup_self_sync_events()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.self_sync_events where created_at < now() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PINNED / ARCHIVED CHATS (private per-user state)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.conversation_prefs (
  user_id         uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  pinned_at       timestamptz,
  archived_at     timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (user_id, conversation_id),
  check (pinned_at is null or archived_at is null)
);

create index conversation_prefs_pinned_idx on public.conversation_prefs (user_id) where pinned_at is not null;

alter table public.conversation_prefs enable row level security;

create policy "users read their own chat preferences"
  on public.conversation_prefs for select to authenticated
  using (user_id = (select auth.uid()));

-- Writes go through pin_conversation() / archive_conversation().
revoke insert, update, delete on public.conversation_prefs from anon, authenticated;
revoke all on public.conversation_prefs from anon;

create or replace function public.pinned_conversation_limit()
returns integer
language sql
immutable
set search_path = ''
as $$ select 3 $$;

create or replace function public.pin_conversation(p_conversation_id uuid, p_pinned boolean)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_pinned integer;
  v_row    public.conversation_prefs;
begin
  if v_me is null or not public.is_conversation_member(p_conversation_id) then
    raise exception 'not a member of this conversation' using errcode = '42501';
  end if;

  -- Serialise this user's pin changes so two devices can't both take the last slot.
  perform pg_advisory_xact_lock(hashtextextended('vero.pin:' || v_me::text, 0));

  if coalesce(p_pinned, false) then
    select count(*) into v_pinned
    from public.conversation_prefs p
    join public.conversation_members cm
      on cm.conversation_id = p.conversation_id and cm.user_id = p.user_id and cm.left_at is null
    where p.user_id = v_me
      and p.pinned_at is not null
      and p.conversation_id <> p_conversation_id;
    if v_pinned >= public.pinned_conversation_limit() then
      raise exception 'you can pin up to % chats', public.pinned_conversation_limit() using errcode = '23514';
    end if;

    insert into public.conversation_prefs as p (user_id, conversation_id, pinned_at, archived_at)
    values (v_me, p_conversation_id, now(), null)
    on conflict (user_id, conversation_id) do update
      set pinned_at   = coalesce(p.pinned_at, now()),
          archived_at = null,
          updated_at  = now()
    returning * into v_row;
  else
    update public.conversation_prefs
       set pinned_at = null, updated_at = now()
     where user_id = v_me and conversation_id = p_conversation_id
    returning * into v_row;
  end if;

  perform realtime.send(
    jsonb_build_object('conversation_id', p_conversation_id, 'pinned_at', v_row.pinned_at,
                       'archived_at', v_row.archived_at),
    'prefs.changed', 'user:' || v_me::text, true);

  return v_row.pinned_at;
end;
$$;

-- Archiving also unpins. Allowed for chats you have left, too.
create or replace function public.archive_conversation(p_conversation_id uuid, p_archived boolean)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.conversation_prefs;
begin
  if v_me is null or not exists (
    select 1 from public.conversation_members
    where conversation_id = p_conversation_id and user_id = v_me
  ) then
    raise exception 'not a member of this conversation' using errcode = '42501';
  end if;

  if coalesce(p_archived, false) then
    insert into public.conversation_prefs as p (user_id, conversation_id, pinned_at, archived_at)
    values (v_me, p_conversation_id, null, now())
    on conflict (user_id, conversation_id) do update
      set archived_at = coalesce(p.archived_at, now()),
          pinned_at   = null,
          updated_at  = now()
    returning * into v_row;
  else
    update public.conversation_prefs
       set archived_at = null, updated_at = now()
     where user_id = v_me and conversation_id = p_conversation_id
    returning * into v_row;
  end if;

  perform realtime.send(
    jsonb_build_object('conversation_id', p_conversation_id, 'pinned_at', v_row.pinned_at,
                       'archived_at', v_row.archived_at),
    'prefs.changed', 'user:' || v_me::text, true);

  return v_row.archived_at;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Function privileges
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function public.messages_control_check() from public, anon, authenticated;
revoke execute on function public.self_sync_events_before_insert() from public, anon, authenticated;
revoke execute on function public.self_sync_events_after_insert() from public, anon, authenticated;
revoke execute on function public.cleanup_self_sync_events() from public, anon, authenticated;
revoke execute on function public.delete_message(uuid) from public, anon;
revoke execute on function public.forward_media(uuid, uuid) from public, anon;
revoke execute on function public.pin_conversation(uuid, boolean) from public, anon;
revoke execute on function public.archive_conversation(uuid, boolean) from public, anon;
revoke execute on function public.pinned_conversation_limit() from public, anon;

grant execute on function public.delete_message(uuid) to authenticated;
grant execute on function public.forward_media(uuid, uuid) to authenticated;
grant execute on function public.pin_conversation(uuid, boolean) to authenticated;
grant execute on function public.archive_conversation(uuid, boolean) to authenticated;
grant execute on function public.pinned_conversation_limit() to authenticated;
grant execute on function public.cleanup_self_sync_events() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vero-cleanup-self-sync', '17 3 * * *', 'select public.cleanup_self_sync_events()');
  end if;
end;
$$;
