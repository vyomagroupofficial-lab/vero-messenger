# Vero Messenger

A privacy-first messenger built with **Expo / React Native** and **Supabase**.
Messages and attachments are encrypted on the device; the backend stores and
routes ciphertext only.

> **Principle:** the server can deliver your data, but it can't read it.

---

## Architecture

```
app/                     Expo Router screens (UI only)
src/
  core/
    crypto/primitives.ts   Pure crypto: envelopes, attachments, safety numbers (unit-tested)
    crypto/CryptoManager   Device identity keys in the platform keystore
    crypto/sodium.ts       libsodium loader + native CSPRNG polyfill for Hermes
    storage/               Per-account SQLite (decrypted view) + secure key storage
    network/               Supabase client, private realtime channels
    session.ts             Current user/device for non-React code
  features/
    auth/                  Sign-up / sign-in, idempotent device registration
    keys/KeyDirectory      Device public keys with trust-on-first-use pinning
    messages/              Send/receive/decrypt, receipts, reactions, timers
    chats/                 Conversation list, directory, groups, blocks/reports
    media/                 Encrypt -> upload, download -> decrypt
    calls/                 Call signalling (ringing/answer/history)
    notifications/         Expo push token registration
    demo/                  Offline demo account (isolated local DB)
supabase/
  migrations/              Schema, RLS, RPCs, realtime authorisation
  functions/               media-upload, media-download, send-push, cleanup-expired
  tests/                   RLS / RPC tests (run against plain PostgreSQL)
tests/                     Unit tests (crypto, payload parsing, receipts)
```

### Message flow

1. The sender builds a payload (`text`, `media`, `reaction`, `timer`) and
   encrypts it **once** with a random content key (XChaCha20-Poly1305).
2. The content key is wrapped with `crypto_box` (X25519) for **every active
   device of every member**, including the sender's other devices. Each slot
   is bound to `conversation|message|senderDevice`, so slots can't be replayed.
3. The ciphertext is inserted into `messages`. A trigger checks that the device
   belongs to the sender and broadcasts the row on the private
   `conversation:<id>` channel, plus a tiny "inbox" ping to each member.
4. Recipients look up the sender device's public key (pinned on first use;
   a changed key is rejected), decrypt, and store the plaintext in a per-account
   local SQLite database.

Group membership changes go through RPCs. A removed member's devices simply
stop getting key slots, so they can't read new messages.

### Attachments

Files are encrypted on device with a fresh key; the key travels only inside the
E2EE message. The `media-upload` function stores the ciphertext in a private
Supabase Storage bucket (default) or a Google Drive Shared Drive folder.
`media-download` is a membership-checked proxy; the client verifies the hash
and decrypts.

### Stories (24-hour status)

Code: `src/features/stories/`, screens in `app/stories/`, schema in
`supabase/migrations/008_stories.sql`.

- The audience is resolved **on device** from the story privacy setting
  ("My contacts", "My contacts except…", "Only share with…"; contacts = people
  you share a direct chat with). The setting is kept locally and synced to your
  own `story_privacy` row.
- The story is encrypted once with the message envelope, bound to
  `story:<author>|<storyId>|<authorDevice>`, and its key is wrapped for every
  active device of the author and every audience member. The key slots are
  stored per recipient (`story_recipients`), so each person downloads only their
  own slots. Photos/videos (≤ 30 s) are encrypted on device and stored in the
  private `vero-stories` bucket; storage policies allow downloads only to the
  story's audience.
- RLS hides stories from everyone but the author and recipients, and from
  everyone once they expire (24 h). View receipts (`story_views`) are visible
  only to the author and are not sent when read receipts are off. Replies and
  emoji reactions are ordinary E2EE direct messages quoting the story.
- `cleanup_expired_stories()` hard-deletes expired stories (pg_cron every
  10 min when enabled) and flags their blobs; deploy and schedule the
  `stories-cleanup` function (`Authorization: Bearer <CRON_SECRET>`) to remove
  the flagged blobs from Storage.

