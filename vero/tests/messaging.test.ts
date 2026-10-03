import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePayload, serverTypeFor, MAX_TEXT_LENGTH } from '../src/shared/models/payload';
import { parseForwardHops } from '../src/shared/models/messageExtras';
import type { Conversation, Message } from '../src/shared/models/Message';
import {
  canEditMessage,
  EDIT_RECEIVE_GRACE_MS,
  EDIT_WINDOW_MS,
  editHistory,
  isIncomingEditValid,
  isNewerEdit,
  normalizeEditText,
} from '../src/features/messages/edits';
import {
  buildForwardPayload,
  checkForwardSelection,
  forwardLabel,
  FREQUENTLY_FORWARDED_HOPS,
  isForwardable,
  isFrequentlyForwarded,
  MAX_FORWARD_CHATS,
  maxForwardTargets,
  nextHopCount,
} from '../src/features/messages/forward';
import { canDeleteForEveryone, DELETE_FOR_EVERYONE_WINDOW_MS } from '../src/features/messages/deletion';
import {
  chunkStarItems,
  MAX_STAR_ITEMS,
  parseSelfSyncPayload,
  shouldApplyStar,
} from '../src/features/messages/selfSyncPayload';
import {
  buildFtsQuery,
  buildLikePatterns,
  escapeLike,
  highlightSegments,
  isSearchable,
  makeSnippet,
  stepResult,
  tokenize,
} from '../src/features/search/searchQuery';
import {
  canPin,
  computeUnreadCount,
  countsAsUnread,
  isMuted,
  PINNED_LIMIT,
  previewBody,
  previewLine,
  shouldAutoUnarchive,
  sortConversations,
  splitArchived,
  totalUnread,
} from '../src/features/chats/chatList';
import { compareDesc, isAfter, toIso, toMillis } from '../src/shared/utils/time';

const T0 = Date.parse('2026-05-01T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    senderDeviceId: 'd1',
    senderUserId: 'me',
    messageType: 'text',
    content: 'hello',
    createdAt: iso(T0),
    status: 'sent',
    isOwn: true,
    ...over,
  };
}

const media = {
  mediaId: 'media-1',
  objectId: 'sb:x.bin',
  key: 'k',
  nonce: 'n',
  hash: 'a'.repeat(64),
  mimeType: 'image/jpeg',
  size: 10,
};

// ── control / payload parsing ───────────────────────────────────────────────

test('edit payload round-trips and maps to the coarse control type', () => {
  const p = { t: 'edit', targetId: 'abc-1', newText: 'fixed', editedAt: '2026-05-01T12:03:00.000Z' } as const;
  assert.deepEqual(parsePayload(JSON.stringify(p)), p);
  assert.equal(serverTypeFor(p), 'control');
  // Server timestamp format is accepted too.
  assert.ok(parsePayload(JSON.stringify({ ...p, editedAt: '2026-05-01T12:03:00.123456+00:00' })));
});

test('hostile edit payloads are rejected', () => {
  const ok = { t: 'edit', targetId: 'abc', newText: 'x', editedAt: '2026-05-01T12:03:00Z' };
  for (const bad of [
    { ...ok, targetId: '' },
    { ...ok, targetId: 'x'.repeat(65) },
    { ...ok, targetId: 5 },
    { ...ok, newText: 'x'.repeat(MAX_TEXT_LENGTH + 1) },
    { ...ok, newText: null },
    { ...ok, editedAt: 'yesterday' },
    { ...ok, editedAt: 0 },
  ]) {
    assert.equal(parsePayload(JSON.stringify(bad)), null, JSON.stringify(bad).slice(0, 80));
  }
});

