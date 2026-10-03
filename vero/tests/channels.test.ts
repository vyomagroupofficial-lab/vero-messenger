import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReactionChange,
  channelMediaPath,
  CHANNELS_E2EE_NOTICE,
  followersLabel,
  formatCount,
  isValidHandle,
  mergePosts,
  normalizeHandle,
  parseChannelPost,
  sortedReactions,
  suggestHandle,
  totalReactions,
} from '../src/features/channels/channelUtils';
import { ChannelApi, createChannelsStore } from '../src/features/channels/channelsStore';
import type { ChannelPost, ChannelSummary } from '../src/features/channels/types';
import { communityGroupAction, parseCommunity, parseCommunityGroup } from '../src/features/communities/types';
import { CommunityApi, createCommunitiesStore } from '../src/features/communities/communitiesStore';

test('channel posts are labelled as not end-to-end encrypted', () => {
  assert.match(CHANNELS_E2EE_NOTICE, /aren't end-to-end encrypted/);
});

test('handles normalise like the server', () => {
  assert.equal(normalizeHandle('@Trail News!'), 'trail_news');
  assert.equal(normalizeHandle('  my-channel  '), 'my_channel');
  assert.equal(normalizeHandle('x'.repeat(40)).length, 32);
  assert.ok(isValidHandle('trail_news'));
  assert.ok(!isValidHandle('ab'));
  assert.ok(!isValidHandle('Trail'));
  assert.ok(!isValidHandle('a b c'));
  assert.equal(suggestHandle('Hi'), 'hi_channel');
  assert.equal(suggestHandle('  Mountain   Club  '), 'mountain_club');
});

test('follower counts are compact', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1234), '1.2K');
  assert.equal(formatCount(34_567), '34K');
  assert.equal(formatCount(1_500_000), '1.5M');
  assert.equal(formatCount(-5), '0');
  assert.equal(followersLabel(1), '1 follower');
  assert.equal(followersLabel(2), '2 followers');
});

test('reaction counts: one reaction per user, like the server trigger', () => {
  let c = applyReactionChange({}, null, '👍');
  assert.deepEqual(c, { '👍': 1 });
  c = applyReactionChange({ '👍': 2 }, '👍', '🔥');
  assert.deepEqual(c, { '👍': 1, '🔥': 1 });
  c = applyReactionChange({ '👍': 1, '🔥': 1 }, '🔥', null);
  assert.deepEqual(c, { '👍': 1 });
  const same = { '👍': 1 };
  assert.equal(applyReactionChange(same, '👍', '👍'), same);
  assert.deepEqual(sortedReactions({ a: 1, b: 3, c: 0 }), [
    { emoji: 'b', count: 3 },
    { emoji: 'a', count: 1 },
  ]);
  assert.equal(totalReactions({ a: 2, b: 3 }), 5);
});

test('post rows are parsed defensively', () => {
  assert.equal(parseChannelPost(null), null);
  assert.equal(parseChannelPost({ id: 1 }), null);
  const p = parseChannelPost({
    id: 'p1',
    channel_id: 'c1',
    body: 'hi',
    reaction_counts: { '👍': 2, bad: 'x', neg: -1, ['x'.repeat(20)]: 1 },
    created_at: '2026-01-01T00:00:00Z',
    author_id: 'leaked?',
  })!;
  assert.deepEqual(p.reactionCounts, { '👍': 2 });
  assert.equal((p as any).author_id, undefined);
});

test('posts merge newest-first without duplicates', () => {
  const a = parseChannelPost({ id: 'a', channel_id: 'c', body: 'a', created_at: '2026-01-01T00:00:00Z' })!;
  const b = parseChannelPost({ id: 'b', channel_id: 'c', body: 'b', created_at: '2026-01-02T00:00:00Z' })!;
  const a2 = { ...a, body: 'edited' };
  const merged = mergePosts([a], [b, a2]);
  assert.deepEqual(merged.map((p) => p.id), ['b', 'a']);
  assert.equal(merged[1].body, 'edited');
});

