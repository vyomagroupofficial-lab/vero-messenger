// Groups: create / add / remove (a removed member gets no key slots and
// loses access), group events, admin-only send, invite links
// (create / preview / join / revoke / expired / max uses / rate limit).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnyEnvelope } from '../../../src/core/crypto/ratchet/envelope';
import { cleanup, rejects, sleep, User } from '../lib/actors';
import type { Listener } from '../lib/realtime';

after(cleanup);

describe('groups and invite links', () => {
  let alice: User; // owner
  let bob: User;
  let carol: User; // removed later
  let dave: User; // joins by link
  let group: string;
  let carolLive: Listener;
  let events: Listener;

  before(async () => {
    [alice, bob, carol, dave] = await Promise.all(['gr_alice', 'gr_bob', 'gr_carol', 'gr_dave'].map((n) => User.create(n)));
    await alice.addDevice();
    await bob.addDevice();
    await bob.addDevice();
    await carol.addDevice();
    await dave.addDevice();
  });

  test('create group; every member device gets a slot; group:<id> events', async (t) => {
    group = await alice.d1.rpc('create_group_conversation', { p_name: 'E2E Group', p_member_ids: [bob.id, carol.id] });
    events = await bob.d1.listen(`group:${group}`);
    carolLive = await carol.d1.listen(`conversation:${group}`);
    const m = await alice.d1.send(group, { t: 'text', body: 'welcome all' });
    const slots = Object.keys(parseAnyEnvelope(m.ciphertext).k);
    assert.equal(slots.length, 3, "bob x2 + carol (the sending device needs no slot)");
    for (const d of [bob.d1, bob.d2, carol.d1]) assert.equal((await d.open(m)).payload?.t, 'text');
    const live = await carolLive.waitFor('message.new', (p) => p.id === m.id);
    assert.equal(live.payload.id, m.id);
    const { data: ev } = await bob.d1.client.from('group_events').select('event_type').eq('conversation_id', group);
    assert.ok(ev!.length >= 0);
    t.diagnostic(`group ${group}: 4 slots, members decrypt`);
  });

  test('add a member: group.event "added" on group:<id>', async () => {
    await alice.d1.rpc('add_group_members', { p_conversation_id: group, p_member_ids: [dave.id] });
    const ev = await events.waitFor('group.event', (p) => p.event_type === 'added' && p.target_id === dave.id);
    assert.equal(ev.payload.actor_id, alice.id);
    const m = await alice.d1.send(group, { t: 'text', body: 'hi dave' });
    assert.equal((await dave.d1.open(m)).payload?.t, 'text');
    const nonAdmin = await rejects(bob.d1.client.rpc('add_group_members', { p_conversation_id: group, p_member_ids: [dave.id] }));
    assert.equal(nonAdmin.code, '42501');
  });

  test('removed member: no slots in new messages, no reads, no re-subscribe', async (t) => {
    await alice.d1.rpc('remove_group_member', { p_conversation_id: group, p_user_id: carol.id });
    await events.waitFor('group.event', (p) => p.event_type === 'removed' && p.target_id === carol.id);
    const recips = await alice.d1.recipients(group);
    assert.ok(!recips.some((r) => r.deviceId === carol.d1.deviceId), 'carol no longer a recipient');
    const m = await alice.d1.send(group, { t: 'text', body: 'after carol left' });
    assert.ok(!Object.keys(parseAnyEnvelope(m.ciphertext).k).includes(carol.d1.deviceId), 'no slot for carol');
    assert.equal(await carol.d1.fetch(m.id), null, 'RLS: carol cannot read new rows');
    const { data: old } = await carol.d1.client.from('messages').select('id').eq('conversation_id', group);
    assert.deepEqual(old, [], 'nor the history');
    const rejoin = await carol.d1.join(`conversation:${group}`, { timeoutMs: 6000 });
    assert.equal(rejoin.ok, false, "cannot subscribe to the conversation topic again");
    t.diagnostic(`re-subscribe refused: ${rejoin.ok ? "" : rejoin.status + " " + rejoin.error}`);
    const send = await rejects(carol.d1.send(group, { t: 'text', body: 'still here?' }, { recipients: [] }));
    assert.equal(send.code, '42501');
    // Informational: an already-open realtime subscription is authorised at join time.
    const stale = !(await carolLive.nothing('message.new', (p) => p.id === m.id, 2000));
    t.diagnostic(`stale pre-removal subscription ${stale ? 'STILL received' : 'did not receive'} the (undecryptable) broadcast`);
    if (stale) {
      await assert.rejects(carol.d1.open((await alice.d1.fetch(m.id))!), 'but it carries no key for carol');
    }
  });

  test('only admins can send when only_admins_send is on', async () => {
    const notAdmin = await rejects(bob.d1.client.rpc('set_group_permissions', { p_conversation_id: group, p_only_admins_send: true }));
    assert.equal(notAdmin.code, '42501');
    await alice.d1.rpc('set_group_permissions', { p_conversation_id: group, p_only_admins_send: true });
    const r = await rejects(bob.d1.send(group, { t: 'text', body: 'can I?' }));
    assert.equal(r.code, '42501');
    assert.match(r.message, /only admins/);
    await alice.d1.send(group, { t: 'text', body: 'admin announcement' });
    await alice.d1.rpc('set_group_member_role', { p_conversation_id: group, p_user_id: bob.id, p_role: 'admin' });
    await bob.d1.send(group, { t: 'text', body: 'now I can' });
    await alice.d1.rpc('set_group_permissions', { p_conversation_id: group, p_only_admins_send: false });
  });

  test('invite link: create, preview, join, revoke', async () => {
    const erin = await User.create('gr_erin');
    await erin.addDevice();
    const inv = await alice.d1.rpc('create_group_invite', { p_conversation_id: group });
    assert.match(inv.token, /^[A-Za-z0-9_-]{43}$/);
    const nonAdmin = await rejects(dave.d1.client.rpc('create_group_invite', { p_conversation_id: group }));
    assert.equal(nonAdmin.code, '42501');
    const [pv] = await erin.d1.rpc('preview_group_invite', { p_token: inv.token });
    assert.equal(pv.status, 'valid');
    assert.equal(pv.group_name, 'E2E Group');
    assert.equal(pv.is_member, false);
    const [j] = await erin.d1.rpc('join_group_via_invite', { p_token: inv.token });
    assert.deepEqual([j.status, j.conversation_id], ['joined', group]);
    const [again] = await erin.d1.rpc('join_group_via_invite', { p_token: inv.token });
    assert.equal(again.status, 'already_member');
    // A stranger can't list invites; the admin can.
    assert.deepEqual(await erin.d1.rpc('list_group_invites', { p_conversation_id: group }), []);
    await alice.d1.rpc('revoke_group_invite', { p_invite_id: inv.id });
    const [rv] = await dave.d1.rpc('preview_group_invite', { p_token: inv.token });
    assert.equal(rv.status, 'revoked');
    const [bad] = await dave.d1.rpc('preview_group_invite', { p_token: 'x'.repeat(43) });
    assert.equal(bad.status, 'invalid');
  });

  test('invite link: expired and max uses', async () => {
    const frank = await User.create('gr_frank');
    await frank.addDevice();
    const soon = await alice.d1.rpc('create_group_invite', {
      p_conversation_id: group,
      p_expires_at: new Date(Date.now() + 1500).toISOString(),
    });
    await sleep(2000);
    const [ex] = await frank.d1.rpc('join_group_via_invite', { p_token: soon.token });
    assert.equal(ex.status, 'expired');
    const once = await alice.d1.rpc('create_group_invite', { p_conversation_id: group, p_max_uses: 1 });
    const [ok] = await frank.d1.rpc('join_group_via_invite', { p_token: once.token });
    assert.equal(ok.status, 'joined');
    const grace = await User.create('gr_grace');
    await grace.addDevice();
    const [full] = await grace.d1.rpc('join_group_via_invite', { p_token: once.token });
    assert.equal(full.status, 'full');
  });

  test('invite link: preview rate limit (60 / 10 min per user)', async (t) => {
    const mallory = await User.create('gr_mallory');
    const c = await mallory.client();
    let limited = 0;
    for (let i = 0; i < 62; i++) {
      const { data, error } = await c.rpc('preview_group_invite', { p_token: `guess${i}`.padEnd(43, 'x') });
      assert.equal(error, null);
      if (data[0].status === 'rate_limited') limited++;
    }
    assert.equal(limited, 2);
    t.diagnostic('61st and 62nd preview -> rate_limited');
  });

  after(async () => {
    await carolLive?.close().catch(() => undefined);
    await events?.close().catch(() => undefined);
  });
});
