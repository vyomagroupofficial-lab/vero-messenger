import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import sodiumModule from 'libsodium-wrappers';
import {
  Sodium,
  DecryptionError,
  NotAddressedToDeviceError,
  generateIdentityKeyPair,
  parseEnvelope,
} from '../src/core/crypto/primitives';
import { AudienceDevice, decryptStory, encryptStory, storyContext } from '../src/features/stories/storyCrypto';
import { DEFAULT_PRIVACY, normalizePrivacy, resolveAudience, StoryPrivacy } from '../src/features/stories/audience';
import {
  STORY_TTL_MS,
  expiresAtFor,
  isExpired,
  remainingMs,
  storyAgeLabel,
  timeLeftLabel,
} from '../src/features/stories/expiry';
import {
  currentStoryId,
  initViewer,
  isPaused,
  progressAt,
  viewerReducer,
  ViewerAction,
  ViewerState,
} from '../src/features/stories/viewerMachine';
import { firstUnseenIndex, orderTray } from '../src/features/stories/tray';
import { parseStoryPayload, storyPreview } from '../src/features/stories/payload';

let sodium: Sodium;
before(async () => {
  await sodiumModule.ready;
  sodium = sodiumModule as unknown as Sodium;
});

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const CAROL = 'cccccccc-0000-4000-8000-000000000003';
const DAVE = 'dddddddd-0000-4000-8000-000000000004';
const STORY = '51515151-0000-4000-8000-000000000001';

// ── audience ──────────────────────────────────────────────────────────────────

describe('audience resolution', () => {
  const contacts = [BOB, CAROL, DAVE, BOB, ALICE];
  const p = (patch: Partial<StoryPrivacy>): StoryPrivacy => ({ ...DEFAULT_PRIVACY, ...patch });

  test('"My contacts" = every contact, deduplicated, never myself', () => {
    assert.deepEqual(resolveAudience(contacts, p({}), ALICE), [BOB, CAROL, DAVE]);
  });

  test('"My contacts except…" removes the excluded people', () => {
    assert.deepEqual(resolveAudience(contacts, p({ audience: 'contacts_except', exceptUserIds: [DAVE] }), ALICE), [
      BOB,
      CAROL,
    ]);
  });

  test('"Only share with…" is limited to current contacts', () => {
    const stranger = 'eeeeeeee-0000-4000-8000-000000000005';
    assert.deepEqual(
      resolveAudience(contacts, p({ audience: 'only', onlyUserIds: [CAROL, stranger, ALICE] }), ALICE),
      [CAROL]
    );
    assert.deepEqual(resolveAudience(contacts, p({ audience: 'only', onlyUserIds: [] }), ALICE), []);
  });

  test('lists for other modes are ignored', () => {
    assert.deepEqual(resolveAudience(contacts, p({ audience: 'contacts', exceptUserIds: [BOB] }), ALICE), [
      BOB,
      CAROL,
      DAVE,
    ]);
  });

  test('synced rows are normalised defensively', () => {
    assert.deepEqual(
      normalizePrivacy({ audience: 'only', only_user_ids: [BOB, BOB, 3, ''], muted_user_ids: null }),
      { audience: 'only', exceptUserIds: [], onlyUserIds: [BOB], mutedUserIds: [] }
    );
    assert.equal(normalizePrivacy({ audience: 'everyone' }).audience, 'contacts');
  });
});

// ── expiry ────────────────────────────────────────────────────────────────────

describe('expiry math', () => {
  const created = Date.parse('2026-10-03T10:00:00.000Z');

  test('stories live exactly 24 hours', () => {
    assert.equal(STORY_TTL_MS, 86_400_000);
    assert.equal(expiresAtFor(created), '2026-10-04T10:00:00.000Z');
  });

  test('isExpired / remainingMs at the boundary', () => {
    const exp = expiresAtFor(created);
    assert.equal(isExpired(exp, created + STORY_TTL_MS - 1), false);
    assert.equal(isExpired(exp, created + STORY_TTL_MS), true);
    assert.equal(remainingMs(exp, created + STORY_TTL_MS - 1000), 1000);
    assert.equal(remainingMs(exp, created + STORY_TTL_MS + 5000), 0);
    assert.equal(isExpired('not a date', created), true);
  });

  test('labels', () => {
    assert.equal(storyAgeLabel(created, created + 30_000), 'Just now');
    assert.equal(storyAgeLabel(created, created + 12 * 60_000), '12m');
    assert.equal(storyAgeLabel(created, created + 5 * 3_600_000 + 1), '5h');
    assert.equal(timeLeftLabel(expiresAtFor(created), created + 60_000), '23h left');
    assert.equal(timeLeftLabel(expiresAtFor(created), created + STORY_TTL_MS - 10 * 60_000), '10m left');
    assert.equal(timeLeftLabel(expiresAtFor(created), created + STORY_TTL_MS), 'Expired');
  });
});