test('media paths stay inside the channel folder', () => {
  assert.equal(channelMediaPath('c1', 'image/png', 'abc'), 'c1/abc.png');
  assert.equal(channelMediaPath('c1', 'image/jpeg', '../../x'), 'c1/x.jpg');
});

// ── Channels store ───────────────────────────────────────────────────────────

function channel(over: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id: 'c1',
    handle: 'trail_news',
    name: 'Trail News',
    description: null,
    avatarData: null,
    visibility: 'public',
    followerCount: 10,
    myRole: null,
    isFollowing: false,
    muted: false,
    lastPostAt: null,
    ...over,
  };
}

function post(id: string, created: string, counts: Record<string, number> = {}): ChannelPost {
  return { id, channelId: 'c1', body: id, mediaPath: null, mediaMime: null, reactionCounts: counts, createdAt: created, editedAt: null };
}

function fakeChannelApi() {
  const calls: string[] = [];
  let failReact = false;
  const api: ChannelApi = {
    myChannels: async () => [],
    search: async (q) => (q === 'slow' ? new Promise((r) => setTimeout(() => r([channel({ id: 'slow' })]), 20)) : [channel()]),
    getDetails: async () => channel(),
    loadPosts: async (_id, before) =>
      before ? { posts: [post('p0', '2026-01-01T00:00:00Z')], hasMore: false } : { posts: [post('p2', '2026-01-03T00:00:00Z', { '👍': 1 }), post('p1', '2026-01-02T00:00:00Z')], hasMore: true },
    myReactions: async () => ({ p2: '👍' }),
    follow: async () => void calls.push('follow'),
    unfollow: async () => void calls.push('unfollow'),
    setMuted: async () => void calls.push('mute'),
    react: async (_p, e) => {
      calls.push(`react:${e}`);
      if (failReact) throw new Error('post not found');
    },
    publish: async (_id, body) => ({ ...post('p3', '2026-01-04T00:00:00Z'), body }),
    deletePost: async () => void calls.push('delete'),
  };
  return { api, calls, setFailReact: (v: boolean) => (failReact = v), store: createChannelsStore(api) };
}

test('channels store opens a feed, pages older posts and knows my reactions', async () => {
  const f = fakeChannelApi();
  await f.store.getState().open('c1');
  assert.deepEqual(f.store.getState().posts.c1.map((p) => p.id), ['p2', 'p1']);
  assert.equal(f.store.getState().myReactions.p2, '👍');
  await f.store.getState().loadOlder('c1');
  assert.deepEqual(f.store.getState().posts.c1.map((p) => p.id), ['p2', 'p1', 'p0']);
  assert.equal(f.store.getState().hasMore.c1, false);
});

test('channels store: tapping your own reaction removes it; failures roll back', async () => {
  const f = fakeChannelApi();
  await f.store.getState().open('c1');
  await f.store.getState().react('c1', 'p2', '👍');
  assert.deepEqual(f.store.getState().posts.c1[0].reactionCounts, {});
  assert.equal(f.store.getState().myReactions.p2, undefined);
  assert.ok(f.calls.includes('react:null'));

  await f.store.getState().react('c1', 'p1', '🔥');
  assert.deepEqual(f.store.getState().posts.c1[1].reactionCounts, { '🔥': 1 });

  f.setFailReact(true);
  await assert.rejects(f.store.getState().react('c1', 'p1', '😂'));
  assert.deepEqual(f.store.getState().posts.c1[1].reactionCounts, { '🔥': 1 }, 'rolled back');
  assert.equal(f.store.getState().myReactions.p1, '🔥');
});

test('channels store: follow/unfollow/mute are optimistic', async () => {
  const f = fakeChannelApi();
  await f.store.getState().open('c1');
  await f.store.getState().follow('c1');
  assert.equal(f.store.getState().channels.c1!.isFollowing, true);
  assert.equal(f.store.getState().channels.c1!.followerCount, 11);
  await f.store.getState().setMuted('c1', true);
  assert.equal(f.store.getState().channels.c1!.muted, true);
  await f.store.getState().unfollow('c1');
  assert.equal(f.store.getState().channels.c1!.isFollowing, false);
  assert.equal(f.store.getState().channels.c1!.followerCount, 10);
});

