import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInviteUrl,
  expiryFromNow,
  inviteState,
  inviteStatusMessage,
  isValidInviteToken,
  normalizeInviteHost,
  parseInviteLink,
} from '../src/features/groups/inviteLinks';
import { describeGroupEvent, groupEventToMessage, parseGroupEvent } from '../src/features/groups/groupEvents';
import {
  canChangeRole,
  canEditInfo,
  canRemoveMember,
  canSendMessages,
  sortMembers,
} from '../src/features/groups/permissions';
import { createGroupStore, GroupApi } from '../src/features/groups/groupStore';
import { DEFAULT_GROUP_SETTINGS, GroupDetails, GroupInvite } from '../src/features/groups/types';

const TOKEN = 'Ab3_-xYz0123456789abcdefghijklmnopqrstuvwx'; // 42 chars
const TOKEN43 = 'x43FfTxiRPq8Uwq9T0TkYAZxdADtvk8HqKiQABKdO1Y';

// ── Invite links ─────────────────────────────────────────────────────────────

test('token validation matches the server format', () => {
  assert.ok(isValidInviteToken(TOKEN43));
  assert.ok(isValidInviteToken('a'.repeat(22)));
  assert.ok(!isValidInviteToken('a'.repeat(21)));
  assert.ok(!isValidInviteToken('a'.repeat(65)));
  assert.ok(!isValidInviteToken('abc def ghi jkl mno pqr stu'));
  assert.ok(!isValidInviteToken('../../../etc/passwd/aaaaaaaaaa'));
  assert.ok(!isValidInviteToken(undefined));
});

test('invite URLs use https when a host is configured, else the app scheme', () => {
  assert.equal(buildInviteUrl(TOKEN43), `vero://join/${TOKEN43}`);
  assert.equal(buildInviteUrl(TOKEN43, 'Vero.Example.com/'), `https://vero.example.com/join/${TOKEN43}`);
  assert.equal(buildInviteUrl(TOKEN43, 'https://vero.example.com'), `https://vero.example.com/join/${TOKEN43}`);
  assert.equal(buildInviteUrl(TOKEN43, 'not a host'), `vero://join/${TOKEN43}`);
  assert.throws(() => buildInviteUrl('short'));
});

test('host normalisation', () => {
  assert.equal(normalizeInviteHost(''), null);
  assert.equal(normalizeInviteHost(undefined), null);
  assert.equal(normalizeInviteHost('localhost'), null);
  assert.equal(normalizeInviteHost('join.vero.app:8443'), 'join.vero.app:8443');
  assert.equal(normalizeInviteHost('evil.com/path'), null);
});

test('deep links of every supported shape parse to the token', () => {
  for (const link of [
    TOKEN,
    `  ${TOKEN}  `,
    `vero://join/${TOKEN}`,
    `vero:///join/${TOKEN}`,
    `VERO://join/${TOKEN}/`,
    `https://vero.example.com/join/${TOKEN}`,
    `https://vero.example.com/join/${TOKEN}?utm=1#x`,
    `http://vero.example.com/join/${TOKEN}`,
    `vero.example.com/join/${TOKEN}`,
    `/join/${TOKEN}`,
    `exp://192.168.1.2:8081/--/join/${TOKEN}`,
  ]) {
    assert.equal(parseInviteLink(link), TOKEN, link);
  }
});

test('non-invite or hostile links are rejected', () => {
  for (const link of [
    '',
    null,
    'hello',
    `vero://chat/${TOKEN}`,
    `https://vero.example.com/join/short`,
    `https://vero.example.com/join/${TOKEN}%2F..`,
    `javascript://join/${TOKEN}`,
    `ftp://vero.example.com/join/${TOKEN}`,
    `https://vero.example.com/join/${'a'.repeat(70)}`,
  ]) {
    assert.equal(parseInviteLink(link as any), null, String(link));
  }
});