test('forward hop counts are parsed defensively', () => {
  assert.equal(parseForwardHops(1), 1);
  assert.equal(parseForwardHops(1000), 1000);
  for (const v of [0, -1, 1.5, 1001, '3', null, undefined, NaN, Infinity]) assert.equal(parseForwardHops(v), undefined);
  assert.deepEqual(parsePayload(JSON.stringify({ t: 'text', body: 'hi', fwd: 3 })), { t: 'text', body: 'hi', fwd: 3 });
  assert.deepEqual(parsePayload(JSON.stringify({ t: 'text', body: 'hi', fwd: 'lots' })), { t: 'text', body: 'hi' });
  const m = parsePayload(JSON.stringify({ t: 'media', kind: 'image', media, fwd: 2 }));
  assert.ok(m && m.t === 'media' && m.fwd === 2);
  const plain = parsePayload(JSON.stringify({ t: 'media', kind: 'image', media }));
  assert.ok(plain && plain.t === 'media' && !('fwd' in plain));
});

test('self-sync star payloads are validated', () => {
  const item = { id: 'm-1', c: 'c-1', s: true, at: '2026-05-01T12:00:00.000Z' };
  assert.deepEqual(parseSelfSyncPayload(JSON.stringify({ t: 'stars', items: [item] })), { t: 'stars', items: [item] });
  for (const bad of [
    'nope',
    JSON.stringify({ t: 'stars', items: [] }),
    JSON.stringify({ t: 'stars', items: [{ ...item, s: 'yes' }] }),
    JSON.stringify({ t: 'stars', items: [{ ...item, id: 'bad id;' }] }),
    JSON.stringify({ t: 'stars', items: [{ ...item, at: 'later' }] }),
    JSON.stringify({ t: 'stars', items: new Array(MAX_STAR_ITEMS + 1).fill(item) }),
    JSON.stringify({ t: 'unknown', items: [item] }),
  ]) {
    assert.equal(parseSelfSyncPayload(bad), null, bad.slice(0, 60));
  }
  // extra fields are dropped
  const parsed = parseSelfSyncPayload(JSON.stringify({ t: 'stars', items: [{ ...item, body: 'secret' }] }));
  assert.equal((parsed!.items[0] as any).body, undefined);
});

test('stars merge last-writer-wins and chunk large changes', () => {
  assert.equal(shouldApplyStar(null, '2026-05-01T12:00:00Z'), true);
  assert.equal(shouldApplyStar('2026-05-01T12:00:00Z', '2026-05-01T12:00:01Z'), true);
  assert.equal(shouldApplyStar('2026-05-01T12:00:01Z', '2026-05-01T12:00:00Z'), false);
  assert.equal(shouldApplyStar('2026-05-01T12:00:00Z', '2026-05-01T12:00:00Z'), false);
  const items = Array.from({ length: MAX_STAR_ITEMS * 2 + 1 }, (_, i) => ({ id: `m${i}`, c: 'c', s: true, at: iso(T0) }));
  const chunks = chunkStarItems(items);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.reduce((n, c) => n + c.items.length, 0), items.length);
});

// ── edits ───────────────────────────────────────────────────────────────────

test('only own, sent, recent text/photo/video messages can be edited', () => {
  assert.equal(canEditMessage(msg(), 'me', T0 + 60_000).ok, true);
  assert.equal(canEditMessage(msg(), 'me', T0 + EDIT_WINDOW_MS).ok, true);
  assert.equal(canEditMessage(msg(), 'me', T0 + EDIT_WINDOW_MS + 1).ok, false);
  assert.equal(canEditMessage(msg({ isOwn: false, senderUserId: 'bob' }), 'me', T0).ok, false);
  assert.equal(canEditMessage(msg({ status: 'sending' }), 'me', T0).ok, false);
  assert.equal(canEditMessage(msg({ status: 'failed' }), 'me', T0).ok, false);
  assert.equal(canEditMessage(msg({ revokedAt: iso(T0) }), 'me', T0).ok, false);
  assert.equal(canEditMessage(msg({ messageType: 'image', media }), 'me', T0).ok, true);
  assert.equal(canEditMessage(msg({ messageType: 'voice', media }), 'me', T0).ok, false);
  assert.equal(canEditMessage(msg({ messageType: 'system' }), 'me', T0).ok, false);
  // server timestamp format
  assert.equal(canEditMessage(msg({ createdAt: '2026-05-01T12:00:00.123456+00:00' }), 'me', T0 + 1000).ok, true);
});