test('channels store applies realtime broadcasts', async () => {
  const f = fakeChannelApi();
  await f.store.getState().open('c1');
  const s = () => f.store.getState();
  s().applyRealtime('c1', 'post.new', { id: 'p9', channel_id: 'c1', body: 'live', created_at: '2026-02-01T00:00:00Z' });
  assert.equal(s().posts.c1[0].id, 'p9');
  s().applyRealtime('c1', 'post.new', { id: 'px', channel_id: 'OTHER', body: 'x', created_at: '2026-03-01T00:00:00Z' });
  assert.ok(!s().posts.c1.some((p) => p.id === 'px'), 'posts for other channels are ignored');
  s().applyRealtime('c1', 'post.reactions', { id: 'p9', reaction_counts: { '❤️': 4 } });
  assert.deepEqual(s().posts.c1[0].reactionCounts, { '❤️': 4 });
  s().applyRealtime('c1', 'post.updated', { id: 'p9', channel_id: 'c1', body: 'edited', created_at: '2026-02-01T00:00:00Z', edited_at: '2026-02-02T00:00:00Z' });
  assert.equal(s().posts.c1[0].body, 'edited');
  s().applyRealtime('c1', 'post.deleted', { id: 'p9' });
  assert.ok(!s().posts.c1.some((p) => p.id === 'p9'));
  s().applyRealtime('c1', 'channel.deleted', {});
  assert.equal(s().deleted.c1, true);
});

test('channels store ignores out-of-order search results', async () => {
  const f = fakeChannelApi();
  const slow = f.store.getState().search('slow');
  await f.store.getState().search('fast');
  await slow;
  assert.equal(f.store.getState().directory[0].id, 'c1');
});

// ── Communities ──────────────────────────────────────────────────────────────

test('community rows and join actions', () => {
  assert.equal(parseCommunity({ id: 'x', name: 'N', my_role: 'hacker' })!.myRole, null);
  const g = parseCommunityGroup({ conversation_id: 'g', group_name: 'G', member_count: 3 })!;
  assert.equal(communityGroupAction(g), 'join');
  assert.equal(communityGroupAction({ ...g, joinApprovalRequired: true }), 'request');
  assert.equal(communityGroupAction({ ...g, joinApprovalRequired: true, hasPendingRequest: true }), 'requested');
  assert.equal(communityGroupAction({ ...g, isMember: true }), 'open');
});

test('communities store updates group membership state after joining', async () => {
  const groups = [
    parseCommunityGroup({ conversation_id: 'open', group_name: 'Open', member_count: 2 })!,
    parseCommunityGroup({ conversation_id: 'closed', group_name: 'Closed', member_count: 2, join_approval_required: true })!,
  ];
  const api: CommunityApi = {
    mine: async () => [],
    details: async (id) => parseCommunity({ id, name: 'C', my_role: 'member' }),
    groups: async () => groups.map((g) => ({ ...g })),
    members: async () => [],
    create: async () => 'new',
    linkGroup: async () => undefined,
    unlinkGroup: async () => undefined,
    createGroup: async () => 'g-new',
    joinGroup: async (_c, conv) => ({ status: conv === 'open' ? 'joined' : 'requested', requestId: null }),
    setRole: async () => undefined,
    removeMember: async () => undefined,
    leave: async () => undefined,
    remove: async () => undefined,
  };
  const store = createCommunitiesStore(api);
  await store.getState().open('k');
  assert.equal(await store.getState().joinGroup('k', 'open'), 'joined');
  assert.equal(await store.getState().joinGroup('k', 'closed'), 'requested');
  const [open, closed] = store.getState().groups.k;
  assert.ok(open.isMember && open.memberCount === 3);
  assert.ok(!closed.isMember && closed.hasPendingRequest);
  await store.getState().unlinkGroup('k', 'open');
  assert.equal(store.getState().groups.k.length, 1);
  await store.getState().leave('k');
  assert.equal(store.getState().details.k, undefined);
});