test('https links can be pinned to the configured host', () => {
  assert.equal(parseInviteLink(`https://vero.example.com/join/${TOKEN}`, 'vero.example.com'), TOKEN);
  assert.equal(parseInviteLink(`https://phish.example.net/join/${TOKEN}`, 'vero.example.com'), null);
  assert.equal(parseInviteLink(`vero://join/${TOKEN}`, 'vero.example.com'), TOKEN);
});

test('invite state mirrors the server rules', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const base = { revokedAt: null, expiresAt: null, maxUses: null, uses: 0 };
  assert.equal(inviteState(base, now), 'active');
  assert.equal(inviteState({ ...base, revokedAt: '2025-12-31T00:00:00Z' }, now), 'revoked');
  assert.equal(inviteState({ ...base, expiresAt: '2025-12-31T23:59:59Z' }, now), 'expired');
  assert.equal(inviteState({ ...base, expiresAt: '2026-01-02T00:00:00Z' }, now), 'active');
  assert.equal(inviteState({ ...base, maxUses: 3, uses: 3 }, now), 'full');
  assert.equal(inviteState({ ...base, maxUses: 3, uses: 2 }, now), 'active');
  assert.equal(expiryFromNow(null), null);
  assert.equal(expiryFromNow(3600, now), '2026-01-01T01:00:00.000Z');
  assert.match(inviteStatusMessage('expired'), /expired/);
  assert.match(inviteStatusMessage('whatever'), /isn't valid/);
});

// ── Group events ─────────────────────────────────────────────────────────────

const names = { alice: 'Alice', bob: 'Bob' };
const ev = (over: Record<string, unknown>) =>
  parseGroupEvent({
    id: 'e1',
    conversation_id: 'c1',
    actor_id: 'alice',
    target_id: 'bob',
    event_type: 'added',
    details: {},
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  })!;

test('group events are described from the viewer\'s perspective', () => {
  assert.equal(describeGroupEvent(ev({}), names, 'carol'), 'Alice added Bob');
  assert.equal(describeGroupEvent(ev({}), names, 'alice'), 'You added Bob');
  assert.equal(describeGroupEvent(ev({}), names, 'bob'), 'Alice added you');
  assert.equal(describeGroupEvent(ev({ event_type: 'joined', actor_id: 'bob', details: { via: 'invite' } }), names, 'x'),
    'Bob joined using an invite link');
  assert.equal(describeGroupEvent(ev({ event_type: 'left', actor_id: 'bob' }), names, 'bob'), 'You left');
  assert.equal(describeGroupEvent(ev({ event_type: 'removed' }), names, 'x'), 'Alice removed Bob');
  assert.equal(describeGroupEvent(ev({ event_type: 'promoted' }), names, 'bob'), 'Alice made you an admin');
  assert.equal(describeGroupEvent(ev({ event_type: 'demoted' }), names, 'x'), 'Alice dismissed Bob as admin');
  assert.equal(describeGroupEvent(ev({ event_type: 'demoted', actor_id: 'bob' }), names, 'bob'), 'You are no longer an admin');
  assert.equal(describeGroupEvent(ev({ event_type: 'owner_changed' }), names, 'bob'), 'You are now the group owner');
  assert.equal(describeGroupEvent(ev({ event_type: 'renamed', target_id: null, details: { name: 'Hikers' } }), names, 'x'),
    'Alice renamed the group to "Hikers"');
  assert.equal(describeGroupEvent(ev({ event_type: 'added', details: { via: 'request' } }), names, 'alice'),
    "You approved bob's request to join".replace('bob', 'Bob'));
  assert.equal(describeGroupEvent(ev({ event_type: 'settings_changed', details: { only_admins_send: true } }), names, 'x'),
    'Alice changed group settings: only admins can send messages');
  assert.equal(describeGroupEvent(ev({ actor_id: 'zed', target_id: 'yan', actor: { display_name: 'Zed' } }), names, 'x'),
    'Zed added someone');
});

