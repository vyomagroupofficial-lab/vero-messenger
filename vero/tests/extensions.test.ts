import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sodiumModule from 'libsodium-wrappers';
import { generateIdentityKeyPair, encryptEnvelope, decryptEnvelope, parseEnvelope, Sodium, DecryptionError } from '../src/core/crypto/primitives';
import { parsePayload, serverTypeFor } from '../src/shared/models/payload';
import {
  extensionContent,
  extensionPayloadFromMessage,
  isControlPayload,
  MAX_BOT_DATA_BYTES,
} from '../src/shared/models/payloadExtensions';
import { openPayload, parseBotToken, parseCommand, sealPayload } from '../bots/sdk/envelope';
import {
  BRIDGE_CLIENT_JS,
  bridgeResponse,
  httpsOrigin,
  isAllowedNavigation,
  opaqueUserId,
  parseBridgeMessage,
  responseInjection,
} from '../src/features/bots/miniAppBridge';
import { isValidMiniAppUrl, matchCommands, parseBotCommands, parseCommandLines, validateBotUsername } from '../src/features/bots/validation';
import { STICKER_PACKS } from '../src/features/stickers/packs';

let sodium: Sodium;
before(async () => {
  await sodiumModule.ready;
  sodium = sodiumModule as unknown as Sodium;
});

const media = {
  mediaId: '33333333-3333-4333-8333-333333333333',
  objectId: 'sb:x.bin',
  key: 'k',
  nonce: 'n',
  hash: 'a'.repeat(64),
  mimeType: 'image/webp',
  size: 1234,
  width: 512,
  height: 512,
};

const card = {
  ref: 'VRO12345678901234567',
  kind: 'request',
  method: 'upi',
  amountPaise: 25000,
  currency: 'INR',
  note: 'Dinner',
  payeeVpa: 'alice@okicici',
  payeeName: 'Alice',
};

const roundTrip = (p: unknown) => JSON.parse(JSON.stringify(parsePayload(JSON.stringify(p))));

// ── Sticker / GIF / payment / bot payloads ───────────────────────────────────

test('sticker payloads: bundled reference and encrypted custom image', () => {
  const bundled = { t: 'sticker', ref: { pack: 'vero-faces', id: 'grin' }, emoji: '😀' };
  assert.deepEqual(roundTrip(bundled), bundled);
  const custom = { t: 'sticker', media, emoji: '🐱' };
  assert.deepEqual(roundTrip(custom), custom);
  assert.equal(serverTypeFor(parsePayload(JSON.stringify(bundled))!), 'media');
});

test('GIF payloads carry an encrypted MP4/GIF/WebP, never a provider URL', () => {
  const gif = { t: 'gif', media: { ...media, mimeType: 'video/mp4' }, title: 'party' };
  assert.deepEqual(roundTrip(gif), gif);
  const parsed = parsePayload(JSON.stringify({ ...gif, url: 'https://media.tenor.com/x.mp4' }));
  assert.equal((parsed as any).url, undefined, 'unknown fields (like a provider URL) are dropped');
  assert.equal(serverTypeFor(parsed!), 'media');
});

test('hostile sticker/GIF payloads are rejected', () => {
  for (const p of [
    { t: 'sticker' },
    { t: 'sticker', ref: { pack: '../../etc', id: 'passwd' } },
    { t: 'sticker', ref: { pack: 'vero-faces', id: 'GRIN' } },
    { t: 'sticker', ref: 'vero-faces/grin' },
    { t: 'sticker', media: { ...media, mimeType: 'application/x-msdownload' } },
    { t: 'sticker', media: { ...media, key: 42 } },
    { t: 'gif' },
    { t: 'gif', media: { ...media, mimeType: 'text/html' } },
    { t: 'gif', media: { ...media, size: -1 } },
  ]) {
    assert.equal(parsePayload(JSON.stringify(p)), null, JSON.stringify(p).slice(0, 80));
  }
});

test('custom sticker media cannot smuggle a localUri', () => {
  const parsed = parsePayload(JSON.stringify({ t: 'sticker', media: { ...media, localUri: 'file:///data/secret' } }));
  assert.ok(parsed && parsed.t === 'sticker');
  assert.equal((parsed.media as any).localUri, undefined);
});

test('payment cards round-trip and are hidden as plain text server-side', () => {
  const p = { t: 'payment', card };
  assert.deepEqual(roundTrip(p), p);
  assert.equal(serverTypeFor(parsePayload(JSON.stringify(p))!), 'text');
  const view = extensionContent(parsePayload(JSON.stringify(p))!);
  assert.equal(view.type, 'payment');
  assert.equal(view.content, '₹250 · Payment request');
  assert.deepEqual(view.ext, { t: 'payment', card, state: { status: 'pending' } });
});

