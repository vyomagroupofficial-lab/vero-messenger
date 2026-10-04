import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRIVACY,
  defaultTimerForNewChat,
  fromRow,
  mayBroadcastTyping,
  mayShareOnline,
  receiptKindToSend,
  toRow,
  visibleStatus,
} from '../src/features/settings/privacy';
import { computeStatus } from '../src/features/messages/status';
import { shouldLock, APP_LOCK_TIMEOUTS } from '../src/features/settings/appLockRules';
import { isMutedUntil, muteLabel, muteUntilFor } from '../src/features/notifications/mute';
import { formatLastSeen, presenceSubtitle } from '../src/features/presence/format';
import { isAutoBackupDue } from '../src/features/backup/schedule';
import type { ConversationMember, Message } from '../src/shared/models/Message';

// ── settings row mapping ──────────────────────────────────────────────────────

test('settings: server row round trip and safe defaults', () => {
  const s = { ...DEFAULT_PRIVACY, readReceipts: false, lastSeen: 'contacts' as const, defaultDisappearingSeconds: 86400 };
  assert.deepEqual(fromRow(toRow(s) as any), s);
  assert.deepEqual(fromRow(null), DEFAULT_PRIVACY);
  assert.deepEqual(fromRow({ last_seen: 'friends', default_disappearing_seconds: -1, read_receipts: 'no' } as any), DEFAULT_PRIVACY);
  assert.equal(DEFAULT_PRIVACY.notificationPreviews, false, 'previews are off by default');
  assert.deepEqual(toRow({ typingIndicators: false }), { typing_indicators: false }, 'patches only touch given keys');
  assert.throws(() => toRow({ lastSeen: 'friends' as any }));
  assert.throws(() => toRow({ defaultDisappearingSeconds: 1.5 }));
});

// ── read receipts ─────────────────────────────────────────────────────────────

const ME = 'me';
const members: ConversationMember[] = [
  { id: ME, username: 'me', displayName: 'Me' } as ConversationMember,
  {
    id: 'them',
    username: 'them',
    displayName: 'Them',
    lastDeliveredAt: '2026-01-01T10:05:00.000Z',
    lastReadAt: '2026-01-01T10:05:00.000Z',
  } as ConversationMember,
];
const ownMessage = { id: 'm', isOwn: true, status: 'sent', createdAt: '2026-01-01T10:00:00.000Z' } as Message;

test('read receipts off: only "delivered" is sent', () => {
  assert.equal(receiptKindToSend('read', { readReceipts: false }), 'delivered');
  assert.equal(receiptKindToSend('delivered', { readReceipts: false }), 'delivered');
  assert.equal(receiptKindToSend('read', { readReceipts: true }), 'read');
});

test('read receipts off: other people\'s read ticks are hidden too (reciprocal)', () => {
  const raw = computeStatus(ownMessage, members, ME);
  assert.equal(raw, 'read');
  assert.equal(visibleStatus(raw, { readReceipts: true }), 'read');
  assert.equal(visibleStatus(raw, { readReceipts: false }), 'delivered');
  assert.equal(visibleStatus('sent', { readReceipts: false }), 'sent');
  assert.equal(visibleStatus('failed', { readReceipts: false }), 'failed');
});

test('typing off: never broadcast; online off: never tracked', () => {
  assert.equal(mayBroadcastTyping({ typingIndicators: false }), false);
  assert.equal(mayBroadcastTyping({ typingIndicators: true }), true);
  assert.equal(mayShareOnline({ showOnline: false }), false);
  assert.equal(mayShareOnline({ showOnline: true }), true);
});

test('default disappearing timer applies to brand-new chats only', () => {
  const s = { defaultDisappearingSeconds: 86400 };
  assert.equal(defaultTimerForNewChat(s, { hasMessages: false, currentTimerSeconds: 0 }), 86400);
  assert.equal(defaultTimerForNewChat(s, { hasMessages: true, currentTimerSeconds: 0 }), null, 'existing chat');
  assert.equal(defaultTimerForNewChat(s, { hasMessages: false, currentTimerSeconds: 3600 }), null, 'timer already set');
  assert.equal(defaultTimerForNewChat({ defaultDisappearingSeconds: 0 }, { hasMessages: false, currentTimerSeconds: 0 }), null);
});

// ── mute ──────────────────────────────────────────────────────────────────────