test('edit text normalisation', () => {
  assert.equal(normalizeEditText(msg(), '  hello there  '), 'hello there');
  assert.equal(normalizeEditText(msg(), 'hello'), null); // unchanged
  assert.equal(normalizeEditText(msg(), '   '), null); // empty text message
  assert.equal(normalizeEditText(msg({ messageType: 'image', content: 'cap' }), ''), ''); // caption removed
  assert.equal(normalizeEditText(msg(), 'x'.repeat(MAX_TEXT_LENGTH + 1)), null);
});

test('received edits apply only from the original sender, same chat, within the window', () => {
  const target = msg({ isOwn: false, senderUserId: 'bob' });
  const edit = { conversationId: 'c1', senderUserId: 'bob', createdAt: iso(T0 + 5 * 60_000) };
  assert.equal(isIncomingEditValid(target, edit), true);
  assert.equal(isIncomingEditValid(target, { ...edit, senderUserId: 'mallory' }), false);
  assert.equal(isIncomingEditValid(target, { ...edit, conversationId: 'c2' }), false);
  assert.equal(isIncomingEditValid(target, { ...edit, createdAt: iso(T0 + EDIT_WINDOW_MS + EDIT_RECEIVE_GRACE_MS) }), true);
  assert.equal(isIncomingEditValid(target, { ...edit, createdAt: iso(T0 + EDIT_WINDOW_MS + EDIT_RECEIVE_GRACE_MS + 1) }), false);
  assert.equal(isIncomingEditValid(target, { ...edit, createdAt: iso(T0 - 1000) }), false);
  assert.equal(isIncomingEditValid({ ...target, revokedAt: iso(T0) }, edit), false);
  assert.equal(isIncomingEditValid({ ...target, messageType: 'document' }, edit), false);
  assert.equal(isIncomingEditValid({ ...target, messageType: 'unavailable' }, edit), false);
  // own edit from my other device
  assert.equal(isIncomingEditValid(msg(), { ...edit, senderUserId: 'me' }), true);
});

test('edits are last-writer-wins by server time, history lists versions', () => {
  assert.equal(isNewerEdit(null, iso(T0)), true);
  assert.equal(isNewerEdit(iso(T0), iso(T0 + 1)), true);
  assert.equal(isNewerEdit(iso(T0 + 1), iso(T0)), false);
  assert.equal(isNewerEdit('2026-05-01T12:00:00.500Z', '2026-05-01T12:00:00.4999+00:00'), false);

  const h = editHistory('v3', iso(T0), [
    { previousText: 'v2', newText: 'v3', editedAt: iso(T0 + 2000) },
    { previousText: 'v1', newText: 'v2', editedAt: iso(T0 + 1000) },
  ]);
  assert.deepEqual(h.map((e) => e.text), ['v1', 'v2', 'v3']);
  assert.deepEqual(editHistory('only', iso(T0), []), [{ text: 'only', at: iso(T0) }]);
});

// ── delete for everyone ────────────────────────────────────────────────────

test('delete for everyone: own, sent, within 48 hours', () => {
  assert.equal(canDeleteForEveryone(msg(), 'me', T0 + DELETE_FOR_EVERYONE_WINDOW_MS), true);
  assert.equal(canDeleteForEveryone(msg(), 'me', T0 + DELETE_FOR_EVERYONE_WINDOW_MS + 1), false);
  assert.equal(canDeleteForEveryone(msg({ isOwn: false, senderUserId: 'bob' }), 'me', T0), false);
  assert.equal(canDeleteForEveryone(msg({ status: 'failed' }), 'me', T0), false);
  assert.equal(canDeleteForEveryone(msg({ revokedAt: iso(T0) }), 'me', T0), false);
});

// ── forwarding ──────────────────────────────────────────────────────────────

