-- ============================================================================
-- Vero Messenger - bots & mini-apps
-- ============================================================================
-- A bot is a real Vero account (auth user + profile with is_bot = true) whose
-- process holds its own device key, like any other client. Chats with bots
-- stay end-to-end encrypted: the server never decrypts anything for a bot.
--
--   * Bot accounts are created only by the `bot-admin` Edge Function (service
--     role), which returns the bot's token to its owner exactly once.
--   * profiles.is_bot can't be set by clients (column grants from 001), only
--     by the trigger below when a bots row is created.
--   * Owners edit description / commands / mini-app / webhook / visibility
--     directly (RLS + column grants). The token hash and webhook URL are not
--     readable by other users.
--   * Optional webhook: if pg_net is installed, each new message in a bot's
--     conversation POSTs {conversation_id, message_id} (no content) to the
--     bot's webhook so serverless bots can wake up and fetch + decrypt it.
-- ============================================================================

alter table public.profiles add column if not exists is_bot boolean not null default false;

create table public.bots (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null unique references public.profiles (id) on delete cascade,
  owner_id     uuid not null references auth.users (id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 64),
  description  text check (description is null or char_length(description) <= 512),
  -- [{ "command": "start", "description": "..." }, ...]
  commands     jsonb not null default '[]'::jsonb
               check (jsonb_typeof(commands) = 'array' and jsonb_array_length(commands) <= 50
                      and pg_column_size(commands) <= 16384),
  -- https only, real host names (no IP literals / localhost)
  mini_app_url text check (mini_app_url is null or (
                 char_length(mini_app_url) <= 512
                 and mini_app_url ~ '^https://([a-z0-9-]+\.)+[a-z]{2,63}(:[0-9]{2,5})?(/[^[:space:]]*)?$')),
  webhook_url  text check (webhook_url is null or (
                 char_length(webhook_url) <= 512
                 and webhook_url ~ '^https://([a-z0-9-]+\.)+[a-z]{2,63}(:[0-9]{2,5})?(/[^[:space:]]*)?$')),
  token_hash   text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  is_public    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (user_id <> owner_id)
);

create index bots_owner_idx on public.bots (owner_id);
create index bots_public_idx on public.bots (is_public) where is_public;

create trigger bots_updated_at
  before update on public.bots
  for each row execute function public.set_updated_at();

-- Validates command entries (shape + lengths). Used by a CHECK-like trigger.
create or replace function public.bot_commands_valid(p_commands jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_commands) = 'array'
     and not exists (
       select 1 from jsonb_array_elements(p_commands) c
       where jsonb_typeof(c) <> 'object'
          or coalesce(c ->> 'command', '') !~ '^[a-z0-9_]{1,32}$'
          or char_length(coalesce(c ->> 'description', '')) > 128
     );
$$;

create or replace function public.bots_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.bot_commands_valid(new.commands) then
    raise exception 'invalid bot commands' using errcode = '22023';
  end if;
  if tg_op = 'INSERT' then
    if exists (select 1 from public.profiles where id = new.owner_id and is_bot) then
      raise exception 'bots cannot own bots' using errcode = '42501';
    end if;
    if (select count(*) from public.bots where owner_id = new.owner_id) >= 20 then
      raise exception 'bot limit reached' using errcode = '54000';
    end if;
  end if;
  return new;
end;
$$;

create trigger bots_before_write
  before insert or update on public.bots
  for each row execute function public.bots_before_write();

-- Flags the bot's profile; the only way is_bot ever becomes true.
create or replace function public.bots_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set is_bot = true where id = new.user_id;
  return null;
end;
$$;

create trigger bots_after_insert
  after insert on public.bots
  for each row execute function public.bots_after_insert();

alter table public.bots enable row level security;

create policy "public bots, own bots and bots you chat with are visible"
  on public.bots for select to authenticated
  using (
    is_public
    or owner_id = (select auth.uid())
    or public.has_shared_conversation(user_id)
  );

create policy "owners update their bots"
  on public.bots for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- Rows are created/deleted by bot-admin (service role). Clients read the
-- public columns only, and owners may change the editable ones.
revoke all on public.bots from anon, authenticated;
grant select (id, user_id, owner_id, name, description, commands, mini_app_url, is_public, created_at, updated_at)
  on public.bots to authenticated;
grant update (description, commands, mini_app_url, webhook_url, is_public) on public.bots to authenticated;

-- The owner's own bots including the webhook URL (never the token hash).
create or replace function public.my_bots()
returns table (
  id uuid, user_id uuid, name text, description text, commands jsonb, mini_app_url text,
  webhook_url text, is_public boolean, created_at timestamptz, username text
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.user_id, b.name, b.description, b.commands, b.mini_app_url,
         b.webhook_url, b.is_public, b.created_at, p.username
  from public.bots b
  join public.profiles p on p.id = b.user_id
  where b.owner_id = auth.uid()
  order by b.created_at desc;
$$;

revoke execute on function public.my_bots() from public, anon;
grant execute on function public.my_bots() to authenticated;
revoke execute on function public.bot_commands_valid(jsonb) from public, anon, authenticated;
revoke execute on function public.bots_before_write() from public, anon, authenticated;
revoke execute on function public.bots_after_insert() from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- WEBHOOK WAKE-UPS (only when pg_net is installed; metadata only, no content)
-- A forged ping is harmless: the bot fetches the message with its own
-- credentials and can only decrypt what was really encrypted to its device.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.bots_notify_webhooks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return null;
  end if;
  for r in
    select b.user_id, b.webhook_url
    from public.bots b
    join public.conversation_members cm
      on cm.user_id = b.user_id and cm.conversation_id = new.conversation_id and cm.left_at is null
    where b.webhook_url is not null and b.user_id <> new.sender_user_id
  loop
    execute 'select net.http_post(url := $1, body := $2, params := ''{}''::jsonb, headers := $3, timeout_milliseconds := 5000)'
      using r.webhook_url,
            jsonb_build_object('type', 'message.new', 'bot_user_id', r.user_id,
                               'conversation_id', new.conversation_id, 'message_id', new.id),
            '{"Content-Type": "application/json"}'::jsonb;
  end loop;
  return null;
end;
$$;

revoke execute on function public.bots_notify_webhooks() from public, anon, authenticated;

create trigger messages_notify_bot_webhooks
  after insert on public.messages
  for each row execute function public.bots_notify_webhooks();