test('invalid payment cards are rejected', () => {
  for (const c of [
    { ...card, amountPaise: 99 },
    { ...card, amountPaise: 10000001 },
    { ...card, amountPaise: 100.5 },
    { ...card, currency: 'USD' },
    { ...card, payeeVpa: 'alice@ok&am=1' },
    { ...card, payeeVpa: undefined },
    { ...card, ref: 'short' },
    { ...card, kind: 'steal' },
    { ...card, to: 'not a uuid!' },
    { ...card, method: 'link', payeeVpa: undefined, linkUrl: 'https://evil.example/pay' },
    { ...card, method: 'link', payeeVpa: undefined, linkUrl: 'http://rzp.io/i/abc' },
    { ...card, method: 'link', payeeVpa: undefined, linkUrl: 'https://rzp.io.evil.com/i/abc' },
  ]) {
    assert.equal(parsePayload(JSON.stringify({ t: 'payment', card: c })), null, JSON.stringify(c).slice(0, 100));
  }
  const link = { ...card, method: 'link', payeeVpa: undefined, linkUrl: 'https://rzp.io/i/AbC123', linkId: 'plink_X' };
  assert.ok(parsePayload(JSON.stringify({ t: 'payment', card: link })), 'Razorpay links are accepted');
});

test('payment status updates are control messages', () => {
  const s = { t: 'payment_status', target: '44444444-4444-4444-8444-444444444444', status: 'paid', txnRef: '412345678901' };
  const parsed = parsePayload(JSON.stringify(s))!;
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), s);
  assert.ok(isControlPayload(parsed));
  assert.equal(serverTypeFor(parsed), 'reaction');
  for (const bad of [
    { ...s, status: 'pending' },
    { ...s, status: 'refunded' },
    { ...s, target: 'x; drop table' },
    { ...s, txnRef: '<script>' },
  ]) {
    assert.equal(parsePayload(JSON.stringify(bad)), null, JSON.stringify(bad));
  }
});

test('bot_data must be JSON and at most 4 KB', () => {
  const ok = { t: 'bot_data', data: JSON.stringify({ choice: 'pizza' }) };
  assert.deepEqual(roundTrip(ok), ok);
  assert.equal(parsePayload(JSON.stringify({ t: 'bot_data', data: 'not json' })), null);
  assert.equal(parsePayload(JSON.stringify({ t: 'bot_data', data: JSON.stringify('é'.repeat(MAX_BOT_DATA_BYTES / 2)) })), null);
});

test('failed extension messages can be rebuilt for retry', () => {
  assert.deepEqual(extensionPayloadFromMessage({ ext: { t: 'sticker', ref: { pack: 'vero-faces', id: 'joy' }, emoji: '😂' } }), {
    t: 'sticker',
    ref: { pack: 'vero-faces', id: 'joy' },
    emoji: '😂',
  });
  assert.deepEqual(extensionPayloadFromMessage({ ext: { t: 'gif' }, media: { ...media, localUri: 'file:///x' } }), {
    t: 'gif',
    media,
    title: undefined,
  });
});

// ── Bundled stickers ─────────────────────────────────────────────────────────

test('every bundled sticker has an image and valid ids', () => {
  const assets = readFileSync(join(__dirname, '..', 'src', 'features', 'stickers', 'bundledAssets.ts'), 'utf8');
  assert.ok(STICKER_PACKS.length >= 2);
  for (const pack of STICKER_PACKS) {
    assert.ok(pack.stickers.length >= 16, pack.id);
    for (const s of pack.stickers) {
      assert.ok(assets.includes(`'${s.pack}/${s.id}': require('../../../assets/stickers/${s.pack}/${s.id}.webp')`), s.id);
      assert.ok(parsePayload(JSON.stringify({ t: 'sticker', ref: { pack: s.pack, id: s.id } })), `${s.id} is a valid reference`);
      const file = readFileSync(join(__dirname, '..', 'assets', 'stickers', s.pack, `${s.id}.webp`));
      assert.equal(file.subarray(8, 12).toString('ascii'), 'WEBP', `${s.id} is a WebP image`);
    }
  }
});

// ── Bot SDK envelope round trip ──────────────────────────────────────────────