test('forward hop counting and labels', () => {
  assert.equal(nextHopCount(msg()), 1);
  assert.equal(nextHopCount(msg({ forwardCount: 4 })), 5);
  assert.equal(nextHopCount(msg({ forwardCount: 1000 })), 1000);
  assert.equal(forwardLabel(undefined), null);
  assert.equal(forwardLabel(0), null);
  assert.equal(forwardLabel(1), 'Forwarded');
  assert.equal(forwardLabel(FREQUENTLY_FORWARDED_HOPS - 1), 'Forwarded');
  assert.equal(forwardLabel(FREQUENTLY_FORWARDED_HOPS), 'Forwarded many times');
  assert.equal(isFrequentlyForwarded(FREQUENTLY_FORWARDED_HOPS), true);
});

test('forward payloads reuse the file key with the target chat media id', () => {
  const text = buildForwardPayload(msg({ forwardCount: 2 }));
  assert.deepEqual(text, { t: 'text', body: 'hello', fwd: 3 });

  const photo = msg({ messageType: 'image', content: 'sunset', media: { ...media, localUri: 'file:///private.jpg' } });
  const p = buildForwardPayload(photo, 'media-2');
  assert.ok(p && p.t === 'media');
  assert.equal(p.media.mediaId, 'media-2');
  assert.equal(p.media.key, media.key);
  assert.equal(p.caption, 'sunset');
  assert.equal(p.fwd, 1);
  assert.equal((p.media as any).localUri, undefined, 'device-local paths never leave the device');
  assert.equal(buildForwardPayload(photo), null, 'media needs an authorised media row in the target chat');

  const doc = buildForwardPayload(msg({ messageType: 'document', content: 'report.pdf', media }), 'media-3');
  assert.ok(doc && doc.t === 'media' && doc.caption === undefined);

  assert.equal(buildForwardPayload(msg({ revokedAt: iso(T0) })), null);
  assert.equal(buildForwardPayload(msg({ messageType: 'system' })), null);
  assert.equal(buildForwardPayload(msg({ messageType: 'unavailable' })), null);
  assert.equal(isForwardable(msg({ status: 'failed' })), false);
});

test('forward limits: 5 chats, 1 chat for frequently forwarded messages', () => {
  const normal = [msg()];
  const frequent = [msg({ forwardCount: FREQUENTLY_FORWARDED_HOPS - 1 })];
  assert.equal(maxForwardTargets(normal), MAX_FORWARD_CHATS);
  assert.equal(maxForwardTargets(frequent), 1);
  assert.equal(maxForwardTargets([...normal, ...frequent]), 1);
  assert.equal(checkForwardSelection(normal, 5).ok, true);
  assert.equal(checkForwardSelection(normal, 6).ok, false);
  assert.equal(checkForwardSelection(frequent, 2).ok, false);
  assert.equal(checkForwardSelection(normal, 0).ok, false);
  assert.equal(checkForwardSelection([], 1).ok, false);
  assert.equal(checkForwardSelection([msg({ revokedAt: iso(T0) })], 1).ok, false);
});

// ── search ──────────────────────────────────────────────────────────────────

test('FTS queries quote every term so user input is never syntax', () => {
  assert.equal(buildFtsQuery('hello world'), '"hello"* "world"*');
  assert.equal(buildFtsQuery('Hello, WORLD!'), '"hello"* "world"*');
  assert.equal(buildFtsQuery('a'), null);
  assert.equal(buildFtsQuery('   '), null);
  assert.equal(buildFtsQuery('!!'), null);
  // Operators, column filters, NEAR, quotes and stars become plain terms.
  assert.equal(buildFtsQuery('content:secret OR NOT x*'), '"content"* "secret"* "or"* "not"* "x"*');
  assert.equal(buildFtsQuery('"unbalanced'), '"unbalanced"*');
  assert.equal(buildFtsQuery('NEAR(a b)'), '"near"* "a"* "b"*');
  // Unicode
  assert.equal(buildFtsQuery('Привет мир'), '"привет"* "мир"*');
  assert.equal(buildFtsQuery('नमस्ते'), '"नमस्ते"*');
  assert.equal(buildFtsQuery('café'), '"café"*');
  // de-duplicated, capped
  assert.equal(buildFtsQuery('a a a b'), '"a"* "b"*');
  assert.equal(tokenize('1 2 3 4 5 6 7 8 9 10').length, 8);
  assert.equal(isSearchable('hi'), true);
});