// ── envelope round-trip ───────────────────────────────────────────────────────

describe('story envelope (multi-device fan-out)', () => {
  function setup() {
    const keys = {
      alicePhone: generateIdentityKeyPair(sodium),
      aliceTablet: generateIdentityKeyPair(sodium),
      bobPhone: generateIdentityKeyPair(sodium),
      bobLaptop: generateIdentityKeyPair(sodium),
      carolPhone: generateIdentityKeyPair(sodium),
      dave: generateIdentityKeyPair(sodium),
    };
    const devices: AudienceDevice[] = [
      { userId: ALICE, deviceId: 'alice-phone', publicKey: keys.alicePhone.publicKey },
      { userId: ALICE, deviceId: 'alice-tablet', publicKey: keys.aliceTablet.publicKey },
      { userId: BOB, deviceId: 'bob-phone', publicKey: keys.bobPhone.publicKey },
      { userId: BOB, deviceId: 'bob-laptop', publicKey: keys.bobLaptop.publicKey },
      { userId: CAROL, deviceId: 'carol-phone', publicKey: keys.carolPhone.publicKey },
    ];
    const ctx = storyContext(ALICE, STORY, 'alice-phone');
    const payload = JSON.stringify({ t: 'story', kind: 'text', text: 'hello 24h world', bg: '#0E7490', font: 'serif' });
    const split = encryptStory(sodium, payload, ctx, keys.alicePhone.secretKey, ALICE, devices);
    return { keys, ctx, payload, split };
  }

  test('every device of every audience member (and the author) can decrypt', () => {
    const { keys, ctx, payload, split } = setup();
    const author = keys.alicePhone.publicKey;
    const open = (slots: Record<string, string> | null, device: string, sk: string) =>
      decryptStory(sodium, split.storyCiphertext, slots, ctx, device, sk, author);

    assert.equal(open(split.recipientSlots[BOB], 'bob-phone', keys.bobPhone.secretKey), payload);
    assert.equal(open(split.recipientSlots[BOB], 'bob-laptop', keys.bobLaptop.secretKey), payload);
    assert.equal(open(split.recipientSlots[CAROL], 'carol-phone', keys.carolPhone.secretKey), payload);
    // Author's other device reads the story row alone.
    assert.equal(open(null, 'alice-tablet', keys.aliceTablet.secretKey), payload);
    assert.equal(open(null, 'alice-phone', keys.alicePhone.secretKey), payload);
  });

  test('slots are split per user: the story row holds only the author devices', () => {
    const { split } = setup();
    assert.deepEqual(Object.keys(parseEnvelope(split.storyCiphertext).k).sort(), ['alice-phone', 'alice-tablet']);
    assert.deepEqual(Object.keys(split.recipientSlots).sort(), [BOB, CAROL].sort());
    assert.deepEqual(Object.keys(split.recipientSlots[BOB]).sort(), ['bob-laptop', 'bob-phone']);
    assert.ok(!split.storyCiphertext.includes('hello'), 'no plaintext on the server');
  });

  test('outsiders and swapped slots fail', () => {
    const { keys, ctx, split } = setup();
    const author = keys.alicePhone.publicKey;
    assert.throws(
      () => decryptStory(sodium, split.storyCiphertext, null, ctx, 'dave', keys.dave.secretKey, author),
      NotAddressedToDeviceError
    );
    // Carol can't use Bob's slots.
    assert.throws(
      () =>
        decryptStory(sodium, split.storyCiphertext, split.recipientSlots[BOB], ctx, 'carol-phone', keys.carolPhone.secretKey, author),
      NotAddressedToDeviceError
    );
  });

  test('a story is bound to its id, author and device', () => {
    const { keys, split } = setup();
    const author = keys.alicePhone.publicKey;
    const otherStory = storyContext(ALICE, '52525252-0000-4000-8000-000000000002', 'alice-phone');
    assert.throws(
      () => decryptStory(sodium, split.storyCiphertext, split.recipientSlots[BOB], otherStory, 'bob-phone', keys.bobPhone.secretKey, author),
      DecryptionError
    );
    // Same ids used as a *message* context must not open either.
    const asMessage = { conversationId: ALICE, messageId: STORY, senderDeviceId: 'alice-phone' };
    assert.throws(
      () => decryptStory(sodium, split.storyCiphertext, split.recipientSlots[BOB], asMessage, 'bob-phone', keys.bobPhone.secretKey, author),
      DecryptionError
    );
    // Forged author key.
    assert.throws(
      () =>
        decryptStory(sodium, split.storyCiphertext, split.recipientSlots[BOB], storyContext(ALICE, STORY, 'alice-phone'), 'bob-phone', keys.bobPhone.secretKey, keys.dave.publicKey),
      DecryptionError
    );
  });
});

