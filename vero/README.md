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
    crypto/primitives.ts   Pure crypto: v2 envelopes, attachments, safety numbers (unit-tested)
    crypto/ratchet/        X3DH + Double Ratchet session layer, v3 envelopes (unit-tested)
    crypto/CryptoManager   Device identity/signing keys in the platform keystore
    crypto/sodium.ts       libsodium loader + native CSPRNG polyfill for Hermes
    storage/               Per-account SQLite (decrypted view) + secure key storage
    network/               Supabase client, private realtime channels
    session.ts             Current user/device for non-React code
  features/
    auth/                  Sign-up / sign-in, idempotent device registration
    keys/KeyDirectory      Device public keys with trust-on-first-use pinning
    keys/SessionService    Starts the session layer at sign-in, prekey upkeep, session resets
    messages/              Send/receive/decrypt, receipts, reactions, timers
    chats/                 Conversation list, directory, groups, blocks/reports
    media/                 Chunked encrypt -> signed upload, signed download -> decrypt; voice notes
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
2. The 32-byte content key is encrypted for **every active device of every
   member** (including the sender's other devices) through a per-device
   **Double Ratchet session** (envelope `v: 3`, see *Forward secrecy* below).
   Each slot is bound to `conversation|message|senderDevice`, so slots can't
   be replayed into another message.
3. The ciphertext is inserted into `messages`. A trigger checks that the device
   belongs to the sender and broadcasts the row on the private
   `conversation:<id>` channel, plus a tiny "inbox" ping to each member.
4. Recipients look up the sender device's identity key (pinned on first use;
   a changed key is rejected), decrypt, and store the plaintext in a per-account
   local SQLite database.

### Forward secrecy (X3DH + Double Ratchet)

Code: `src/core/crypto/ratchet/` (pure, unit-tested in `tests/ratchet.test.ts`),
`src/features/keys/SessionService.ts` (app wiring), schema in
`supabase/migrations/003_ratchet.sql` (tests: `supabase/tests/ratchet_test.sql`).

- **Keys.** Each device has its X25519 identity key plus an Ed25519 signing
  key that signs the identity key and the device's **signed prekey** (rotated
  weekly; old private halves kept 30 days for in-flight messages). Devices
  upload a pool of 100 **one-time prekeys** and top it up below 25.
  `claim_prekey_bundle()` hands out one one-time prekey per device atomically
  (`FOR UPDATE SKIP LOCKED`), only to people who share a conversation with
  the device's owner (this includes story contacts), and at most 1000 per
  caller per hour. An empty pool falls back to X3DH without a one-time prekey.
- **Sessions.** [X3DH](https://signal.org/docs/specifications/x3dh/) (X25519,
  HKDF-SHA-512) starts a session; the
  [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/)
  (no header encryption) gives every message a fresh key. Out-of-order and
  lost messages are handled with skipped message keys: at most 1000 per chain
  step and 1000 stored per session, each dropped after 30 days. Simultaneous
  first messages converge (old sessions are kept and tried).