test('user -> bot -> user: the bot decrypts with the app’s format and replies encrypted', () => {
  const conversationId = '55555555-5555-4555-8555-555555555555';
  const userPhone = generateIdentityKeyPair(sodium);
  const userLaptop = generateIdentityKeyPair(sodium);
  const bot = generateIdentityKeyPair(sodium);
  const devices = [
    { deviceId: 'user-phone', publicKey: userPhone.publicKey },
    { deviceId: 'user-laptop', publicKey: userLaptop.publicKey },
    { deviceId: 'bot-server', publicKey: bot.publicKey },
  ];

  // The app sends "/start" exactly as MessageRepository does.
  const inCtx = { conversationId, messageId: 'm-1', senderDeviceId: 'user-phone' };
  const env = encryptEnvelope(sodium, JSON.stringify({ t: 'text', body: '/start hello' }), inCtx, userPhone.secretKey, devices);
  const wire = JSON.stringify(env);
  assert.ok(!wire.includes('/start'));

  const received = openPayload(sodium, wire, inCtx, 'bot-server', bot.secretKey, userPhone.publicKey);
  assert.deepEqual(received, { t: 'text', body: '/start hello' });
  assert.deepEqual(parseCommand('/start hello'), { command: 'start', args: 'hello' });

  // The bot replies; every user device can read it.
  const outCtx = { conversationId, messageId: 'm-2', senderDeviceId: 'bot-server' };
  const sealed = sealPayload(sodium, { t: 'text', body: 'Hi! 👋' }, outCtx, bot.secretKey, devices);
  assert.equal(sealed.messageType, 'text');
  for (const [id, kp] of [['user-phone', userPhone], ['user-laptop', userLaptop]] as const) {
    const plain = decryptEnvelope(sodium, parseEnvelope(sealed.ciphertext), outCtx, id, kp.secretKey, bot.publicKey);
    assert.deepEqual(JSON.parse(plain), { t: 'text', body: 'Hi! 👋' });
  }

  // Mini-app data and stickers decode too.
  const dataCtx = { conversationId, messageId: 'm-3', senderDeviceId: 'user-phone' };
  const dataEnv = sealPayload(sodium, { t: 'bot_data', data: '{"choice":"pizza"}' }, dataCtx, userPhone.secretKey, devices);
  assert.deepEqual(openPayload(sodium, dataEnv.ciphertext, dataCtx, 'bot-server', bot.secretKey, userPhone.publicKey), {
    t: 'bot_data',
    data: '{"choice":"pizza"}',
  });
});

test('the bot rejects forged or replayed envelopes', () => {
  const user = generateIdentityKeyPair(sodium);
  const mallory = generateIdentityKeyPair(sodium);
  const bot = generateIdentityKeyPair(sodium);
  const devices = [{ deviceId: 'bot', publicKey: bot.publicKey }];
  const ctx = { conversationId: 'c', messageId: 'm', senderDeviceId: 'user' };
  const forged = sealPayload(sodium, { t: 'text', body: 'pay me' }, ctx, mallory.secretKey, devices);
  assert.throws(() => openPayload(sodium, forged.ciphertext, ctx, 'bot', bot.secretKey, user.publicKey), DecryptionError);
  const real = sealPayload(sodium, { t: 'text', body: 'hi' }, ctx, user.secretKey, devices);
  assert.throws(
    () => openPayload(sodium, real.ciphertext, { ...ctx, messageId: 'other' }, 'bot', bot.secretKey, user.publicKey),
    DecryptionError
  );
});

test('bot tokens and commands parse strictly', () => {
  const info = Buffer.from(JSON.stringify({ u: 'b0b0b0b0-0000-4000-8000-000000000005', e: 'echo_bot@bots.vero.invalid' })).toString('base64url');
  const parsed = parseBotToken(`vbot_${info}.${'s'.repeat(43)}`);
  assert.deepEqual(parsed, { userId: 'b0b0b0b0-0000-4000-8000-000000000005', email: 'echo_bot@bots.vero.invalid', password: 's'.repeat(43) });
  assert.throws(() => parseBotToken('vbot_nope'));
  assert.throws(() => parseBotToken(`xbot_${info}.${'s'.repeat(43)}`));

  assert.deepEqual(parseCommand('/Help'), { command: 'help', args: '' });
  assert.deepEqual(parseCommand('/remind@echo_bot 5m tea', 'echo_bot'), { command: 'remind', args: '5m tea' });
  assert.equal(parseCommand('/remind@other_bot 5m', 'echo_bot'), null);
  assert.equal(parseCommand('hello /start'), null);
});

// ── Bot validation & command menu ────────────────────────────────────────────