### What the server can and cannot see

| Server can see | Server cannot see |
| --- | --- |
| Who is in which conversation, when messages are sent, coarse type (`text`/`media`/`reaction`/`system`) | Message text, captions, reactions, file names, real file types |
| Profiles (username, display name, about), group names | Attachment contents or keys |
| Device public keys, push tokens | Private keys (they never leave the device keystore) |

## Groups, invite links, channels and communities

Server side lives in `supabase/migrations/007_groups_channels.sql` (tests:
`supabase/tests/groups_channels_test.sql`); client code in
`src/features/{groups,channels,communities}`.

- **Group admin tools** (`app/group/[id].tsx`): description, photo, roles
  (admins promote; only the owner dismisses admins; ownership transfer), and
  three settings enforced server-side: *only admins can send* (a BEFORE INSERT
  trigger on `messages`), *only admins can edit group info*, *approve new
  members*. Membership/role/info changes are logged by triggers into
  `group_events` and rendered as system lines in the chat (live over the
  private `group:<id>` topic). Leaving as owner hands the group to the
  longest-serving admin; deleting a group wipes its ciphertext and queues its
  attachment blobs for cleanup.
- **Invite links**: random 43-character tokens with optional expiry, max uses
  and admin approval; admins can reset them. Anyone signed in can preview a
  link (name, photo, member count) and join; failed guesses count toward a
  per-user rate limit (60 previews / 10 min, 10 joins / hour).
- **Channels** (`app/channels/*`): one-to-many broadcast with public
  (searchable) or private (invite-link) visibility, admins, follower counts,
  mute and emoji reaction counts. **Channel posts are not end-to-end
  encrypted** - per-device key fan-out doesn't scale to thousands of
  followers, so, like WhatsApp Channels, the server can read them; the app
  says so on every channel screen. Followers are visible only to themselves,
  admins only to other admins, and post authors aren't exposed. Images go to
  the private `vero-channel-media` bucket behind storage policies.
- **Communities** (`app/communities/*`): link groups you admin, create groups
  inside a community, and an E2EE announcements group where only admins post.
  Joining any linked group (or the announcements group via a link) makes you a
  member; community members can join open groups or request to join groups
  that need approval.

**Server-visible metadata (trade-off):** group / channel / community names,
descriptions and photos are stored in plain form so invite previews and
directories work. Photos are small (256 px JPEG, <= ~96 KB) data URIs in the
row, shown to members and to anyone holding an invite link. Messages and
attachments in groups and communities remain end-to-end encrypted.

### Invite links

Links look like `vero://join/<token>`. To share `https://<host>/join/<token>`
links instead (they open the app if installed, or the web build otherwise):

1. Set `EXPO_PUBLIC_INVITE_HOST=<host>` in `.env` and rebuild the app;
   `app.config.js` then adds the iOS associated domain and the Android App
   Link intent filter for `/join/*` and `/channels/*`.
2. On that host, serve `/.well-known/apple-app-site-association` (appID
   `<TEAMID>.com.vero.messenger`, paths `/join/*`, `/channels/*`) and
   `/.well-known/assetlinks.json` (package `com.vero.messenger` + your signing
   certificate SHA-256).
3. Optionally deploy the web export (`npx expo export --platform web`) there
   with an SPA fallback so `/join/<token>` renders the join screen in a browser.

## Security status (be honest with users)

Done:
- E2EE for messages and attachments, multi-device, groups
- Sender authentication and per-message binding
- Key pinning, safety numbers covering all of a user's devices, change detection
- RLS on every table, RPC-only membership changes, private realtime channels
- Push notifications contain no content ("New message")
- Disappearing messages (server-side hard delete plus local purge)

Not done yet (roadmap):
- **Forward secrecy / post-compromise security.** Envelopes use long-term
  device keys. The next step is a ratcheting session layer (Signal's Double
  Ratchet for 1:1, MLS for groups). The envelope format is versioned (`v: 2`)
  so it can be upgraded.
