import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyParticipantEvent,
  GROUP_CALL_MAX_PARTICIPANTS,
  groupSizeNotice,
  groupTransition,
  joinBlockedReason,
  parseParticipantEvent,
  peopleInCall,
  pickActiveSpeaker,
  remoteParticipants,
  rosterFromRows,
  type Roster,
} from '../src/features/calls/groupCallState';
import type { CallState } from '../src/features/calls/callStateMachine';
import { callStatusLabel } from '../src/features/calls/callStateMachine';

const CALL = '11111111-1111-4111-8111-111111111111';
const u = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const d = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, extra: Record<string, unknown> = {}) => ({
  user_id: u(n),
  device_id: d(n),
  joined_at: `2026-01-01T00:00:0${n}Z`,
  audio_muted: false,
  video_enabled: true,
  screen_sharing: false,
  ...extra,
});
const ev = (action: string, n: number, extra: Record<string, unknown> = {}) => ({ call_id: CALL, action, ...row(n, extra) });

test('roster from join_group_call rows ignores malformed rows', () => {
  const roster = rosterFromRows([row(1), row(2), { user_id: 'x', device_id: d(3) }, null]);
  assert.deepEqual(Object.keys(roster).sort(), [d(1), d(2)]);
  assert.equal(roster[d(1)].videoEnabled, true);
  assert.deepEqual(rosterFromRows('nope'), {});
});

test('join / media / leave events keep the roster in sync', () => {
  let roster: Roster = rosterFromRows([row(1)]);
  roster = applyParticipantEvent(roster, parseParticipantEvent(ev('joined', 2), CALL)!);
  roster = applyParticipantEvent(roster, parseParticipantEvent(ev('joined', 3), CALL)!);
  assert.equal(peopleInCall(roster), 3);
  roster = applyParticipantEvent(roster, parseParticipantEvent(ev('media', 2, { audio_muted: true, screen_sharing: true }), CALL)!);
  assert.equal(roster[d(2)].audioMuted, true);
  assert.equal(roster[d(2)].screenSharing, true);
  roster = applyParticipantEvent(roster, parseParticipantEvent(ev('left', 3), CALL)!);
  assert.deepEqual(remoteParticipants(roster, d(1)).map((p) => p.deviceId), [d(2)]);
  // Same person on two devices counts once.
  roster = applyParticipantEvent(roster, parseParticipantEvent({ ...ev('joined', 4), user_id: u(2) }, CALL)!);
  assert.equal(peopleInCall(roster), 2);
});

test('participant events for another call or with bad fields are ignored', () => {
  assert.equal(parseParticipantEvent({ ...ev('joined', 1), call_id: 'other' }, CALL), null);
  assert.equal(parseParticipantEvent({ ...ev('kicked', 1) }, CALL), null);
  assert.equal(parseParticipantEvent({ call_id: CALL, action: 'joined', user_id: u(1) }, CALL), null);
  assert.equal(parseParticipantEvent(null, CALL), null);
});

test('8-person limit: the ninth person is told the call is full', () => {
  const eight = rosterFromRows([1, 2, 3, 4, 5, 6, 7, 8].map((n) => row(n)));
  assert.equal(GROUP_CALL_MAX_PARTICIPANTS, 8);
  assert.match(joinBlockedReason(eight, u(9)) ?? '', /full/);
  assert.equal(joinBlockedReason(eight, u(8)), null, 'someone already in the call can rejoin');
  const seven = rosterFromRows([1, 2, 3, 4, 5, 6, 7].map((n) => row(n)));
  assert.equal(joinBlockedReason(seven, u(9)), null);
  assert.equal(groupSizeNotice(8), null);
  assert.match(groupSizeNotice(12) ?? '', /limited to 8 people/);
});

function invite(patch: Partial<CallState> = {}): CallState {
  return {
    id: CALL,
    conversationId: 'g',
    peerId: 'g',
    peerName: 'Hikers',
    callType: 'video',
    isInitiator: false,
    status: 'ringing',
    duration: 0,
    ...patch,
  };
}

test('group lifecycle: invite -> join -> leave', () => {
  const T = 1_000_000;
  let c = groupTransition(invite(), { type: 'JOIN' }, T);
  assert.equal(c.status, 'connecting');
  c = groupTransition(c, { type: 'JOINED' }, T);
  assert.equal(c.status, 'connected');
  assert.equal(c.startedAt, T);
  c = groupTransition(c, { type: 'LEAVE' }, T + 61_000);
  assert.equal(c.status, 'ended');
  assert.equal(c.endReason, 'hangup');
  assert.equal(c.duration, 61);
  assert.equal(groupTransition(c, { type: 'JOINED' }), c, 'terminal states are final');
});

test('group invite: decline, timeout, call ended before joining', () => {
  assert.equal(groupTransition(invite(), { type: 'DECLINE' }).status, 'rejected');
  const missed = groupTransition(invite(), { type: 'RING_TIMEOUT' });
  assert.equal(missed.status, 'missed');
  assert.equal(callStatusLabel(missed), 'Missed call');
  assert.equal(groupTransition(invite(), { type: 'CALL_ENDED' }).status, 'missed');
});

test('group call: full / failed join, ended by others, removed (moved device)', () => {
  const joining = groupTransition(invite(), { type: 'JOIN' });
  const full = groupTransition(joining, { type: 'JOIN_FAILED', message: 'This call is full.' });
  assert.equal(full.status, 'failed');
  assert.equal(callStatusLabel(full), 'This call is full.');
  const live = groupTransition(joining, { type: 'JOINED' }, 0);
  assert.equal(groupTransition(live, { type: 'CALL_ENDED' }).endReason, 'remote_hangup');
  assert.equal(groupTransition(live, { type: 'REMOVED' }).endReason, 'connection_lost');
  // The starter is "connecting" from the start.
  const starter = invite({ isInitiator: true, status: 'connecting' });
  assert.equal(groupTransition(starter, { type: 'JOINED' }).status, 'connected');
});

test('active speaker: loudest above threshold, with hold to avoid flicker', () => {
  let s = pickActiveSpeaker({ a: 0.01, b: 0.02 }, { id: null, heardAt: 0 }, 0);
  assert.equal(s.id, null, 'silence highlights nobody');
  s = pickActiveSpeaker({ a: 0.3, b: 0.1 }, s, 1000);
  assert.equal(s.id, 'a');
  s = pickActiveSpeaker({ a: 0.25, b: 0.3 }, s, 1500);
  assert.equal(s.id, 'a', 'current speaker keeps the highlight unless someone is clearly louder');
  s = pickActiveSpeaker({ a: 0.0, b: 0.4 }, s, 1800);
  assert.equal(s.id, 'a', 'short pause: hold');
  s = pickActiveSpeaker({ a: 0.0, b: 0.4 }, s, 3200);
  assert.equal(s.id, 'b', 'after the hold the new speaker wins');
  s = pickActiveSpeaker({ a: 0.05, b: 0.6 }, s, 3300);
  assert.equal(s.id, 'b');
  s = pickActiveSpeaker({ local: 0.5, b: 0.0 }, s, 5000);
  assert.equal(s.id, 'local', 'you can be the active speaker');
  s = pickActiveSpeaker({ local: 0, b: 0 }, s, 9000);
  assert.equal(s.id, null);
});
