import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePayload, serverTypeFor, MAX_TEXT_LENGTH } from '../src/shared/models/payload';
import { computeStatus } from '../src/features/messages/status';
import type { ConversationMember, Message } from '../src/shared/models/Message';

const media = {
  mediaId: 'm1',
  objectId: 'sb:x.bin',
  key: 'k',
  nonce: 'n',
  hash: 'a'.repeat(64),
  mimeType: 'image/jpeg',
  size: 10,
};

test('valid payloads round-trip', () => {
  for (const p of [
    { t: 'text', body: 'hi' },
    { t: 'reaction', target: 'abc', emoji: '👍' },
    { t: 'reaction', target: 'abc', emoji: null },
    { t: 'timer', seconds: 3600 },
    { t: 'media', kind: 'image', caption: 'cap', media },
  ] as const) {
    assert.deepEqual(JSON.parse(JSON.stringify(parsePayload(JSON.stringify(p)))), p);
  }
});

test('hostile or malformed payloads are rejected', () => {
  for (const raw of [
    'not json',
    'null',
    '42',
    JSON.stringify({ t: 'text' }),
    JSON.stringify({ t: 'text', body: 'x'.repeat(MAX_TEXT_LENGTH + 1) }),
    JSON.stringify({ t: 'unknown', body: 'x' }),
    JSON.stringify({ t: 'reaction', target: 'a', emoji: 'x'.repeat(100) }),
    JSON.stringify({ t: 'timer', seconds: -1 }),
    JSON.stringify({ t: 'timer', seconds: 1.5 }),
    JSON.stringify({ t: 'media', kind: 'exe', media }),
    JSON.stringify({ t: 'media', kind: 'image', media: { ...media, key: 123 } }),
  ]) {
    assert.equal(parsePayload(raw), null, raw.slice(0, 60));
  }
});

test('unknown fields in media are dropped (no smuggled localUri)', () => {
  const parsed = parsePayload(JSON.stringify({ t: 'media', kind: 'document', media: { ...media, localUri: 'file:///etc/passwd' } }));
  assert.ok(parsed && parsed.t === 'media');
  assert.equal((parsed.media as any).localUri, undefined);
});

test('server only learns a coarse message type', () => {
  assert.equal(serverTypeFor({ t: 'media', kind: 'voice', media }), 'media');
  assert.equal(serverTypeFor({ t: 'timer', seconds: 0 }), 'system');
});

test('receipt status is derived from every other member', () => {
  const msg: Message = {
    id: '1', conversationId: 'c', senderDeviceId: 'd', senderUserId: 'me', messageType: 'text',
    createdAt: '2026-01-01T10:00:00.000Z', status: 'sent', isOwn: true,
  };
  const member = (id: string, delivered?: string, read?: string): ConversationMember => ({
    id, username: id, displayName: id, role: 'member', lastDeliveredAt: delivered, lastReadAt: read,
  });
  const later = '2026-01-01T10:05:00.000Z';
  const earlier = '2026-01-01T09:00:00.000Z';

  assert.equal(computeStatus(msg, [member('me'), member('a', earlier)], 'me'), 'sent');
  assert.equal(computeStatus(msg, [member('me'), member('a', later)], 'me'), 'delivered');
  assert.equal(computeStatus(msg, [member('me'), member('a', later, later)], 'me'), 'read');
  // group: read only when everyone has read
  assert.equal(computeStatus(msg, [member('a', later, later), member('b', later)], 'me'), 'delivered');
  assert.equal(computeStatus({ ...msg, status: 'failed' }, [member('a', later, later)], 'me'), 'failed');
});
