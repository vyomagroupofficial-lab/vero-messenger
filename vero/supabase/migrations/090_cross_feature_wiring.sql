-- ============================================================================
-- Cross-feature wiring that has to run after every feature migration.
-- Each feature migration applies on top of 001 alone, so anything that links
-- two features (e.g. 005's push sender with 007's channel posts) lives here.
-- ============================================================================

-- Push notifications for new channel posts (function defined in 005, table in 007).
drop trigger if exists channel_posts_push_after_insert on public.channel_posts;
create trigger channel_posts_push_after_insert
  after insert on public.channel_posts
  for each row execute function public.channel_posts_push_after_insert();

-- ── Calls (002) x push (005) ────────────────────────────────────────────────
-- Call push targets now cover 002's group calls: every current member of the
-- group except the caller, people already in the call, members who muted the
-- group, and anyone blocking / blocked by the caller. 1:1 calls are unchanged
-- (the callee's devices while ringing).
create or replace function public.get_call_push_targets(p_call_id uuid, p_requester uuid default null)
returns table (
  device_id       uuid,
  user_id         uuid,
  token           text,
  previews        boolean,
  caller_name     text,
  conversation_id uuid,
  call_id         uuid,
  call_type       text
)
language sql
stable
security definer
set search_path = ''
as $$
  select pt.device_id, pt.user_id, pt.token,
         coalesce(us.notification_previews, false),
         cp.display_name, cs.conversation_id, cs.id, cs.call_type
  from public.call_sessions cs
  join public.profiles cp on cp.id = cs.caller_id
  join public.devices d on d.user_id = cs.callee_id and d.revoked_at is null
  join public.push_tokens pt on pt.device_id = d.id
  left join public.user_settings us on us.user_id = cs.callee_id
  where cs.id = p_call_id
    and not cs.is_group
    and cs.status = 'ringing'
    and cs.created_at > now() - interval '2 minutes'
    and (p_requester is null or cs.caller_id = p_requester)
    and not exists (
      select 1 from public.blocks b
      where b.blocker_user_id = cs.callee_id and b.blocked_user_id = cs.caller_id
    )
  union all
  select pt.device_id, pt.user_id, pt.token,
         coalesce(us.notification_previews, false),
         cp.display_name, cs.conversation_id, cs.id, cs.call_type
  from public.call_sessions cs
  join public.profiles cp on cp.id = cs.caller_id
  join public.conversation_members cm
    on cm.conversation_id = cs.conversation_id
   and cm.left_at is null
   and cm.user_id <> cs.caller_id
   and (cm.muted_until is null or cm.muted_until <= now())
  join public.devices d on d.user_id = cm.user_id and d.revoked_at is null
  join public.push_tokens pt on pt.device_id = d.id
  left join public.user_settings us on us.user_id = cm.user_id
  where cs.id = p_call_id
    and cs.is_group
    and cs.status = 'active'
    and cs.created_at > now() - interval '2 minutes'
    and (p_requester is null or cs.caller_id = p_requester)
    and not public.is_blocked_between(cs.caller_id, cm.user_id)
    and not exists (
      select 1 from public.call_participants p
      where p.call_id = cs.id and p.user_id = cm.user_id and p.left_at is null
    );
$$;

revoke execute on function public.get_call_push_targets(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_call_push_targets(uuid, uuid) to service_role;

-- New calls ring from the database when push is configured (pg_net + Vault,
-- see 005). push_sent_at tells the caller's app it needn't ask send-push itself.
create or replace function public.call_sessions_push_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.send_push_event('call', jsonb_build_object('call_id', new.id)) is not null then
    update public.call_sessions set push_sent_at = now() where id = new.id;
  end if;
  return null;
end;
$$;

revoke execute on function public.call_sessions_push_after_insert() from public, anon, authenticated;

drop trigger if exists call_sessions_push_after_insert on public.call_sessions;
create trigger call_sessions_push_after_insert
  after insert on public.call_sessions
  for each row execute function public.call_sessions_push_after_insert();

-- ── Blob cleanup functions on a schedule ────────────────────────────────────
-- cleanup-expired (media) and stories-cleanup delete encrypted blobs from
-- Storage. pg_cron calls them through pg_net with the CRON_SECRET kept in
-- Vault (005's project_url + 010's get_app_secret). No-op until both secrets
-- exist, so this is safe to apply before configuration.
create or replace function public.vero_invoke_cleanup_function(p_name text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text := public.vero_read_secret('project_url');
  v_secret text := public.get_app_secret('CRON_SECRET');
  v_id     bigint;
begin
  if p_name not in ('cleanup-expired', 'stories-cleanup') or v_url is null or v_secret is null
     or to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    return null;
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 30000)'
    into v_id
    using rtrim(v_url, '/') || '/functions/v1/' || p_name, '{}'::jsonb,
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret);
  return v_id;
end;
$$;

revoke execute on function public.vero_invoke_cleanup_function(text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vero-blob-cleanup-media', '*/15 * * * *',
                          $c$select public.vero_invoke_cleanup_function('cleanup-expired')$c$);
    perform cron.schedule('vero-blob-cleanup-stories', '*/30 * * * *',
                          $c$select public.vero_invoke_cleanup_function('stories-cleanup')$c$);
  end if;
end;
$$;
