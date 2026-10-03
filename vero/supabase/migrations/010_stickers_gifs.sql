-- ============================================================================
-- Vero Messenger - stickers & GIFs (server side)
-- ============================================================================
-- Stickers need nothing on the server: bundled stickers travel as encrypted
-- {pack, id} references and custom stickers as ordinary encrypted media.
--
-- GIF search runs through the `gif-search` Edge Function so users' IPs and
-- the provider API key never reach Tenor/GIPHY directly. This migration adds:
--   * app_config + get_app_secret(): operator-set configuration (API keys)
--     readable ONLY by the service role. Vault secrets take precedence.
--   * gif_rate_limit_hit(): a per-user fixed-window rate limiter.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- APP CONFIG (shared with 011/012; every statement is idempotent)
--   Set a key:   insert into public.app_config (key, value) values ('TENOR_API_KEY', '...')
--                on conflict (key) do update set value = excluded.value;
--   or Vault:    select vault.create_secret('...', 'TENOR_API_KEY');
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.app_config (
  key        text primary key check (key ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  value      text not null check (char_length(value) <= 4096),
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;
-- No policies: clients can neither read nor write. Only the service role
-- (which bypasses RLS) and SECURITY DEFINER functions below touch it.
revoke all on public.app_config from public, anon, authenticated;
grant select, insert, update, delete on public.app_config to service_role;

drop trigger if exists app_config_updated_at on public.app_config;
create trigger app_config_updated_at
  before update on public.app_config
  for each row execute function public.set_updated_at();

-- Vault (if installed) first, then app_config.
create or replace function public.get_app_secret(p_key text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_value text;
begin
  if p_key is null or p_key !~ '^[A-Z][A-Z0-9_]{1,63}$' then
    return null;
  end if;
  if to_regclass('vault.decrypted_secrets') is not null then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
      into v_value using p_key;
    if v_value is not null and v_value <> '' then
      return v_value;
    end if;
  end if;
  select value into v_value from public.app_config where key = p_key;
  return v_value;
end;
$$;

revoke execute on function public.get_app_secret(text) from public, anon, authenticated;
grant execute on function public.get_app_secret(text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- GIF SEARCH RATE LIMIT (fixed window per user; called by gif-search only)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.gif_search_usage (
  user_id       uuid not null references auth.users (id) on delete cascade,
  window_start  timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (user_id, window_start)
);

alter table public.gif_search_usage enable row level security;
revoke all on public.gif_search_usage from public, anon, authenticated;
grant select, insert, update, delete on public.gif_search_usage to service_role;

-- Counts one request; returns true while the user is within p_limit per window.
create or replace function public.gif_rate_limit_hit(
  p_user_id uuid,
  p_limit integer default 60,
  p_window_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_count  integer;
begin
  if p_user_id is null or p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit arguments' using errcode = '22023';
  end if;

  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.gif_search_usage as u (user_id, window_start, request_count)
  values (p_user_id, v_window, 1)
  on conflict (user_id, window_start)
  do update set request_count = u.request_count + 1
  returning request_count into v_count;

  -- Keep the table small.
  delete from public.gif_search_usage
  where user_id = p_user_id and window_start < v_window - interval '1 day';

  return v_count <= p_limit;
end;
$$;

revoke execute on function public.gif_rate_limit_hit(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.gif_rate_limit_hit(uuid, integer, integer) to service_role;
