import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_POST_BODY,
  MESSAGE_BODY,
  buildCallPushes,
  buildChannelPostPushes,
  buildMessagePushes,
  chunk,
  cleanName,
  deadTokens,
  isExpoPushToken,
  MessagePushTarget,
} from '../supabase/functions/_shared/pushPayload';
import { routeForNotification, shouldPresentInForeground } from '../src/features/notifications/notificationRoutes';

const CONV = '11111111-1111-4111-8111-111111111111';
const CALL = '22222222-2222-4222-8222-222222222222';
const CHANNEL = '33333333-3333-4333-8333-333333333333';

function target(over: Partial<MessagePushTarget> = {}): MessagePushTarget {
  return {
    device_id: 'dev-1',
    user_id: 'user-1',
    token: 'ExponentPushToken[abc123]',
    previews: false,
    sender_name: 'Alice',
    conversation_id: CONV,
    conversation_type: 'direct',
    group_name: null,
    ...over,
  };
}

test('message push: neutral by default (no sender, no content)', () => {
  const [item] = buildMessagePushes([target()]);
  assert.equal(item.message.title, 'Vero');
  assert.equal(item.message.body, MESSAGE_BODY);
  assert.equal(item.message.channelId, 'messages');
  assert.deepEqual(item.message.data, { type: 'message', conversationId: CONV });
  assert.ok(!JSON.stringify(item.message).includes('Alice'));
});

test('message push: sender (and group) name only with previews on', () => {
  assert.equal(buildMessagePushes([target({ previews: true })])[0].message.title, 'Alice');
  const group = buildMessagePushes([target({ previews: true, conversation_type: 'group', group_name: 'Hikers' })])[0];
  assert.equal(group.message.title, 'Alice · Hikers');
  const groupNoPreview = buildMessagePushes([target({ conversation_type: 'group', group_name: 'Hikers' })])[0];
  assert.ok(!JSON.stringify(groupNoPreview.message).includes('Hikers'));
});

test('message push: never leaks content, whatever extra fields the database returns', () => {
  const rows = [
    {
      ...target({ previews: true }),
      // Fields that must never be copied into a notification:
      ciphertext: 'CIPHERTEXT-SECRET',
      content: 'PLAINTEXT-SECRET',
      body: 'BODY-SECRET',
      message_type: 'text',
    } as unknown as MessagePushTarget,
  ];
  const json = JSON.stringify(buildMessagePushes(rows));
  for (const secret of ['CIPHERTEXT-SECRET', 'PLAINTEXT-SECRET', 'BODY-SECRET']) assert.ok(!json.includes(secret), secret);
  const [item] = buildMessagePushes(rows);
  assert.deepEqual(Object.keys(item.message.data).sort(), ['conversationId', 'type']);
  assert.equal(item.message.body, MESSAGE_BODY);
});

test('message push: hostile display names are cleaned and capped', () => {
  const [item] = buildMessagePushes([target({ previews: true, sender_name: '‮evil\u0000name' + 'x'.repeat(100) })]);
  assert.ok(!/[\u0000‮]/.test(item.message.title));
  assert.ok(item.message.title.length <= 48);
  assert.equal(cleanName('   '), null);
  assert.equal(buildMessagePushes([target({ previews: true, sender_name: '  ' })])[0].message.title, 'Vero');
});

test('only well-formed Expo tokens are used', () => {
  assert.ok(isExpoPushToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'));
  assert.ok(isExpoPushToken('ExpoPushToken[abc-DEF_123]'));
  assert.ok(!isExpoPushToken('https://evil.example/hook'));
  assert.ok(!isExpoPushToken('ExponentPushToken[]'));
  assert.equal(buildMessagePushes([target({ token: 'not-a-token' })]).length, 0);
});

test('call push: high priority, calls channel, incoming_call category, short ttl', () => {
  const [item] = buildCallPushes([
    {
      device_id: 'd',
      user_id: 'u',
      token: 'ExponentPushToken[call]',
      previews: false,
      caller_name: 'Bob',
      conversation_id: CONV,
      call_id: CALL,
      call_type: 'video',
    },
  ]);
  assert.equal(item.message.priority, 'high');
  assert.equal(item.message.channelId, 'calls');
  assert.equal(item.message.categoryId, 'incoming_call');
  assert.equal(item.message.title, 'Vero');
  assert.equal(item.message.body, 'Incoming video call');
  assert.ok(item.message.ttl && item.message.ttl <= 60);
  assert.deepEqual(item.message.data, { type: 'call', callId: CALL, conversationId: CONV, callType: 'video' });
  const withName = buildCallPushes([{ ...(item as any), device_id: 'd', user_id: 'u', token: 'ExponentPushToken[c]', previews: true, caller_name: 'Bob', conversation_id: CONV, call_id: CALL, call_type: 'voice' }])[0];
  assert.equal(withName.message.title, 'Bob');
  assert.equal(withName.message.body, 'Incoming voice call');
});

test('channel post push: ids only, name only with previews', () => {
  const base = { device_id: 'd', user_id: 'u', token: 'ExponentPushToken[ch]', channel_id: CHANNEL, channel_name: 'Trail News' };
  const [neutral] = buildChannelPostPushes([{ ...base, previews: false }]);
  assert.equal(neutral.message.title, 'Vero');
  assert.equal(neutral.message.body, CHANNEL_POST_BODY);
  assert.deepEqual(neutral.message.data, { type: 'channel_post', channelId: CHANNEL });
  assert.equal(buildChannelPostPushes([{ ...base, previews: true }])[0].message.title, 'Trail News');
});

test('batches of 100 and dead-token detection', () => {
  const items = buildMessagePushes(
    Array.from({ length: 250 }, (_, i) => target({ device_id: `d${i}`, token: `ExponentPushToken[t${i}]` }))
  );
  const batches = chunk(items);
  assert.deepEqual(batches.map((b) => b.length), [100, 100, 50]);
  const tickets = batches[0].map((_, i) =>
    i === 3 ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : i === 4 ? { status: 'error', details: { error: 'MessageRateExceeded' } } : { status: 'ok', id: 'x' }
  );
  assert.deepEqual(deadTokens(batches[0], tickets).map((d) => d.deviceId), ['d3']);
  assert.deepEqual(deadTokens(batches[0], null), []);
});

test('notification taps route to the right screen; junk is ignored', () => {
  assert.deepEqual(routeForNotification({ type: 'message', conversationId: CONV }), { pathname: '/chat/[id]', params: { id: CONV } });
  assert.deepEqual(routeForNotification({ type: 'call', callId: CALL }), { pathname: '/call/[id]', params: { id: CALL } });
  assert.deepEqual(routeForNotification({ type: 'channel_post', channelId: CHANNEL }), {
    pathname: '/channels/[id]',
    params: { id: CHANNEL },
  });
  assert.equal(routeForNotification({ type: 'message', conversationId: '../../settings' }), null);
  assert.equal(routeForNotification({ type: 'other' }), null);
  assert.equal(routeForNotification(null), null);
});

test('foreground: no banner for the open chat, muted chats or calls', () => {
  const ctx = { openConversationId: CONV, isMuted: (id: string) => id === 'muted' };
  assert.equal(shouldPresentInForeground({ type: 'message', conversationId: CONV }, ctx), false);
  assert.equal(shouldPresentInForeground({ type: 'message', conversationId: 'muted' }, ctx), false);
  assert.equal(shouldPresentInForeground({ type: 'message', conversationId: 'other' }, ctx), true);
  assert.equal(shouldPresentInForeground({ type: 'call', callId: CALL }, ctx), false);
});