// ── payload ───────────────────────────────────────────────────────────────────

describe('story payload', () => {
  test('parses text and media stories defensively', () => {
    const text = parseStoryPayload(JSON.stringify({ t: 'story', kind: 'text', text: 'hi', bg: 'red', font: 'comic' }));
    assert.deepEqual(text, { t: 'story', kind: 'text', text: 'hi', bg: '#0E7490', font: 'sans' });
    const media = { path: 'a/b/c.bin', key: 'k', nonce: 'n', hash: 'h', mimeType: 'video/mp4', size: 10, durationMs: 9000 };
    const video = parseStoryPayload(JSON.stringify({ t: 'story', kind: 'video', caption: 'beach', media }));
    assert.equal(video?.kind, 'video');
    assert.equal(storyPreview(video), '🎥 beach');
    assert.equal(parseStoryPayload(JSON.stringify({ t: 'story', kind: 'image', media })), null, 'mime must match kind');
    assert.equal(parseStoryPayload(JSON.stringify({ t: 'text', body: 'x' })), null);
    assert.equal(parseStoryPayload('{'), null);
    assert.equal(parseStoryPayload(JSON.stringify({ t: 'story', kind: 'text', text: '   ' })), null);
  });
});

// ── viewer state machine ──────────────────────────────────────────────────────

