// Direct chat: create, v3 (X3DH + Double Ratchet) text, LIVE delivery on the
// private conversation:<id> topic + user:<id> inbox ping, decryption on both
// recipient devices and the sender's second device, duplicate and
// out-of-order delivery.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnyEnvelope } from '../../../src/core/crypto/ratchet/envelope';
import { cleanup, MessageRow, User } from '../lib/actors';
import type { Listener } from '../lib/realtime';

after(cleanup);

describe('direct chat (v3, realtime, multi-device)', () => {
  let alice: User;
  let bob: User;
  let conv: string;
  const live: Record<string, Listener> = {};

  before(async () => {
    alice = await User.create('dc_alice');
    bob = await User.create('dc_bob');
    await alice.addDevice('alice-phone');
    await alice.addDevice('alice-laptop');
    await bob.addDevice('bob-phone');
    await bob.addDevice('bob-tablet');
  });

  test('create_direct_conversation is idempotent for the pair', async () => {
    conv = await alice.d1.rpc('create_direct_conversation', { p_other_user_id: bob.id });
    const again = await bob.d1.rpc('create_direct_conversation', { p_other_user_id: alice.id });
    assert.equal(again, conv);
    const { data } = await bob.d1.client.from('conversation_members').select('user_id').eq('conversation_id', conv);
    assert.deepEqual(new Set(data!.map((r) => r.user_id)), new Set([alice.id, bob.id]));
  });

  test('members subscribe to the private conversation topic and their own user topic', async () => {
    live.bob1 = await bob.d1.listen(`conversation:${conv}`);
    live.bob2 = await bob.d2.listen(`conversation:${conv}`);
    live.alice2 = await alice.devices[1].listen(`conversation:${conv}`);
    live.bobInbox = await bob.d1.listen(`user:${bob.id}`);
    live.aliceInbox = await alice.devices[1].listen(`user:${alice.id}`);
  });

  let first: MessageRow;
  test('v3 text arrives live on conversation:<id> and decrypts on both of bob\'s devices and alice\'s 2nd device', async (t) => {
    first = await alice.d1.send(conv, { t: 'text', body: 'hello bob 👋' });
    const env = parseAnyEnvelope(first.ciphertext);
    assert.equal(env.v, 3);
    const slotDevices = Object.keys(env.k).sort();
    assert.deepEqual(slotDevices, [alice.devices[1].deviceId, bob.d1.deviceId, bob.d2.deviceId].sort(), 'one slot per other device');

    for (const [name, l, dev] of [
      ['bob1', live.bob1, bob.d1],
      ['bob2', live.bob2, bob.d2],
      ['alice2', live.alice2, alice.devices[1]],
    ] as const) {
      const r = await l.waitFor('message.new', (p) => p.id === first.id);
      assert.equal(r.payload.ciphertext, first.ciphertext);
      const opened = await dev.open(r.payload);
      assert.deepEqual(opened.payload, { t: 'text', body: 'hello bob 👋' }, name);
    }
    const ping = await live.bobInbox.waitFor('inbox.message', (p) => p.message_id === first.id);
    assert.equal(ping.payload.conversation_id, conv);
    assert.equal(ping.payload.ciphertext, undefined, 'inbox ping carries no content');
    await live.aliceInbox.waitFor('inbox.message', (p) => p.message_id === first.id);
    t.diagnostic(`envelope v3, ${slotDevices.length} slots; delivered live to 3 devices + 2 inbox pings`);
  });

  test('duplicate delivery (realtime + history fetch) is answered from the plaintext cache', async () => {
    const row = await bob.d1.fetch(first.id);
    const again = await bob.d1.open(row!);
    assert.deepEqual(again.payload, { t: 'text', body: 'hello bob 👋' });
    const third = await bob.d1.open(row!);
    assert.equal(third.plaintext, again.plaintext);
    // ...and the session still works afterwards in both directions.
    const reply = await bob.d1.send(conv, { t: 'text', body: 'hi alice' });
    assert.deepEqual((await alice.d1.open(reply)).payload, { t: 'text', body: 'hi alice' });
    assert.deepEqual((await alice.devices[1].open(reply)).payload, { t: 'text', body: 'hi alice' });
    assert.deepEqual((await bob.d2.open(reply)).payload, { t: 'text', body: 'hi alice' });
  });

  test('out-of-order delivery decrypts with skipped message keys', async () => {
    const m = [];
    for (let i = 1; i <= 4; i++) m.push(await alice.d1.send(conv, { t: 'text', body: `ooo ${i}` }));
    for (const idx of [3, 0, 2, 1]) {
      const opened = await bob.d2.open(m[idx]);
      assert.deepEqual(opened.payload, { t: 'text', body: `ooo ${idx + 1}` });
    }
    for (const row of m) await bob.d1.open(row);
    // Interleaved replies from both bob devices keep every session healthy.
    const b1 = await bob.d1.send(conv, { t: 'text', body: 'from phone' });
    const b2 = await bob.d2.send(conv, { t: 'text', body: 'from tablet' });
    assert.equal((await alice.d1.open(b2)).plaintext, JSON.stringify({ t: 'text', body: 'from tablet' }));
    assert.equal((await alice.d1.open(b1)).plaintext, JSON.stringify({ t: 'text', body: 'from phone' }));
    assert.equal(alice.d1.resets.length + bob.d1.resets.length + bob.d2.resets.length, 0, 'no session resets');
  });

  test('the server refuses a message from a device that is not the sender\'s', async () => {
    const res = await bob.d1.client.from('messages').insert({
      conversation_id: conv,
      sender_device_id: alice.d1.deviceId,
      sender_user_id: bob.id,
      ciphertext: 'x',
      message_type: 'text',
    });
    assert.equal(res.error?.code, '42501');
  });

  after(async () => {
    for (const l of Object.values(live)) await l.close().catch(() => undefined);
  });
});
