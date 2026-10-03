# Vero bots & mini-apps

Vero chats are end-to-end encrypted, so the server can't read messages for a
bot. A Vero bot is therefore a **normal Vero account that runs its own
device**: your bot process holds an X25519 identity key, decrypts what people
send it, and encrypts its replies for every device in the chat - exactly like
the app does.

```
user app ──E2EE──▶ Supabase (ciphertext only) ──realtime ping──▶ your bot process
   ▲                                                                 │
   └────────────────────────E2EE reply───────────────────────────────┘
```

What this means for users (shown in the app's bot directory): the **bot's
owner can read what you send the bot**, the same as any chat partner. Vero's
server still can't.

## 1. Create a bot

In the app: **Settings → Bots → My bots → Create a bot**. Pick a name and a
username ending in `bot`, optionally commands, a mini-app URL and whether the
bot is listed in the public directory. The app calls the `bot-admin` Edge
Function, which creates the bot's auth user (flagged `is_bot`) and shows you a
**token once**:

```
vbot_eyJ1Ijoi....<secret>
```

Treat it like a password. If it leaks, use **New token** in the app: the old
token stops working and the bot's registered devices are revoked, so a stolen
copy can neither read new messages nor send.

## 2. Run it

The SDK lives in `bots/sdk/` and reuses the app's own crypto
(`src/core/crypto/primitives.ts`) and payload schema
(`src/shared/models/payload.ts`). From the `vero/` directory:

```bash
npm ci
export VERO_SUPABASE_URL=https://<project>.supabase.co
export VERO_SUPABASE_ANON_KEY=<anon/publishable key>
export VERO_BOT_TOKEN=vbot_...
export VERO_BOT_STATE=/var/lib/vero-bot/echo.json   # private key + cursors; keep it!
npx tsx bots/examples/echo-bot.ts
```

Examples:

| File | What it does |
| --- | --- |
| `examples/echo-bot.ts` | Echoes text, reacts to stickers/GIFs, prints mini-app data |
| `examples/reminder-bot.ts` | `/remind 10m text`, `/reminders`, `/poll Q? \| A \| B`, `/vote 2`, `/results` |

Minimal bot:

```ts
import { botFromEnv } from './sdk';

const bot = botFromEnv();
bot.command('start', (ctx) => ctx.reply('Hello!'));
bot.onMessage((ctx) => ctx.message.text && ctx.reply(`You said: ${ctx.message.text}`));
bot.onData((ctx) => ctx.reply(`Mini-app sent ${JSON.stringify(ctx.message.data)}`));
bot
  .start()
  .then(() => bot.setProfile({ commands: [{ command: 'start', description: 'Say hello' }] }));
```

API summary (`bots/sdk/index.ts`):

- `new VeroBot({ supabaseUrl, anonKey, token, stateFile?, pollIntervalMs? })` / `botFromEnv()`
- `bot.command(name, handler)`, `bot.onMessage(handler)`, `bot.onData(handler)`
- `ctx.message` → `{ id, conversationId, senderUserId, payload, text?, command?, data? }`
- `ctx.reply(text)`, `bot.sendText(conversationId, text)`, `bot.sendPayload(conversationId, payload)`
- `bot.setProfile({ commands?, description?, miniAppUrl? })` - updates the `/` menu in the app
- `bot.start()`, `bot.stop()`

### Hosting notes

- Any always-on Node 20+ host works (a small VM, Fly.io, Railway, a Raspberry
  Pi). The process keeps a realtime WebSocket open and also polls every 60 s
  in case a ping was missed.
- **Persist the state file** (`VERO_BOT_STATE`, mode 0600). It holds the bot's
  identity and signing private keys, pinned device keys, and its
  forward-secrecy state: Double Ratchet sessions, prekey private keys and a
  short cache of decrypted messages. Losing it means the bot registers a new
  device and can't read messages encrypted to the old one. Restoring an OLD
  copy makes sessions fall out of sync; the SDK detects that and sends the
  affected devices an encrypted session reset (those messages are lost).
- Run one process per bot token. Two processes sharing a state file will
  answer twice and corrupt each other's ratchet sessions.
- Optional **webhook**: set a Webhook URL in the app (Edit bot). If the
  database has the `pg_net` extension, every new message in the bot's chats
  POSTs `{type, bot_user_id, conversation_id, message_id}` - ids only, never
  content - so a serverless bot can wake up, then fetch and decrypt the message
  with the SDK. Pings aren't signed; they're harmless because the bot only
  trusts what it can decrypt.
- Security model: the SDK pins every sender device key on first use (like the
  app) and refuses to send if a known device's key changes.
- Envelopes are the app's `v: 3` format (X3DH + Double Ratchet, see the main
  README's "Security status"); the bot publishes signed and one-time prekeys
  at start-up and tops them up hourly. Legacy `v: 2` messages are still read.
  `sealPayload` / `openPayload` remain exported for v2 tooling.

## 3. Mini-apps

A bot can attach an **https** mini-app URL. Users open it from the ⧉ button
in the bot chat; it opens in a sheet:

- **Mobile:** a WebView locked to the mini-app's origin (other links open in
  the system browser), incognito (no shared cookies), no file access, no
  popups.
- **Web/desktop:** a sandboxed cross-origin iframe; messages are accepted only
  from that iframe and that origin.

The page gets a tiny bridge, `window.Vero`:

| Call | Result |
| --- | --- |
| `Vero.close()` | Closes the sheet |
| `Vero.getUser()` | After the user agrees: `{ displayName, id }`. `id` is a pseudonymous hex id derived from (bot, user), different for every bot, never the Vero user id. Rejects if the user declines. |
| `Vero.sendData(json)` | Sends `json` (≤ 4 KB serialised) as an **end-to-end encrypted** message to the bot chat; your bot receives it in `bot.onData`. Rate-limited (1/s, 50 per open). |

The app injects the bridge on mobile. On web/desktop the page must include
the client itself (copy `bots/miniapp/vero-miniapp.js`, which is generated from
`src/features/bots/miniAppBridge.ts` by `scripts/write-miniapp-client.ts`):

```html
<script src="vero-miniapp.js"></script>
<button onclick="Vero.sendData({ choice: 'pizza' }).then(() => Vero.close())">Pizza</button>
```

The mini-app never gets keys, tokens, other chats or the user's account id.
Mini-app and webhook URLs must be `https://` with a real domain name (no IP
addresses or `localhost`); the database enforces this.

## 4. Server pieces

- Migration `supabase/migrations/012_bots.sql`: `bots` table (RLS + column
  grants: other users can't read the token hash or webhook URL),
  `profiles.is_bot` (set only by a trigger), `my_bots()`, optional `pg_net`
  webhook trigger. Tests: `supabase/tests/bots_test.sql`.
- Edge Function `supabase/functions/bot-admin`: `create`, `rotate`, `delete`
  (owner JWT) and `set_profile` (bot JWT). Up to 20 bots per owner.
- Optional setting `BOT_EMAIL_DOMAIN` (env / Vault / `app_config`) for the
  bots' internal sign-in addresses; default `bots.vero.invalid`. If your
  Supabase Auth rejects that domain, set it to a domain you control (no mail
  is ever sent to it).