test('LIKE fallback escapes wildcards', () => {
  assert.equal(escapeLike('100%_off\\'), '100\\%\\_off\\\\');
  assert.deepEqual(buildLikePatterns('50% off'), ['%50%', '%off%']);
  assert.deepEqual(buildLikePatterns('x'), []);
});

test('highlighting and snippets', () => {
  assert.deepEqual(highlightSegments('Hello hello world', 'hel'), [
    { text: 'Hel', match: true },
    { text: 'lo ', match: false },
    { text: 'hel', match: true },
    { text: 'lo world', match: false },
  ]);
  assert.deepEqual(highlightSegments('abc', ''), [{ text: 'abc', match: false }]);
  assert.deepEqual(highlightSegments('', 'abc'), []);
  assert.equal(
    highlightSegments('meet at the cafe', 'meet cafe').filter((s) => s.match).map((s) => s.text).join('|'),
    'meet|cafe'
  );
  const long = `${'x'.repeat(100)} needle ${'y'.repeat(100)}`;
  const snip = makeSnippet(long, 'needle', 20);
  assert.ok(snip.startsWith('…') && snip.endsWith('…') && snip.includes('needle'));
  assert.equal(makeSnippet('short text', 'zzz'), 'short text');
});

test('search result navigation wraps around', () => {
  assert.equal(stepResult(-1, 3, 'older'), 0);
  assert.equal(stepResult(0, 3, 'older'), 1);
  assert.equal(stepResult(2, 3, 'older'), 0);
  assert.equal(stepResult(0, 3, 'newer'), 2);
  assert.equal(stepResult(0, 0, 'older'), -1);
});

// ── chat list ───────────────────────────────────────────────────────────────

test('chat list previews', () => {
  assert.equal(previewBody(msg({ messageType: 'image', content: undefined })), '📷 Photo');
  assert.equal(previewBody(msg({ messageType: 'image', content: 'beach' })), '📷 beach');
  assert.equal(previewBody(msg({ messageType: 'voice' })), '🎤 Voice message');
  assert.equal(previewBody(msg({ messageType: 'video', content: undefined })), '🎥 Video');
  assert.equal(previewBody(msg({ messageType: 'document', content: 'a.pdf' })), '📄 a.pdf');
  assert.equal(previewBody(msg({ messageType: 'unavailable' })), '🔒 Encrypted message');
  assert.equal(previewBody(msg({ revokedAt: iso(T0) })), '🚫 You deleted this message');
  assert.equal(previewBody(msg({ revokedAt: iso(T0), isOwn: false })), '🚫 This message was deleted');

  const fromAlice = msg({ isOwn: false, senderName: 'Alice', messageType: 'image', content: undefined });
  assert.equal(previewLine(fromAlice, true), 'Alice: 📷 Photo');
  assert.equal(previewLine(fromAlice, false), '📷 Photo');
  assert.equal(previewLine(msg(), true), 'You: hello');
  assert.equal(previewLine(msg({ messageType: 'system', content: 'Alice set timer' }), true), 'Alice set timer');
  assert.equal(previewLine(msg({ isOwn: false, senderName: 'A', revokedAt: iso(T0) }), true), '🚫 This message was deleted');
});

test('unread = messages from others after my read watermark', () => {
  const lastRead = '2026-05-01T12:00:00.500000+00:00';
  const list = [
    msg({ isOwn: false, createdAt: '2026-05-01T12:00:00.400000+00:00' }), // before watermark
    msg({ isOwn: false, createdAt: '2026-05-01T12:00:00.600000+00:00' }), // after
    msg({ isOwn: false, createdAt: '2026-05-01T12:00:01Z' }), // after (other format)
    msg({ isOwn: true, createdAt: '2026-05-01T12:00:02Z' }), // own
    msg({ isOwn: false, createdAt: '2026-05-01T12:00:03Z', messageType: 'system' }), // system
    msg({ isOwn: false, createdAt: '2026-05-01T12:00:04Z', revokedAt: '2026-05-01T12:00:05Z' }), // deleted
    msg({ isOwn: false, createdAt: '2026-05-01T12:00:04Z', deletedAt: '2026-05-01T12:00:05Z' }), // deleted for me
    msg({ isOwn: false, createdAt: '2026-05-01T12:00:04Z', expiresAt: '2026-05-01T12:00:05Z' }), // expired
  ];
  assert.equal(computeUnreadCount(list, lastRead, '2026-05-01T13:00:00Z'), 2);
  assert.equal(computeUnreadCount(list, null, '2026-05-01T13:00:00Z'), 3);
  assert.equal(countsAsUnread(msg({ isOwn: false, messageType: 'unavailable' }), null), true);
});

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    conversationType: 'direct',
    members: [],
    unreadCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const last = (createdAt: string) => ({ messageType: 'text' as const, createdAt, isOwn: false });

