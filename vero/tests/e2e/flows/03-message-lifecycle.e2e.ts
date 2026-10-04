// Message lifecycle: receipts, edit (encrypted control), delete for everyone
// inside / outside the 48 h window, reply, starred-message self-sync,
// pin / archive (+ limit), mute, disappearing messages, block.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseSelfSyncPayload, type SelfSyncPayload } from '../../../src/features/messages/selfSyncPayload';
import { adminClient, cleanup, rejects, sleep, User } from '../lib/actors';
import { hasDb, lit, sql } from '../lib/db';
import type { Listener } from '../lib/realtime';

after(cleanup);

describe('message lifecycle', () => {
  let alice: User;
  let bob: User;
  let conv: string;
  let bobConv: Listener;
  let aliceConv: Listener;

  before(async () => {
    alice = await User.create('ml_alice');
    bob = await User.create('ml_bob');
    await alice.addDevice('alice-phone');
    await alice.addDevice('alice-laptop');
    await bob.addDevice('bob-phone');
    conv = await alice.d1.rpc('create_direct_conversation', { p_other_user_id: bob.id });
    bobConv = await bob.d1.listen(`conversation:${conv}`);
    aliceConv = await alice.d1.listen(`conversation:${conv}`);
  });

  test('delivery and read receipts are watermarks broadcast to the chat', async () => {
    const m = await alice.d1.send(conv, { t: 'text', body: 'receipt me' });
    await bob.d1.rpc('mark_conversation_receipt', { p_conversation_id: conv, p_kind: 'delivered', p_until: m.created_at });
    await aliceConv.waitFor('receipt', (p) => p.user_id === bob.id && p.kind === 'delivered');
    await bob.d1.rpc('mark_conversation_receipt', { p_conversation_id: conv, p_kind: 'read', p_until: m.created_at });
    await aliceConv.waitFor('receipt', (p) => p.user_id === bob.id && p.kind === 'read');
    const { data } = await alice.d1.client
      .from('conversation_members')
      .select('last_delivered_at, last_read_at')
      .eq('conversation_id', conv)
      .eq('user_id', bob.id)
      .single();
    assert.ok(new Date(data!.last_read_at).getTime() >= new Date(m.created_at).getTime() - 1);
    const bad = await rejects(bob.d1.client.rpc('mark_conversation_receipt', { p_conversation_id: conv, p_kind: 'seen' }));
    assert.equal(bad.code, '22023');
  });

  test('edit travels as an encrypted control row; the server only sees "control"', async () => {
    const orig = await alice.d1.send(conv, { t: 'text', body: 'typo hre' });
    await bob.d1.open(orig);
    const edit = await alice.d1.send(conv, { t: 'edit', targetId: orig.id, newText: 'typo here', editedAt: new Date().toISOString() });
    assert.equal(edit.message_type, 'control');
    const live = await bobConv.waitFor('message.new', (p) => p.id === edit.id);
    const opened = await bob.d1.open(live.payload);
    assert.deepEqual(opened.payload, { t: 'edit', targetId: orig.id, newText: 'typo here', editedAt: (opened.payload as any).editedAt });
    // The sender's other device applies it too.
    assert.equal((await alice.d2.open(edit)).payload?.t, 'edit');
    // Control rows can't carry replies or media.
    const r = await rejects(alice.d1.send(conv, { t: 'edit', targetId: orig.id, newText: 'x', editedAt: new Date().toISOString() }, { replyTo: orig.id }));
    assert.equal(r.code, '22023');
  });

  test('reply references a message of the same chat only', async () => {
    const target = await bob.d1.send(conv, { t: 'text', body: 'question?' });
    const reply = await alice.d1.send(conv, { t: 'text', body: 'answer' }, { replyTo: target.id });
    assert.equal(reply.reply_to_message_id, target.id);
    const other = await alice.d1.rpc('create_group_conversation', { p_name: 'other', p_member_ids: [bob.id] });
    const cross = await rejects(alice.d1.send(other, { t: 'text', body: 'x' }, { replyTo: target.id }));
    assert.equal(cross.code, '22023');
  });

  test('delete for everyone inside the 48 h window wipes the ciphertext and notifies', async () => {
    const m = await alice.d1.send(conv, { t: 'text', body: 'oops' });
    const bobInbox = await bob.d1.listen(`user:${bob.id}`);
    const notMine = await rejects(bob.d1.client.rpc('delete_message', { p_message_id: m.id }));
    assert.equal(notMine.code, 'P0002');
    await alice.d1.rpc('delete_message', { p_message_id: m.id });
    await bobConv.waitFor('message.deleted', (p) => p.id === m.id);
    await bobInbox.waitFor('inbox.deleted', (p) => p.message_id === m.id);
    const row = await bob.d1.fetch(m.id);
    assert.equal(row!.ciphertext, '');
    assert.ok(row!.deleted_at);
    // Devices that were offline catch up with deleted_at > cursor.
    const { data } = await bob.d1.client.from('messages').select('id').eq('conversation_id', conv).gt('deleted_at', new Date(Date.now() - 60_000).toISOString());
    assert.ok(data!.some((r) => r.id === m.id));
    await bobInbox.close();
  });

  test('delete for everyone after 48 h is refused', async (t) => {
    if (!hasDb) return t.skip('needs DATABASE_URL to backdate a message');
    const m = await alice.d1.send(conv, { t: 'text', body: 'old news' });
    sql(`update public.messages set created_at = now() - interval '49 hours' where id = ${lit(m.id)}`);
    const r = await rejects(alice.d1.client.rpc('delete_message', { p_message_id: m.id }));
    assert.equal(r.code, '22023');
    assert.match(r.message, /48 hours/);
  });

  test('starred messages sync only to the user\'s own devices (encrypted self_sync_events)', async () => {
    const aliceInbox2 = await alice.d2.listen(`user:${alice.id}`);
    const payload: SelfSyncPayload = { t: 'stars', items: [{ id: randomUUID(), c: conv, s: true, at: new Date().toISOString() }] };
    const id = randomUUID();
    const ctx = { conversationId: `self:${alice.id}`, messageId: id, senderDeviceId: alice.d1.deviceId };
    const ciphertext = await alice.d1.sessions.encrypt(ctx, JSON.stringify(payload), [
      { deviceId: alice.d2.deviceId, publicKey: alice.d2.identity.publicKey },
    ]);
    const ins = await alice.d1.client.from('self_sync_events').insert({ id, sender_device_id: alice.d1.deviceId, ciphertext });
    assert.equal(ins.error, null, ins.error?.message);
    await aliceInbox2.waitFor('self.sync', (p) => p.id === id);
    const { data } = await alice.d2.client.from('self_sync_events').select('id, sender_device_id, ciphertext').eq('id', id).single();
    const key = await alice.d2.keyOf(alice.d1.deviceId);
    const plain = await alice.d2.sessions.decrypt(ctx, data!.ciphertext, key!.publicKey);
    assert.deepEqual(parseSelfSyncPayload(plain), payload);
    // Bob can neither read nor forge alice's sync events.
    const peek = await bob.d1.client.from('self_sync_events').select('id').eq('id', id);
    assert.deepEqual(peek.data, []);
    const forge = await bob.d1.client.from('self_sync_events').insert({ sender_device_id: alice.d1.deviceId, ciphertext: 'x' });
    assert.ok(forge.error);
    await aliceInbox2.close();
  });

  test('pin up to 3 chats (4th refused), archive unpins, prefs stay private', async () => {
    const others = await Promise.all(['ml_c', 'ml_d', 'ml_e'].map((n) => User.create(n)));
    const convs = [conv];
    for (const o of others) convs.push(await alice.d1.rpc('create_direct_conversation', { p_other_user_id: o.id }));
    const inbox = await alice.d2.listen(`user:${alice.id}`);
    for (const c of convs.slice(0, 3)) assert.ok(await alice.d1.rpc('pin_conversation', { p_conversation_id: c, p_pinned: true }));
    await inbox.waitFor('prefs.changed', (p) => p.conversation_id === convs[2] && p.pinned_at);
    const fourth = await rejects(alice.d1.client.rpc('pin_conversation', { p_conversation_id: convs[3], p_pinned: true }));
    assert.equal(fourth.code, '23514');
    await alice.d1.rpc('archive_conversation', { p_conversation_id: convs[0], p_archived: true });
    const { data: prefs } = await alice.d1.client.from('conversation_prefs').select('conversation_id, pinned_at, archived_at').eq('conversation_id', convs[0]).single();
    assert.equal(prefs!.pinned_at, null);
    assert.ok(prefs!.archived_at);
    assert.ok(await alice.d1.rpc('pin_conversation', { p_conversation_id: convs[3], p_pinned: true }), 'slot freed by archiving');
    const peek = await bob.d1.client.from('conversation_prefs').select('*');
    assert.deepEqual(peek.data, [], 'bob sees none of alice\'s prefs');
    const direct = await alice.d1.client.from('conversation_prefs').insert({ user_id: alice.id, conversation_id: convs[1], pinned_at: new Date().toISOString() });
    assert.ok(direct.error, 'writes only through the RPCs');
    const stranger = await rejects(bob.d1.client.rpc('pin_conversation', { p_conversation_id: convs[1], p_pinned: true }));
    assert.equal(stranger.code, '42501');
    await inbox.close();
  });

  test('mute / unmute', async () => {
    const until = await bob.d1.rpc('mute_conversation', { p_conversation_id: conv, p_until: 'infinity' });
    assert.equal(until, 'infinity');
    const mutes = await bob.d1.rpc('get_conversation_mutes');
    assert.deepEqual(mutes.map((m: any) => m.conversation_id), [conv]);
    assert.equal(await bob.d1.rpc('mute_conversation', { p_conversation_id: conv, p_until: null }), null);
    assert.deepEqual(await bob.d1.rpc('get_conversation_mutes'), []);
  });

  test('disappearing message: readable until expires_at, then hidden and hard-deleted', async (t) => {
    const past = await rejects(alice.d1.send(conv, { t: 'text', body: 'x' }, { expiresAt: new Date(Date.now() - 1000).toISOString() }));
    assert.equal(past.code, '22023');
    const m = await alice.d1.send(conv, { t: 'text', body: 'self-destruct' }, { expiresAt: new Date(Date.now() + 3000).toISOString() });
    assert.equal((await bob.d1.open((await bob.d1.fetch(m.id))!)).payload?.t, 'text');
    await sleep(3500);
    assert.equal(await bob.d1.fetch(m.id), null, 'RLS hides it after expiry');
    const admin = adminClient();
    if (!admin) return t.skip('needs the service key to run cleanup_expired_messages');
    const { data: n, error } = await admin.rpc('cleanup_expired_messages');
    assert.equal(error, null, error?.message);
    assert.ok(n >= 1);
    const { data: gone } = await admin.from('messages').select('id').eq('id', m.id);
    assert.deepEqual(gone, []);
    t.diagnostic(`cleanup_expired_messages() removed ${n} row(s)`);
  });

  test('block: no messages or new chats either way, until unblocked', async () => {
    const ins = await alice.d1.client.from('blocks').insert({ blocked_user_id: bob.id });
    assert.equal(ins.error, null);
    const send = await rejects(bob.d1.send(conv, { t: 'text', body: 'hello?' }));
    assert.equal(send.code, '42501');
    const back = await rejects(alice.d1.send(conv, { t: 'text', body: 'nope' }));
    assert.equal(back.code, '42501');
    const again = await rejects(bob.d1.client.rpc('create_direct_conversation', { p_other_user_id: alice.id }));
    assert.equal(again.code, '42501');
    const found = await bob.d1.rpc('search_profiles', { p_query: alice.username });
    assert.deepEqual(found, []);
    // bob can't see or remove alice's block
    const peek = await bob.d1.client.from('blocks').select('*');
    assert.deepEqual(peek.data, []);
    await alice.d1.client.from('blocks').delete().eq('blocked_user_id', bob.id);
    const ok = await bob.d1.send(conv, { t: 'text', body: 'unblocked' });
    assert.equal((await alice.d1.open(ok)).payload?.t, 'text');
  });

  after(async () => {
    await bobConv?.close().catch(() => undefined);
    await aliceConv?.close().catch(() => undefined);
  });
});
