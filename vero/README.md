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
supabase functions deploy media-upload media-download send-push cleanup-expired
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