- **Call media.** Signalling works (invite, ring, accept, decline, history);
  audio/video over WebRTC isn't wired up yet.
- Voice notes, encrypted backups, encrypted group names/avatars, app lock.
- On-device testing of libsodium's asm.js fallback on Hermes for large files.

## Setup

### 1. Backend (Supabase)

```bash
supabase link --project-ref <your-project>
supabase db push                     # applies supabase/migrations
supabase functions deploy media-upload media-download send-push cleanup-expired device-link
supabase secrets set PUSH_WEBHOOK_SECRET=$(openssl rand -hex 32) CRON_SECRET=$(openssl rand -hex 32)
```

Then, in the dashboard:
- **Database → Webhooks:** on `public.messages` INSERT, call the `send-push`
  function with the header `x-webhook-secret: <PUSH_WEBHOOK_SECRET>`.
- **Database → Extensions:** enable `pg_cron` (expired-message cleanup runs every
  5 min), and schedule `cleanup-expired` with `Authorization: Bearer <CRON_SECRET>`
  to delete expired attachment blobs.
- Optional Google Drive storage: see `.env.example`. A service account has no
  storage quota of its own, so the folder must be inside a **Shared Drive**
  that the service account is a member of.

### Stickers, GIFs, payments, bots (optional configuration)

```bash
supabase functions deploy gif-search payment-link bot-admin
```

| Feature | Needs | Without it |
| --- | --- | --- |
| Stickers (2 bundled packs, recents, favourites, photo → sticker) | nothing | - |
| GIF search (`gif-search`) | `TENOR_API_KEY` (Tenor v2) **or** `GIPHY_API_KEY`; `GIF_PROVIDER=giphy` if both | GIF tab says "GIFs aren't set up yet" |
| UPI payments (request / pay / QR) | nothing (standard `upi://pay` links) | - |
| Card / netbanking links (`payment-link`) | `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`, and allow-listed users in `payment_link_merchants` | option hidden |
| Bots (`bot-admin`) | nothing; optional `BOT_EMAIL_DOMAIN`; `pg_net` for webhook pings | bots use realtime only |

Keys can be Edge Function secrets (`supabase secrets set TENOR_API_KEY=...`),
Vault secrets with the same name, or rows in `public.app_config`
(`insert into app_config (key, value) values ('TENOR_API_KEY', '...')`); only
the service role can read them (`get_app_secret`). Razorpay links collect into
the operator's Razorpay account, so they are enabled per account:
`insert into payment_link_merchants (user_id) values ('<uuid>')`.

Privacy notes: bundled stickers are sent as an encrypted pack/id reference;
custom stickers and GIFs are re-encrypted on device and uploaded like photos
(the recipient never gets the GIF provider URL, and searches/previews go
through the `gif-search` proxy). Payment cards and their status updates are
E2EE messages; UPI ids are stored only in the device keystore. Vero can't see
UPI transactions, so "paid" means a member reported it. Bot SDK, examples and
mini-app docs: [`bots/README.md`](bots/README.md).

### 2. App

```bash
cp .env.example .env        # fill in EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY
npm install
npm start                   # Expo dev server
```

Without a `.env`, the app still runs, but only the **offline demo** is
available. The demo has its own local database and never talks to the backend.

Push notifications need an EAS project id (`extra.eas.projectId`) and a
development build.

## Checks

```bash
npm run typecheck           # TypeScript
npm test                    # crypto + payload + receipt unit tests
./scripts/test-db.sh        # schema/RLS/RPC tests (needs a local PostgreSQL; PGHOST/PGPORT/PGUSER)
(cd supabase/functions && npx deno check --no-lock */index.ts)
```

## QR codes, contact discovery, linked devices, desktop