test('malformed event rows are dropped', () => {
  assert.equal(parseGroupEvent(null), null);
  assert.equal(parseGroupEvent({ id: 'e', conversation_id: 'c', event_type: 'pwned', created_at: 'x' }), null);
  assert.equal(parseGroupEvent({ id: 1, conversation_id: 'c', event_type: 'added', created_at: 'x' }), null);
});

test('events become idempotent, non-unread system messages', () => {
  const m = groupEventToMessage(ev({}), names, 'carol');
  assert.equal(m.id, 'e1');
  assert.equal(m.messageType, 'system');
  assert.equal(m.content, 'Alice added Bob');
  assert.equal(m.isOwn, true);
  assert.equal(m.status, 'read');
});

// ── Permissions ──────────────────────────────────────────────────────────────

test('send / edit permissions follow group settings', () => {
  const s = { ...DEFAULT_GROUP_SETTINGS };
  assert.ok(canSendMessages('member', s));
  assert.ok(!canSendMessages('member', { ...s, onlyAdminsSend: true }));
  assert.ok(canSendMessages('admin', { ...s, onlyAdminsSend: true }));
  assert.ok(canSendMessages('owner', { ...s, onlyAdminsSend: true }));
  assert.ok(!canSendMessages(null, s));
  assert.ok(!canSendMessages('owner', { ...s, deletedAt: 'x' }));
  assert.ok(!canEditInfo('member', s), 'default: only admins edit info');
  assert.ok(canEditInfo('member', { ...s, onlyAdminsEditInfo: false }));
  assert.ok(canEditInfo('admin', s));
});

test('role changes mirror the server rules', () => {
  const owner = { id: 'o', role: 'owner' as const };
  const admin = { id: 'a', role: 'admin' as const };
  const admin2 = { id: 'a2', role: 'admin' as const };
  const member = { id: 'm', role: 'member' as const };
  assert.ok(canChangeRole(admin, member, 'admin'), 'admins promote');
  assert.ok(!canChangeRole(member, member, 'admin'), 'members cannot promote');
  assert.ok(!canChangeRole(admin, admin2, 'member'), 'admins cannot dismiss admins');
  assert.ok(canChangeRole(owner, admin, 'member'), 'owner dismisses admins');
  assert.ok(canChangeRole(admin, admin, 'member'), 'admins may step down');
  assert.ok(!canChangeRole(admin, owner, 'member'), 'owner is untouchable');
  assert.ok(!canChangeRole(owner, member, 'member'), 'no-op change is not offered');
  assert.ok(canRemoveMember(admin, member));
  assert.ok(!canRemoveMember(admin, owner));
  assert.ok(!canRemoveMember(member, admin));
  assert.ok(!canRemoveMember(admin, admin), 'leave instead of removing yourself');
});

test('members sort owner, admins, members, then by name', () => {
  const sorted = sortMembers([
    { role: 'member' as const, displayName: 'Zoe' },
    { role: 'admin' as const, displayName: 'Bea' },
    { role: 'member' as const, displayName: 'Al' },
    { role: 'owner' as const, displayName: 'Yan' },
  ]);
  assert.deepEqual(sorted.map((m) => m.displayName), ['Yan', 'Bea', 'Al', 'Zoe']);
});

// ── Group store ──────────────────────────────────────────────────────────────

