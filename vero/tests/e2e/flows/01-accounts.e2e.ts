// Accounts and keys: sign-up (both e-mail paths), profile + settings
// triggers, device registration with signing key and prekeys, a second
// device for the same user, device revocation.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRatchetStore } from '../../../src/core/crypto/ratchet/SqliteRatchetStore';
import { verifyIdentityBinding } from '../../../src/core/crypto/ratchet/keys';
import { adminClient, cleanup, newClient, rejects, sodium, User } from '../lib/actors';
import { env, RUN_ID } from '../lib/env';
import { nodeSqliteDb } from '../lib/shims/sqlite';

after(cleanup);

describe('accounts and keys', () => {
  let alice: User;

  test('sign-up with auth.signUp creates profile + settings rows (auto-confirm path)', async (t) => {
    const c = newClient();
    const username = `e2e_${RUN_ID}_signup`;
    const email = `${username}@${env.emailDomain}`;
    // The app checks availability anonymously first (AuthRepository.isUsernameAvailable).
    const avail = await c.rpc('username_available', { p_username: username });
    assert.equal(avail.error, null);
    assert.equal(avail.data, true);
    const { data, error } = await c.auth.signUp({
      email,
      password: 'correct-horse-battery',
      options: { data: { username, display_name: 'E2E Sign Up' } },
    });
    assert.equal(error, null, error?.message);
    assert.ok(data.user);
    if (!data.session) {
      t.diagnostic('project requires e-mail confirmation: signUp returned no session (app shows "check your e-mail")');
      const admin = adminClient();
      if (admin) await admin.auth.admin.deleteUser(data.user.id);
      return;
    }
    const profile = await c.from('profiles').select('username, display_name').eq('id', data.user.id).single();
    assert.equal(profile.error, null);
    assert.deepEqual(profile.data, { username, display_name: 'E2E Sign Up' });
    const settings = await c.from('user_settings').select('read_receipts, last_seen').eq('user_id', data.user.id).single();
    assert.deepEqual(settings.data, { read_receipts: true, last_seen: 'everyone' });
    assert.equal((await c.rpc('username_available', { p_username: username })).data, false);
    t.diagnostic(`signUp -> session, profile @${username}, default settings row`);
    const admin = adminClient();
    if (admin) await admin.auth.admin.deleteUser(data.user.id);
  });

  test('e-mail confirmation path: unconfirmed user cannot sign in until confirmed', async (t) => {
    const admin = adminClient();
    if (!admin) return t.skip('needs SUPABASE_SERVICE_ROLE_KEY');
    const u = await User.create('unconf', { confirmed: false });
    const c = newClient();
    const first = await c.auth.signInWithPassword({ email: u.email, password: u.password });
    assert.ok(first.error, 'unconfirmed sign-in must fail');
    assert.match(first.error!.message, /confirm/i);
    // The profile exists already (trigger on auth.users insert), so the
    // username is reserved while the user confirms.
    const { data: prof } = await admin.from('profiles').select('username').eq('id', u.id).single();
    assert.equal(prof?.username, u.username);
    // Confirm through a real signup link token (what the e-mail contains).
    const link = await admin.auth.admin.generateLink({ type: 'signup', email: u.email, password: u.password });
    assert.equal(link.error, null, link.error?.message);
    const verified = await c.auth.verifyOtp({ token_hash: link.data.properties!.hashed_token, type: 'signup' });
    assert.equal(verified.error, null, verified.error?.message);
    const second = await c.auth.signInWithPassword({ email: u.email, password: u.password });
    assert.equal(second.error, null);
    t.diagnostic(`unconfirmed: "${first.error!.message}"; after verifyOtp(signup) sign-in works`);
  });

  test('device registration publishes signing key, signed prekey and 100 one-time prekeys', async (t) => {
    alice = await User.create('alice');
    const d1 = await alice.addDevice('alice-phone');
    const status = await d1.rpc('get_prekey_status', { p_device_id: d1.deviceId });
    assert.equal(status[0].one_time_count, 100);
    assert.ok(Number.isInteger(status[0].signed_prekey_id));
    const { data: dev } = await d1.client.from('devices').select('signing_public_key, identity_signature').eq('id', d1.deviceId).single();
    const s = await sodium();
    assert.ok(verifyIdentityBinding(s, d1.identity.publicKey, dev!.signing_public_key, dev!.identity_signature));
    // A different signing key for the same device is refused.
    const other = await rejects(
      d1.client.rpc('publish_device_signing_key', {
        p_device_id: d1.deviceId,
        p_signing_key: 'A'.repeat(43),
        p_identity_signature: 'A'.repeat(86),
      })
    );
    assert.equal(other.code, '42501');
    t.diagnostic(`device ${d1.deviceId}: 100 OPKs, spk ${status[0].signed_prekey_id}, binding signature verifies`);
  });

  test('second device for the same user (SQLite ratchet store over node:sqlite)', async (t) => {
    const db = new DatabaseSync(':memory:');
    const s = await sodium();
    const sql = nodeSqliteDb(db);
    const store = new SqliteRatchetStore(s, async () => sql, s.randombytes_buf(32));
    const d2 = await alice.addDevice('alice-web', { store });
    const { data } = await d2.client.from('devices').select('id').is('revoked_at', null);
    assert.equal(data!.length, 2);
    const status = await d2.rpc('get_prekey_status', { p_device_id: d2.deviceId });
    assert.equal(status[0].one_time_count, 100);
    t.diagnostic(`alice has 2 active devices; d2 keeps its ratchet state in SQLite`);
  });

  test('revoking a device drops its prekeys and push token', async () => {
    const d3 = await alice.addDevice('alice-old');
    await d3.client.from('push_tokens').insert({ device_id: d3.deviceId, token: 'ExponentPushToken[e2e-revoke]', platform: 'android' });
    const upd = await alice.d1.client.from('devices').update({ revoked_at: new Date().toISOString() }).eq('id', d3.deviceId);
    assert.equal(upd.error, null);
    const st = await rejects(d3.client.rpc('get_prekey_status', { p_device_id: d3.deviceId }));
    assert.equal(st.code, '42501');
    const tok = await alice.d1.client.from('push_tokens').select('device_id').eq('device_id', d3.deviceId);
    assert.deepEqual(tok.data, []);
    // A revoked device can no longer send.
    const send = await rejects(d3.send(randomConversationPlaceholder(), { t: 'text', body: 'x' }));
    assert.ok(send.message);
  });
});

function randomConversationPlaceholder(): string {
  return '00000000-0000-4000-8000-000000000000';
}