Code: `src/features/{discovery,linking,transfer}`, screens under `app/qr`,
`app/u/[username]`, `app/discovery`, `app/devices`, `app/(auth)/qr-login`,
schema in `supabase/migrations/009_discovery_linking.sql`, Edge Function
`supabase/functions/device-link`, desktop shell in `desktop/`.

**Add by QR.** *Contacts → QR icon* shows `vero://u/<username>?fp=<fingerprint>`
(30-digit fingerprint of all your device keys). Scanning it opens the profile;
starting the chat compares the fingerprint with the keys the server serves and,
if they match, marks the safety number verified (`verifyContactFromQr`). With
`EXPO_PUBLIC_WEB_URL` set, share links are `https://<host>/u/<username>`.

**Find friends from contacts (opt-in, k-anonymous).** *Settings → Who can find
me* lists a SHA-256 hash of your **verified** email and/or phone
(`discovery_identifiers`, written only by SECURITY DEFINER functions). The
finder normalises the address book on the device (E.164, default country India;
lower-cased emails), hashes it, and sends only 4-hex-char prefixes to
`discovery_lookup()`; matches are made on the device. Lookups are limited to
30 requests / 5,000 prefixes per user per day. Phone hashes are brute-forceable
by anyone who collects them, hence opt-in and rate limits.
Phone verification uses `supabase.auth.updateUser({ phone })` + `verifyOtp`
(`phone_change`) and needs **Auth → Providers → Phone** with an SMS provider
(Twilio, MessageBird, Vonage, …). Until then only email discovery works.

**Link web / desktop by QR.** The signed-out device shows
`vero-link:<id>:<secret>:<ephemeralPub>`; the server stores only
`sha256(claimKey)`, where `claimKey = BLAKE2b(secret, "vero-link/claim/v1")`.
A signed-in phone scans and approves (*Settings → Devices & transfer*); the
`device-link` function checks its JWT. The first poll that presents the claim
key gets a one-time magic-link `hashed_token` (`auth.admin.generateLink`), which
the new device exchanges with `verifyOtp({ token_hash, type: 'magiclink' })`.
It then registers **its own** device keys. Requests are single-use and expire
after 2 minutes. No password or private key leaves the phone. Because the token
hash is used directly, no Site URL / redirect URL is involved, but Auth's
email OTP expiry applies and the account needs an email address.
The phone then sends its recent 200 messages per chat (see below).

**Move chats to a new phone.** On the new phone, *Devices & transfer → Receive
chats* shows `vero-transfer:<id>:<secret>:<ephemeralPub>`; the old phone scans
it and uploads its local database (messages, chat cache, timers, call log,
pinned contact keys, preferences). Private keys and session state are never
included. Encryption: `key = BLAKE2b(key = QR secret, id || R_pk || S_pk ||
X25519(eph))`, XChaCha20-Poly1305 per 192 KiB chunk with
`id|index|total` as associated data. The server relays the sender's ephemeral
key but never sees the QR secret, so it can neither read nor forge the
transfer. Chunks live in `device_transfer_chunks` (account-only RLS) and are
deleted on import or after 1 hour. Downloads resume after an app restart.

**Desktop and PWA.** The web export is installable (`public/manifest.webmanifest`,
icons, `public/index.html` template). `desktop/` is an Electron shell that serves
the export from `app://vero` with a strict CSP, contextIsolation, sandbox, no Node
in the renderer, single instance and `vero://` deep links:

```bash
cd desktop && npm install          # separate from the app's dependencies
npm run dev                        # export web build to ../dist and start Electron
npm run build:linux                # or build:win / build:mac (sign on that OS)
# from the app folder: npm run desktop:dev / npm run desktop:build
```

Self-hosted Supabase on a custom domain: set `VERO_CSP_CONNECT="https://api.example.com wss://api.example.com"`
when you start the desktop app. Deploy: `supabase functions deploy device-link` (it is
`verify_jwt = false` in `config.toml` because signed-out devices call it).