test('pinned chats first (latest pin on top), then by last activity', () => {
  const list = [
    conv('old', { lastMessage: last('2026-05-01T10:00:00Z') }),
    conv('new', { lastMessage: last('2026-05-01T11:00:00.5+00:00') }),
    conv('pinA', { pinnedAt: '2026-04-01T00:00:00Z', lastMessage: last('2026-01-01T00:00:00Z') }),
    conv('pinB', { pinnedAt: '2026-04-02T00:00:00Z' }),
    conv('empty', { updatedAt: '2026-05-01T10:30:00Z' }),
  ];
  assert.deepEqual(sortConversations(list).map((c) => c.id), ['pinB', 'pinA', 'new', 'empty', 'old']);
});

test('at most 3 pinned chats', () => {
  const pinned = Array.from({ length: PINNED_LIMIT }, (_, i) => conv(`p${i}`, { pinnedAt: iso(T0 + i) }));
  const list = [...pinned, conv('x')];
  assert.equal(canPin(list, 'x').ok, false);
  assert.equal(canPin(list, 'p0').ok, true, 're-pinning a pinned chat is fine');
  assert.equal(canPin([...pinned.slice(1), conv('x')], 'x').ok, true);
});

test('archive: split, auto-unarchive on new incoming message unless "keep archived"', () => {
  const list = [conv('a'), conv('b', { archivedAt: iso(T0) })];
  const { active, archived } = splitArchived(list);
  assert.deepEqual([active.map((c) => c.id), archived.map((c) => c.id)], [['a'], ['b']]);
  assert.equal(shouldAutoUnarchive(iso(T0), iso(T0 + 1000), false), true);
  assert.equal(shouldAutoUnarchive(iso(T0), iso(T0 + 1000), true), false);
  assert.equal(shouldAutoUnarchive(iso(T0), iso(T0 - 1000), false), false);
  assert.equal(shouldAutoUnarchive(null, iso(T0), false), false);
  assert.equal(shouldAutoUnarchive(iso(T0), null, false), false);
});

test('total unread excludes archived chats; mute indicator', () => {
  assert.equal(
    totalUnread([
      { unreadCount: 2, archivedAt: null },
      { unreadCount: 5, archivedAt: iso(T0) },
      { unreadCount: 1 },
    ]),
    3
  );
  assert.equal(isMuted({ mutedUntil: null }), false);
  assert.equal(isMuted({ mutedUntil: 'infinity' }), true);
  assert.equal(isMuted({ mutedUntil: iso(T0 + 1000) }, iso(T0)), true);
  assert.equal(isMuted({ mutedUntil: iso(T0 - 1000) }, iso(T0)), false);
});

test('timestamps compare by time, not by string format', () => {
  assert.equal(toMillis('2026-05-01T12:00:00.123456+00:00'), Date.parse('2026-05-01T12:00:00.123Z'));
  assert.equal(isAfter('2026-05-01T12:00:00.5+00:00', '2026-05-01T12:00:00.400Z'), true);
  assert.equal(isAfter(null, iso(T0)), false);
  assert.equal(isAfter(iso(T0), null), true);
  assert.ok(compareDesc(iso(T0), iso(T0 + 1)) > 0);
  assert.equal(toIso('2026-05-01T14:00:00+02:00'), '2026-05-01T12:00:00.000Z');
});