test('bot usernames, command lists and the / menu', () => {
  assert.equal(validateBotUsername('weather_bot'), null);
  assert.ok(validateBotUsername('weather'));
  assert.ok(validateBotUsername('Weather_bot'));
  const { commands, error } = parseCommandLines('/start - Say hi\nHELP: What I can do\nremind — later\n\n');
  assert.equal(error, null);
  assert.deepEqual(commands.map((c) => c.command), ['start', 'help', 'remind']);
  assert.ok(parseCommandLines('start\nstart').error);
  assert.ok(parseCommandLines('bad command name!').error);
  assert.deepEqual(
    parseBotCommands([{ command: 'ok', description: 'x' }, { command: 'Bad!' }, 'junk', { command: 'ok' }]),
    [{ command: 'ok', description: 'x' }]
  );
  assert.deepEqual(matchCommands('/re', commands).map((c) => c.command), ['remind']);
  assert.deepEqual(matchCommands('/', commands).length, 3);
  assert.deepEqual(matchCommands('/remind now', commands), []);
  assert.deepEqual(matchCommands('hello', commands), []);
});

// ── Mini-app bridge ──────────────────────────────────────────────────────────

test('bridge accepts only well-formed requests', () => {
  assert.deepEqual(parseBridgeMessage('{"vero":1,"id":"r1","method":"close"}'), { id: 'r1', method: 'close' });
  assert.deepEqual(parseBridgeMessage({ vero: 1, id: 'r2', method: 'getUser' }), { id: 'r2', method: 'getUser' });
  assert.deepEqual(parseBridgeMessage({ vero: 1, id: 'r3', method: 'sendData', data: { a: [1, 2] } }), {
    id: 'r3',
    method: 'sendData',
    data: '{"a":[1,2]}',
  });
  for (const bad of [
    'not json',
    null,
    42,
    { id: 'r1', method: 'close' },
    { vero: 2, id: 'r1', method: 'close' },
    { vero: 1, id: 'has spaces', method: 'close' },
    { vero: 1, id: 'x'.repeat(65), method: 'close' },
    { vero: 1, id: 'r1', method: 'getKeys' },
    { vero: 1, id: 'r1', method: 'eval', data: 'x' },
    { vero: 1, id: 'r1', method: 'sendData' },
    { vero: 1, id: 'r1', method: 'sendData', data: 'x'.repeat(MAX_BOT_DATA_BYTES + 1) },
    { vero: 1, id: 'r1', method: '__proto__' },
  ]) {
    assert.equal(parseBridgeMessage(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
  const cyclic: any = { vero: 1, id: 'r9', method: 'sendData', data: {} };
  cyclic.data.self = cyclic.data;
  assert.equal(parseBridgeMessage(cyclic), null);
});

test('mini-app navigation is locked to the registered https origin', () => {
  const app = 'https://app.example.com/mini?x=1';
  assert.equal(httpsOrigin(app), 'https://app.example.com');
  assert.ok(isAllowedNavigation('https://app.example.com/other#y', app));
  assert.ok(isAllowedNavigation('https://APP.example.com/', app));
  for (const bad of [
    'http://app.example.com/',
    'https://app.example.com.evil.com/',
    'https://evil.com/?https://app.example.com',
    'https://app.example.com:8443/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hi',
  ]) {
    assert.equal(isAllowedNavigation(bad, app), false, bad);
  }
  assert.ok(isValidMiniAppUrl('https://app.example.com/x'));
  for (const bad of ['http://a.com', 'https://127.0.0.1/', 'https://localhost/', 'https://a.com/ x', 'javascript:x']) {
    assert.equal(isValidMiniAppUrl(bad), false, bad);
  }
});

test('mini-apps get a stable, per-bot pseudonymous user id', () => {
  const a = opaqueUserId(sodium, 'user-1', 'bot-a');
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(opaqueUserId(sodium, 'user-1', 'bot-a'), a, 'stable');
  assert.notEqual(opaqueUserId(sodium, 'user-1', 'bot-b'), a, 'differs per bot');
  assert.notEqual(opaqueUserId(sodium, 'user-2', 'bot-a'), a, 'differs per user');
  assert.ok(!a.includes('user-1'));
});

test('bridge responses are safe JS literals and the client file is in sync', () => {
  const js = responseInjection(bridgeResponse('r1', { ok: true, result: { displayName: 'A </script>' } }));
  assert.ok(!js.includes(' '));
  assert.ok(js.startsWith('window.__veroBridge && window.__veroBridge.receive({'));
  const file = readFileSync(join(__dirname, '..', 'bots', 'miniapp', 'vero-miniapp.js'), 'utf8');
  assert.ok(file.includes(BRIDGE_CLIENT_JS), 'run: npx tsx scripts/write-miniapp-client.ts');
});