function fakeGroupApi(me: string) {
  const details: GroupDetails = {
    id: 'g1',
    name: 'Hikers',
    createdAt: '2026-01-01T00:00:00Z',
    settings: { ...DEFAULT_GROUP_SETTINGS },
    community: null,
    members: [
      { id: 'o', username: 'o', displayName: 'Olive', role: 'owner', joinedAt: '' },
      { id: 'm', username: 'm', displayName: 'Mia', role: 'member', joinedAt: '' },
    ],
  };
  const calls: string[] = [];
  let invites: GroupInvite[] = [];
  let failPermissions = false;
  const api: GroupApi = {
    getDetails: async () => structuredClone(details),
    updateInfo: async (_id, p) => {
      calls.push('updateInfo');
      if (p.name) details.name = p.name;
    },
    setPermissions: async (_id, p) => {
      calls.push('setPermissions');
      if (failPermissions) throw new Error('only group admins can change group settings');
      Object.assign(details.settings, p);
    },
    addMembers: async () => void calls.push('addMembers'),
    removeMember: async (_id, uid) => {
      calls.push('removeMember');
      details.members = details.members.filter((m) => m.id !== uid);
    },
    setRole: async (_id, uid, role) => {
      calls.push('setRole');
      details.members = details.members.map((m) => (m.id === uid ? { ...m, role } : m));
    },
    transferOwnership: async () => void calls.push('transfer'),
    leave: async () => void calls.push('leave'),
    deleteGroup: async () => void calls.push('delete'),
    listInvites: async () => {
      calls.push('listInvites');
      return invites;
    },
    createInvite: async (_id, opts) => {
      const inv: GroupInvite = {
        id: `i${invites.length + 1}`,
        conversationId: 'g1',
        token: TOKEN43,
        createdAt: '',
        expiresAt: expiryFromNow(opts.expiresInSeconds),
        maxUses: opts.maxUses,
        uses: 0,
        requiresApproval: opts.requiresApproval,
        revokedAt: null,
      };
      invites = [inv, ...invites];
      return inv;
    },
    revokeInvite: async () => void calls.push('revoke'),
    listPendingRequests: async () => {
      calls.push('listRequests');
      return [{ id: 'r1', conversationId: 'g1', userId: 'x', via: 'invite', status: 'pending', createdAt: '' }];
    },
    decideRequest: async () => void calls.push('decide'),
  };
  return {
    api,
    calls,
    setFail: (v: boolean) => (failPermissions = v),
    store: createGroupStore(api, () => me),
  };
}

test('group store loads details and only fetches admin data for admins', async () => {
  const asMember = fakeGroupApi('m');
  await asMember.store.getState().load('g1');
  assert.equal(asMember.store.getState().myRole('g1'), 'member');
  assert.ok(!asMember.calls.includes('listInvites'), 'members never ask for invites');
  assert.deepEqual(asMember.store.getState().invites.g1, []);

  const asOwner = fakeGroupApi('o');
  await asOwner.store.getState().load('g1');
  assert.equal(asOwner.store.getState().myRole('g1'), 'owner');
  assert.ok(asOwner.calls.includes('listInvites') && asOwner.calls.includes('listRequests'));
  assert.equal(asOwner.store.getState().requests.g1.length, 1);
});

test('group store permission toggles are optimistic and roll back on refusal', async () => {
  const f = fakeGroupApi('o');
  await f.store.getState().load('g1');
  await f.store.getState().setPermissions('g1', { onlyAdminsSend: true });
  assert.equal(f.store.getState().details.g1!.settings.onlyAdminsSend, true);

  f.setFail(true);
  await assert.rejects(f.store.getState().setPermissions('g1', { onlyAdminsSend: false }));
  assert.equal(f.store.getState().details.g1!.settings.onlyAdminsSend, true, 'reverted');
  assert.match(f.store.getState().errors.g1 ?? '', /admins/);
});

test('group store mutations re-read server state; invites and requests update locally', async () => {
  const f = fakeGroupApi('o');
  await f.store.getState().load('g1');
  await f.store.getState().setRole('g1', 'm', 'admin');
  assert.equal(f.store.getState().details.g1!.members.find((m) => m.id === 'm')!.role, 'admin');

  const inv = await f.store.getState().createInvite('g1', { expiresInSeconds: 86400, maxUses: 1, requiresApproval: false });
  assert.equal(f.store.getState().invites.g1[0].id, inv.id);
  await f.store.getState().revokeInvite('g1', inv.id);
  assert.ok(f.store.getState().invites.g1[0].revokedAt);

  await f.store.getState().decideRequest('g1', 'r1', false);
  assert.equal(f.store.getState().requests.g1.length, 0);

  await f.store.getState().leave('g1');
  assert.equal(f.store.getState().details.g1, undefined, 'left groups are forgotten');
});