describe('viewer state machine', () => {
  const run = (s: ViewerState, ...actions: ViewerAction[]) => actions.reduce(viewerReducer, s);
  const groups = [['b1', 'b2'], ['c1'], ['d1', 'd2', 'd3']];

  test('waits for media, then auto-advances through stories and authors', () => {
    let s = initViewer(groups);
    assert.equal(currentStoryId(s), 'b1');
    s = run(s, { type: 'TICK', dt: 10_000 });
    assert.equal(s.elapsedMs, 0, 'clock does not run while loading');
    s = run(s, { type: 'READY', storyId: 'b1', durationMs: 5000 }, { type: 'TICK', dt: 2500 });
    assert.equal(progressAt(s, 0), 0.5);
    s = run(s, { type: 'TICK', dt: 2500 });
    assert.equal(currentStoryId(s), 'b2');
    assert.equal(progressAt(s, 0), 1);
    assert.equal(s.durationMs, null);
    s = run(s, { type: 'READY', storyId: 'b2', durationMs: 1000 }, { type: 'TICK', dt: 1000 });
    assert.deepEqual([s.group, s.index], [1, 0], 'moves on to the next author');
  });

  test('stale READY for a story that is no longer current is ignored', () => {
    let s = initViewer(groups);
    s = run(s, { type: 'NEXT' }, { type: 'READY', storyId: 'b1', durationMs: 5000 });
    assert.equal(s.durationMs, null);
  });

  test('tap left / right', () => {
    let s = initViewer(groups, 1);
    assert.equal(currentStoryId(s), 'c1');
    s = run(s, { type: 'PREV' });
    assert.equal(currentStoryId(s), 'b2', 'back goes to the previous author\'s last story');
    s = run(s, { type: 'PREV' }, { type: 'PREV' });
    assert.equal(currentStoryId(s), 'b1', 'at the very start PREV restarts');
    s = run(s, { type: 'NEXT' }, { type: 'NEXT' }, { type: 'NEXT' });
    assert.equal(currentStoryId(s), 'd1');
    s = run(s, { type: 'NEXT_GROUP' });
    assert.ok(s.closed, 'skipping past the last author closes');
  });

  test('hold to pause is reason-counted', () => {
    let s = run(initViewer(groups), { type: 'READY', storyId: 'b1', durationMs: 5000 });
    s = run(s, { type: 'PAUSE', reason: 'hold' }, { type: 'PAUSE', reason: 'reply' }, { type: 'TICK', dt: 3000 });
    assert.equal(s.elapsedMs, 0);
    s = run(s, { type: 'RESUME', reason: 'hold' }, { type: 'TICK', dt: 3000 });
    assert.ok(isPaused(s), 'still paused while replying');
    assert.equal(s.elapsedMs, 0);
    s = run(s, { type: 'RESUME', reason: 'reply' }, { type: 'TICK', dt: 3000 });
    assert.equal(s.elapsedMs, 3000);
  });

  test('closes after the final story and on swipe down', () => {
    let s = initViewer([['x']]);
    s = run(s, { type: 'READY', storyId: 'x', durationMs: 100 }, { type: 'TICK', dt: 150 });
    assert.ok(s.closed);
    assert.equal(currentStoryId(s), null);
    assert.ok(run(initViewer(groups), { type: 'CLOSE' }).closed);
    assert.ok(initViewer([]).closed, 'nothing to show');
  });

  test('start position skips empty groups and clamps', () => {
    const s = initViewer([[], ['a1', 'a2'], [], ['z1']], 3, 7);
    assert.equal(currentStoryId(s), 'z1');
  });

  test('a story deleted while viewing is removed', () => {
    let s = run(initViewer(groups, 0, 1), { type: 'READY', storyId: 'b2', durationMs: 5000 });
    s = run(s, { type: 'REMOVE', storyId: 'b1' });
    assert.equal(currentStoryId(s), 'b2');
    assert.equal(s.durationMs, 5000, 'current story keeps playing');
    s = run(s, { type: 'REMOVE', storyId: 'b2' });
    assert.equal(currentStoryId(s), 'c1', 'emptied author is dropped');
    s = run(s, { type: 'NEXT' }, { type: 'REMOVE', storyId: 'd1' });
    assert.equal(currentStoryId(s), 'd2');
    s = run(s, { type: 'NEXT' }, { type: 'REMOVE', storyId: 'd3' });
    assert.ok(s.closed, 'removing the very last story closes');
  });
});

// ── tray ──────────────────────────────────────────────────────────────────────

describe('tray ordering', () => {
  test('unseen first, then seen, muted last; newest first within a section', () => {
    const entries = [
      { userId: 'seen-new', latestAt: '2026-10-03T12:00:00Z', hasUnseen: false, muted: false },
      { userId: 'muted-unseen', latestAt: '2026-10-03T13:00:00Z', hasUnseen: true, muted: true },
      { userId: 'unseen-old', latestAt: '2026-10-03T08:00:00Z', hasUnseen: true, muted: false },
      { userId: 'unseen-new', latestAt: '2026-10-03T11:00:00Z', hasUnseen: true, muted: false },
      { userId: 'seen-old', latestAt: '2026-10-03T07:00:00Z', hasUnseen: false, muted: false },
    ];
    assert.deepEqual(
      orderTray(entries).map((e) => e.userId),
      ['unseen-new', 'unseen-old', 'seen-new', 'seen-old', 'muted-unseen']
    );
  });

  test('viewer opens at the first unseen story', () => {
    const seen = new Set(['a', 'b']);
    assert.equal(firstUnseenIndex(['a', 'b', 'c'], (id) => seen.has(id)), 2);
    assert.equal(firstUnseenIndex(['a', 'b'], (id) => seen.has(id)), 0);
  });
});
