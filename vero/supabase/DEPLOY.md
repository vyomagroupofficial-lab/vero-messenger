# Deploying Vero to a Supabase project

Every step below has been run against a full local Supabase stack
(`supabase start`), and the E2E suite (`npm run test:e2e`, 37 checks) passes
there. Nothing here needs the Supabase CLI's `secrets set`: all
configuration is plain SQL (Vault) or optional.

## 1. Migrations (in this order)

```
001_initial_schema        schema, RLS, RPCs, private realtime
002_calls                 1:1 + group calls, participants, TURN config
003_ratchet               signing keys, signed + one-time prekeys
004_media                 signed uploads, ready/pending media
005_settings_push_backup  settings, last seen, mute, push trigger, backups bucket
006_messaging             edit (control), delete window, forward, stars sync, pin/archive
007_groups_channels       group admin, invites, channels, communities
008_stories               encrypted 24h stories
009_discovery_linking     contact discovery, QR device linking, chat transfer
010_stickers_gifs         app_config, get_app_secret, GIF rate limit
011_payments              optional Razorpay payment links
012_bots                  bots and mini-apps
090_cross_feature_wiring  channel push, call push, scheduled blob cleanup
```

Before 001: `create extension if not exists pg_cron; create extension if not exists pg_net with schema extensions;`

On the live `vero` project, 001 is already applied **except**
`public.cleanup_expired_messages()` and its `cron.schedule`. Apply those from
001 first, then 002 onwards.

## 2. Vault secrets (SQL editor)

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'CRON_SECRET');
-- push_webhook_secret is created by 005; check:
select name from vault.secrets where name in ('project_url', 'push_webhook_secret', 'CRON_SECRET');
```

Optional (features show a clean "not configured" state without them):

| Feature | Vault secret name(s) |
|---|---|
| GIFs | `TENOR_API_KEY` or `GIPHY_API_KEY` |
| TURN (reliable calls on strict networks) | `vero_turn_cloudflare_key_id` + `vero_turn_cloudflare_api_token`, or `vero_turn_urls` + `vero_turn_username` + `vero_turn_credential` |
| Card/netbanking links | `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` |

## 3. Edge functions

| Function | verify_jwt |
|---|---|
| media-upload, media-download, turn-credentials, bot-admin, payment-link | true |
| send-push, cleanup-expired, stories-cleanup, device-link, gif-search | false (each checks its own secret or token) |

## 4. Dashboard settings

- **Realtime → Settings:** turn off "Allow public access" (private channels only).
- **Storage:** buckets `vero-media`, `vero-stories`, `vero-backups` and `vero-channel-media` are created by the migrations. Keep the global upload limit at 50 MB or higher.
- **Auth → Providers → Phone** (optional, for phone-number friend discovery): enable an SMS provider.

## 5. App configuration

- `.env`: `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
- Push: run `eas init` (sets `extra.eas.projectId`), then `eas credentials` for FCM/APNs.
- Calls, voice notes, app lock and native crypto need a **development build** (`npx expo run:android` / `run:ios` or EAS Build), not Expo Go.

## 6. Verify

```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon> npm run test:e2e
```

Without `DATABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, flows that need them are
skipped, and test users are created with email sign-up, so turn off email
confirmation for the run or confirm users manually. Finally run
`get_advisors` (security + performance) and check that only the documented
RPC warnings remain.
