-- ============================================================================
-- Vero Messenger - payments (server side)
-- ============================================================================
-- UPI payments need NOTHING on the server: payment cards (amount, note, the
-- payee's UPI id, reference, status updates) travel only inside E2EE
-- messages, and the money moves inside the user's UPI app.
--
-- This migration only supports the OPTIONAL Razorpay Payment Links feature
-- (edge function `payment-link`), which is off unless the operator sets
-- RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET:
--   * payment_link_merchants: accounts allowed to create links. Links collect
--     money into the OPERATOR's Razorpay account, so this is an explicit
--     allow-list managed with the service role (SQL editor), not self-serve.
--   * payment_links: which link belongs to which creator (for status checks
--     and rate limiting). No amounts, notes, VPAs or conversation ids.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- APP CONFIG (identical, idempotent copy of 010 so this file applies on 001 alone)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.app_config (
  key        text primary key check (key ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  value      text not null check (char_length(value) <= 4096),
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;
revoke all on public.app_config from public, anon, authenticated;
grant select, insert, update, delete on public.app_config to service_role;

drop trigger if exists app_config_updated_at on public.app_config;
create trigger app_config_updated_at
  before update on public.app_config
  for each row execute function public.set_updated_at();

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
-- PAYMENT LINK MERCHANTS (who may create Razorpay links)
--   insert into public.payment_link_merchants (user_id) values ('<uuid>');
-- ─────────────────────────────────────────────────────────────────────────────

create table public.payment_link_merchants (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.payment_link_merchants enable row level security;

create policy "users see their own merchant flag"
  on public.payment_link_merchants for select to authenticated
  using (user_id = (select auth.uid()));

revoke insert, update, delete on public.payment_link_merchants from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- PAYMENT LINKS (rows written by the payment-link function, service role)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.payment_links (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid not null references auth.users (id) on delete cascade,
  provider         text not null default 'razorpay' check (provider in ('razorpay')),
  provider_link_id text not null unique check (char_length(provider_link_id) between 1 and 64),
  short_url        text not null check (short_url ~ '^https://' and char_length(short_url) <= 256),
  status           text not null default 'created'
                   check (status in ('created', 'partially_paid', 'paid', 'expired', 'cancelled')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index payment_links_creator_idx on public.payment_links (creator_id, created_at desc);

create trigger payment_links_updated_at
  before update on public.payment_links
  for each row execute function public.set_updated_at();

alter table public.payment_links enable row level security;

create policy "creators see their payment links"
  on public.payment_links for select to authenticated
  using (creator_id = (select auth.uid()));

revoke insert, update, delete on public.payment_links from anon, authenticated;
