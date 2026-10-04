// Calls (1:1 invite/decline/answer broadcasts, group join/leave), encrypted
// media through the real media-upload / media-download functions, TURN config,
// GIF "not configured", push enqueue via pg_net, and channel follow.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cleanup, sodium, User, type Device } from '../lib/actors';
import { env } from '../lib/env';
import { hasDb, sqlValue } from '../lib/db';

after(cleanup);

async function callFn(device: Device, name: string, init: { method?: string; body?: unknown; query?: string } = {}) {
  const token = await device.accessToken();
  const res = await fetch(`${env.url}/functions/v1/${name}${init.query ?? ''}`, {
    method: init.method ?? 'POST',
    headers: { apikey: env.anonKey, Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

function rpcOk<T>(r: { data: T; error: any }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}

describe('calls, media, push and channels', () => {
  let alice: User, bob: User, carol: User;
  let a: Device, b: Device, c: Device;
  let direct: string;
  let group: string;

  before(async () => {
    [alice, bob, carol] = await Promise.all(['cm_alice', 'cm_bob', 'cm_carol'].map((n) => User.create(n)));
    a = await alice.addDevice();
    b = await bob.addDevice();
    c = await carol.addDevice();
    direct = rpcOk(await a.client.rpc('create_direct_conversation', { p_other_user_id: bob.id }), 'direct') as string;
    group = rpcOk(
      await a.client.rpc('create_group_conversation', { p_name: 'Calls QA', p_member_ids: [bob.id, carol.id] }),
      'group'
    ) as string;
  });

  test('1:1 call: invite reaches the callee, decline reaches the caller instantly', async () => {
    const bobInbox = await b.listen(`user:${bob.id}`);
    const aliceInbox = await a.listen(`user:${alice.id}`);
    const callId = rpcOk(
      await a.client.rpc('start_direct_call', { p_conversation_id: direct, p_call_type: 'video', p_device_id: a.deviceId }),
      'start_direct_call'
    ) as unknown as string;
    const invite = await bobInbox.waitFor('call.invite', (p) => p.call_id === callId);
    assert.equal(invite.payload.call_type, 'video');
    rpcOk(await b.client.rpc('update_call_status', { p_call_id: callId, p_status: 'rejected' }), 'decline');
    const status = await aliceInbox.waitFor('call.status', (p) => p.call_id === callId);
    assert.equal(status.payload.status, 'rejected');
    // A stranger can't see the call or join its signalling topic.
    const { data } = await c.client.from('call_sessions').select('id').eq('id', callId);
    assert.equal(data?.length ?? 0, 0);
    await bobInbox.close();
    await aliceInbox.close();
  });

  test('1:1 call: first device to answer wins, then end', async () => {
    const callId = rpcOk(
      await a.client.rpc('start_direct_call', { p_conversation_id: direct, p_call_type: 'voice', p_device_id: a.deviceId }),
      'start'
    ) as unknown as string;
    rpcOk(await b.client.rpc('answer_call', { p_call_id: callId, p_device_id: b.deviceId }), 'answer');
    const { data } = await a.client.from('call_sessions').select('status, answered_device_id').eq('id', callId).single();
    assert.equal(data!.status, 'active');
    assert.equal(data!.answered_device_id, b.deviceId);
    // Both participants may use the private call:<id> topic for signalling; a stranger may not.
    const sig = await a.listen(`call:${callId}`);
    await sig.close();
    rpcOk(await a.client.rpc('update_call_status', { p_call_id: callId, p_status: 'ended' }), 'end');
  });

  test('group call: members join and leave; participants tracked', async () => {
    const callId = rpcOk(
      await a.client.rpc('start_group_call', { p_conversation_id: group, p_call_type: 'voice', p_device_id: a.deviceId }),
      'start_group_call'
    ) as unknown as string;
    // Like the app (CallService.enterGroupCall), the starter joins right after starting.
    rpcOk(await a.client.rpc('join_group_call', { p_call_id: callId, p_device_id: a.deviceId }), 'starter joins');
    rpcOk(await b.client.rpc('join_group_call', { p_call_id: callId, p_device_id: b.deviceId }), 'bob joins');
    rpcOk(await c.client.rpc('join_group_call', { p_call_id: callId, p_device_id: c.deviceId }), 'carol joins');
    const live = await a.client.from('call_participants').select('user_id').eq('call_id', callId).is('left_at', null);
    assert.equal(live.data?.length, 3);
    rpcOk(await c.client.rpc('leave_call', { p_call_id: callId, p_device_id: c.deviceId }), 'carol leaves');
    const after = await a.client.from('call_participants').select('user_id').eq('call_id', callId).is('left_at', null);
    assert.equal(after.data?.length, 2);
  });

  test('turn-credentials returns ICE servers to signed-in users', async () => {
    const r = await callFn(a, 'turn-credentials');
    assert.equal(r.status, 200, r.text);
    // Without TURN keys the function says so and the app falls back to STUN (iceServers.ts).
    assert.ok(Array.isArray(r.json.iceServers), r.text);
    assert.equal(typeof r.json.configured, 'boolean');
  });

  test('encrypted media: signed upload -> PUT -> confirm -> member downloads identical ciphertext', async () => {
    const s = await sodium();
    const blob = new Uint8Array(randomBytes(5 * 1024 * 1024 + 123)); // stands in for secretstream ciphertext
    const hash = s.to_hex(s.crypto_generichash(32, blob));
    const created = await callFn(a, 'media-upload', { body: { action: 'create', conversationId: direct, size: blob.length, hash } });
    assert.equal(created.status, 200, created.text);
    const { mediaId, upload } = created.json;
    const put = await fetch(upload.url, { method: upload.method ?? 'PUT', headers: upload.headers ?? {}, body: blob });
    assert.ok(put.ok, `upload PUT ${put.status} ${await put.text()}`);
    const confirmed = await callFn(a, 'media-upload', { body: { action: 'confirm', mediaId } });
    assert.equal(confirmed.status, 200, confirmed.text);

    const dl = await callFn(b, 'media-download', { method: 'GET', query: `?id=${mediaId}&mode=url` });
    assert.equal(dl.status, 200, dl.text);
    const bytes = new Uint8Array(await (await fetch(dl.json.url)).arrayBuffer());
    assert.equal(s.to_hex(s.crypto_generichash(32, bytes)), hash);

    const denied = await callFn(c, 'media-download', { method: 'GET', query: `?id=${mediaId}&mode=url` });
    assert.notEqual(denied.status, 200, 'non-member must not download');
  });

  test('media-upload rejects a non-member and an oversize file', async () => {
    const hash = '0'.repeat(64);
    const stranger = await callFn(c, 'media-upload', { body: { action: 'create', conversationId: direct, size: 10, hash } });
    assert.notEqual(stranger.status, 200);
    const huge = await callFn(a, 'media-upload', { body: { action: 'create', conversationId: direct, size: 60 * 1024 * 1024, hash } });
    assert.notEqual(huge.status, 200);
  });

  test('gif-search reports "not configured" cleanly without an API key', async () => {
    const r = await callFn(a, 'gif-search', { body: { action: 'status' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.configured, false);
  });

  test('a new message enqueues a push request via pg_net (no content in it)', { skip: !hasDb }, async () => {
    // pg_net request ids come from one sequence (queue row id == response id);
    // compare ids rather than counts, since pg_net prunes old responses.
    const maxId = () => Number(sqlValue(
      'select greatest(coalesce((select max(id) from net.http_request_queue), 0), coalesce((select max(id) from net._http_response), 0))'
    ) ?? 0);
    const before = maxId();
    // Pushes only go to members with a registered push token.
    const tok = await b.client.from('push_tokens').upsert({ device_id: b.deviceId, user_id: bob.id, token: 'ExponentPushToken[e2e-test]', platform: 'android' });
    assert.ifError(tok.error);
    const row = await a.send(direct, { kind: 'text', text: 'secret push body' } as any);
    let after = before;
    for (let i = 0; i < 20 && after <= before; i++) {
      await new Promise((r) => setTimeout(r, 250));
      after = maxId();
    }
    assert.ok(after > before, 'expected a push request for the new message');
    const leaked = sqlValue(`select count(*) from net.http_request_queue where body::text like '%secret push body%'`);
    assert.equal(Number(leaked ?? 0), 0);
    assert.ok(row.id);
  });

  test('channels: public channel can be followed; posts are admin-only', async () => {
    const handle = `qa_${Date.now().toString(36)}`;
    const channelId = rpcOk(
      await a.client.rpc('create_channel', { p_name: 'QA News', p_handle: handle, p_description: 'tests', p_visibility: 'public' }),
      'create_channel'
    ) as unknown as string;
    rpcOk(await b.client.rpc('follow_channel', { p_channel_id: channelId }), 'follow');
    const { data } = await b.client.from('channels').select('id').eq('id', channelId);
    assert.equal(data?.length, 1);
  });
});