test('mute: 8 hours / 1 week / always / off', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  assert.equal(muteUntilFor('8h', now), '2026-03-01T20:00:00.000Z');
  assert.equal(muteUntilFor('1w', now), '2026-03-08T12:00:00.000Z');
  assert.equal(muteUntilFor('always', now), 'infinity');
  assert.equal(muteUntilFor('off', now), null);
  assert.equal(isMutedUntil('infinity', now), true);
  assert.equal(isMutedUntil('2026-03-01T13:00:00.000Z', now), true);
  assert.equal(isMutedUntil('2026-03-01T11:00:00.000Z', now), false);
  assert.equal(isMutedUntil(null, now), false);
  assert.equal(muteLabel('infinity', now), 'Muted');
  assert.match(muteLabel('2026-03-01T13:00:00.000Z', now) ?? '', /^Muted until /);
  assert.equal(muteLabel('2026-03-01T11:00:00.000Z', now), null);
});

// ── presence ─────────────────────────────────────────────────────────────────

test('presence subtitle: online wins, then last seen, hidden -> null', () => {
  const now = new Date(2026, 2, 10, 15, 30);
  assert.equal(presenceSubtitle({ online: true, lastSeenAt: null }, now), 'online');
  assert.equal(presenceSubtitle({ online: false, lastSeenAt: null }, now), null);
  assert.equal(formatLastSeen(new Date(2026, 2, 10, 15, 29, 40).toISOString(), now), 'last seen just now');
  assert.equal(formatLastSeen(new Date(2026, 2, 10, 15, 10).toISOString(), now), 'last seen 20 min ago');
  assert.equal(formatLastSeen(new Date(2026, 2, 10, 9, 5).toISOString(), now), 'last seen today at 09:05');
  assert.equal(formatLastSeen(new Date(2026, 2, 9, 22, 0).toISOString(), now), 'last seen yesterday at 22:00');
  assert.equal(formatLastSeen(new Date(2026, 0, 2, 8, 0).toISOString(), now), 'last seen 2 Jan at 08:00');
  assert.equal(formatLastSeen(new Date(2025, 0, 2, 8, 0).toISOString(), now), 'last seen 2 Jan 2025 at 08:00');
  assert.equal(formatLastSeen('garbage', now), null);
});

// ── app lock ─────────────────────────────────────────────────────────────────

test('app lock: locks after the chosen time in the background', () => {
  assert.deepEqual(APP_LOCK_TIMEOUTS.map((t) => t.seconds), [0, 60, 300, 1800]);
  const t0 = 1_000_000;
  assert.equal(shouldLock({ enabled: false, timeoutSeconds: 0, backgroundedAt: t0, now: t0 + 999_999 }), false);
  assert.equal(shouldLock({ enabled: true, timeoutSeconds: 0, backgroundedAt: t0, now: t0 }), true, 'immediately');
  assert.equal(shouldLock({ enabled: true, timeoutSeconds: 60, backgroundedAt: t0, now: t0 + 59_000 }), false);
  assert.equal(shouldLock({ enabled: true, timeoutSeconds: 60, backgroundedAt: t0, now: t0 + 60_000 }), true);
  assert.equal(shouldLock({ enabled: true, timeoutSeconds: 1800, backgroundedAt: t0, now: t0 + 1_799_000 }), false);
  assert.equal(shouldLock({ enabled: true, timeoutSeconds: 300, backgroundedAt: null, now: t0 }), false, 'never backgrounded');
});

// ── auto backup ──────────────────────────────────────────────────────────────

test('daily auto-backup is due after 24 hours', () => {
  const now = Date.parse('2026-03-02T12:00:00.000Z');
  const on = { methods: ['recovery'], autoDaily: true };
  assert.equal(isAutoBackupDue({ ...on, lastBackupAt: null }, now), true);
  assert.equal(isAutoBackupDue({ ...on, lastBackupAt: '2026-03-02T00:00:00.000Z' }, now), false);
  assert.equal(isAutoBackupDue({ ...on, lastBackupAt: '2026-03-01T11:59:00.000Z' }, now), true);
  assert.equal(isAutoBackupDue({ ...on, autoDaily: false, lastBackupAt: null }, now), false);
  assert.equal(isAutoBackupDue({ methods: [], autoDaily: true, lastBackupAt: null }, now), false);
});