- **Deviation from Signal.** libsodium has no XEdDSA, so the identity key is
  bound to a separate Ed25519 signing key by a signature *made by the signing
  key*. That signature doesn't prove possession of the identity key; the
  signing key is therefore pinned on first use and is part of the safety
  number (the QR fingerprint and *Verify safety number* cover identity AND
  signing keys). KDFs are HMAC/HKDF-SHA-512 built on libsodium's SHA-512
  (checked against Node's implementations).
- **Local state.** Sessions, prekey private keys and a plaintext cache live in
  the account's SQLite database (`vero_ratchet_kv`), every row sealed with
  XChaCha20-Poly1305 under a storage key kept in SecureStore; deleting the
  identity crypto-shreds them. Updates for one remote device are serialized
  by a mutex, and a decrypt commits the new session state, the consumed
  one-time prekey and the plaintext in one atomic statement.
- **Duplicates.** Realtime and history fetches can deliver the same message
  twice, and ratchet keys are single-use, so messages are de-duplicated by id
  *before* decrypting and answered from the plaintext cache. The cache follows
  the messages table (deleted and disappeared messages lose their copy too);
  story entries expire after 48 h.
- **Recovery.** If a message can't be decrypted because the session is gone or
  out of sync, it is shown as *"couldn't be decrypted: the secure session was
  out of sync and has been reset. Ask the sender to send it again."* The
  session is archived (the next message re-runs X3DH) and the sender's device
  gets an encrypted *session reset* control message (stored as a
  `reaction`-type row: no push, ignored by every other client). At most one
  reset per device per 10 minutes. In admins-only groups a non-admin can't
  post the reset there; the session is repaired by the next message to that
  device instead.
- **History and new devices.** A device can only read messages sent after it
  existed: earlier messages have no slot for it ("sent before this device was
  linked"). Linking by QR copies the last 200 messages per chat from the old
  device (see *QR codes ... linked devices* below). Re-downloading old history
  after clearing a chat doesn't work for v3 messages (their keys are gone);
  that is the price of forward secrecy.
- **Stories** use the same v3 envelope (split per recipient as before).
- **Bots** (`bots/sdk`) run the same session layer and keep it in their state
  file.

Group membership changes go through RPCs. A removed member's devices simply
stop getting key slots, so they can't read new messages.

### Attachments and voice notes

Code: `src/features/media/`, `src/core/crypto/attachments.ts`, functions
`media-upload` / `media-download`, schema `supabase/migrations/004_media.sql`
(tests: `supabase/tests/media_test.sql`, `tests/attachments.test.ts`,
`tests/media.test.ts`).

- **Encryption (format v2).** Every file gets a fresh key and is encrypted
  with libsodium's `crypto_secretstream_xchacha20poly1305` in 64 KiB chunks
  (each chunk authenticated with a counter-derived nonce, the last one tagged
  `FINAL`), reading and writing through expo-file-system `FileHandle`s so a
  50 MB video never sits in JS memory. Reordered, duplicated, truncated,
  appended or modified chunks fail to decrypt. Key, stream header, chunk size,
  BLAKE2b-256 of the ciphertext, MIME type, file name, dimensions, duration,
  the voice waveform and a ~48 px preview travel **only inside the E2EE
  message**. Old single-shot (v1) attachments still decrypt.
- **Upload.** `media-upload {action:"create"}` checks membership, the 50 MB
  cap (Supabase free plan, applied to the ciphertext) and rate limits, creates
  a *pending* `media` row and returns a signed upload URL for exactly
  `vero-media/<conversation>/<media>`. The app PUTs the ciphertext straight to
  Storage; `{action:"confirm"}` re-hashes the stored object and only then marks
  it `ready`. Messages can reference only ready media; unconfirmed uploads are
  swept after 6 hours. The bucket is private, 50 MB, `application/octet-stream`
  only, with no client storage policies.
- **Download.** `media-download?id=…&mode=url` returns a 2-minute signed URL
  after checking that the caller is a current member of the media's
  conversation; the app downloads natively to a temp file, verifies the hash
  and decrypts into a per-account cache (`<cache>/vero-media/<account>/`).
  The cache is cleared on logout and from *Settings → Clear media cache*
  (`clearMediaCache()`), and swept when messages are deleted or expire.
- **Voice notes.** Hold the mic to record, release to send; slide left to
  cancel; slide up, or just tap the mic, to lock (hands-free) and send with
  the button. Input metering is reduced to 64 peaks for the waveform. The
  player downloads on first play, supports drag-to-seek and 1x / 1.5x / 2x,
  and marks received notes as played (on this device only; no "played"
  receipt is sent to the sender).
- **Previews.** Photos and videos show the encrypted thumbnail blurred at the
  right aspect ratio until the real file is decrypted; photos up to 8 MB
  download automatically, videos and documents on tap. Videos play from the
  decrypted cache (expo-video); documents open in the share sheet under their
  real (sanitised) name.
- **Google Drive (optional).** With `VERO_MEDIA_BACKEND=drive` uploads go to a
  Drive resumable-upload session URL and downloads are proxied by
  `media-download` (Drive has no signed URLs). Drive upload sessions only
  accept requests from the origin that created them, so the Drive backend is
  for the native apps; the web build needs the default Storage backend.

### Stories (24-hour status)

Code: `src/features/stories/`, screens in `app/stories/`, schema in
`supabase/migrations/008_stories.sql`.

- The audience is resolved **on device** from the story privacy setting
  ("My contacts", "My contacts except…", "Only share with…"; contacts = people
  you share a direct chat with). The setting is kept locally and synced to your
  own `story_privacy` row.
- The story is encrypted once with the message envelope (`v: 3`), bound to
  `story:<author>|<storyId>|<authorDevice>`, and its key is ratchet-encrypted
  for every active device of the author and every audience member (the
  posting device keeps its own copy locally; viewers keep the decrypted story
  in the session layer's cache for 48 h, since its key can be used only once). The key slots are
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
- **Forward secrecy and post-compromise security for messages and stories**
  (X3DH + Double Ratchet per device pair, envelope `v: 3`). Compromising a
  device's long-term keys later does not reveal past messages whose keys were
  already deleted; a compromised session heals after the next DH ratchet step.
- Sender authentication and per-message binding
- Key pinning, safety numbers covering all of a user's devices (identity and
  signing keys), change detection
- RLS on every table, RPC-only membership changes, private realtime channels
- Push notifications contain no content ("New message")
- Disappearing messages (server-side hard delete plus local purge)

Limits of the forward secrecy we have (be precise):
- **Legacy `v: 2` messages** (sent before the upgrade) are still readable with
  the long-term device key and have no forward secrecy. The app no longer
  sends v2; devices that never publish prekeys (old app versions) don't get
  new messages at all, and a sender whose recipients all lack prekeys gets
  an error instead of a silent downgrade.
- **Plaintext at rest.** The local message database holds plaintext (as
  before); forward secrecy protects against later key compromise, not
  against someone who can read an unlocked phone's storage.
- **Groups** use pairwise sessions (one ratchet slot per member device), not
  MLS / sender keys: cost grows with the number of devices, and slots with a
  pending X3DH header are ~200 bytes, so very large groups (~1000+ devices)
  approach the 256 KiB message limit.
- **Attachments** are encrypted with a per-file key that travels inside the
  ratcheted message; the ciphertext blob stays on the server until the
  message is deleted or expires, so a leaked file key decrypts it.
- **Signing key binding** is TOFU (see above), and devices that registered
  before this change have their signing key published (and pinned by
  contacts) on first start of the new version, which changes safety numbers
  once.
- **Performance on Hermes.** Hermes has no WebAssembly, so libsodium runs as
  asm.js. Measured on V8 (JIT) the asm.js build needs ~5 ms per X25519 or
  Ed25519 operation (wasm: ~0.15 ms); Hermes interprets it and will be
  several times slower. Steady-state sends are symmetric-only (cheaper than
  v2's one `crypto_box` per device), but starting a session costs ~8 curve
  operations per device and each new ratchet chain ~3, so the first message
  to a large group or story audience can take seconds. Not yet measured on a
  real device; a native libsodium (JSI) binding is the fix if it's too slow.
- A malicious server can force a session reset by injecting messages with an
  unknown ratchet key (rate-limited to one per device per 10 minutes), and
  can withhold one-time prekeys (X3DH still works without them).

Not done yet (roadmap):
- **MLS / sender keys for large groups**, header encryption, and sealed sender
  (the server still sees which device sent each message).
- **Call media.** Signalling works (invite, ring, accept, decline, history);
  audio/video over WebRTC isn't wired up yet.
- Encrypted backups, encrypted group names/avatars, app lock.
- On-device testing of libsodium's asm.js fallback on Hermes for large files
  (chunked encryption keeps memory flat, but a 50 MB video takes several
  seconds on the JS thread).

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
