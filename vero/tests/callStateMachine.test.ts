import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CallState,
  CallEvent,
  transition,
  callStatusLabel,
  callLogDirection,
  isCallFinished,
  shouldAutoBusy,
} from '../src/features/calls/callStateMachine';

const T0 = 1_700_000_000_000;

function outgoing(patch: Partial<CallState> = {}): CallState {
  return {
    id: 'call-1',
    conversationId: 'conv-1',
    peerId: 'bob',
    peerName: 'Bob',
    callType: 'voice',
    isInitiator: true,
    status: 'calling',
    duration: 0,
    ...patch,
  };
}

function incoming(patch: Partial<CallState> = {}): CallState {
  return outgoing({ isInitiator: false, status: 'ringing', peerId: 'alice', peerName: 'Alice', ...patch });
}

function run(call: CallState, ...events: CallEvent[]) {
  let report: string | undefined;
  for (const e of events) {
    const r = transition(call, e, T0 + 65_000);
    call = r.call;
    report = r.report ?? report;
  }
  return { call, report };
}

const status = (s: string, answeredDeviceId?: string, myDeviceId = 'my-dev'): CallEvent =>
  ({ type: 'SERVER_STATUS', status: s, answeredDeviceId, myDeviceId }) as CallEvent;

test('happy path: caller -> accepted -> connected -> hang up', () => {
  let c = outgoing();
  c = transition(c, { type: 'REMOTE_RINGING' }).call;
  assert.equal(callStatusLabel(c), 'Ringing…');
  c = transition(c, status('active', 'bob-phone')).call;
  assert.equal(c.status, 'connecting');
  assert.equal(c.peerDeviceId, 'bob-phone');
  c = transition(c, { type: 'MEDIA_CONNECTED' }, T0).call;
  assert.equal(c.status, 'connected');
  assert.equal(c.startedAt, T0);
  const r = transition(c, { type: 'HANGUP' }, T0 + 65_000);
  assert.equal(r.call.status, 'ended');
  assert.equal(r.call.endReason, 'hangup');
  assert.equal(r.call.duration, 65);
  assert.equal(r.report, 'ended');
  assert.equal(callLogDirection(r.call), 'outgoing');
});

test('callee accepts: reports active, then connects', () => {
  const r = transition(incoming(), { type: 'ACCEPT' });
  assert.equal(r.call.status, 'connecting');
  assert.equal(r.report, 'active');
  const c = transition(r.call, { type: 'MEDIA_CONNECTED' }, T0).call;
  assert.equal(c.status, 'connected');
  assert.equal(callLogDirection(c), 'incoming');
});

test('decline: callee reports rejected, caller instantly sees "Declined"', () => {
  const callee = transition(incoming(), { type: 'DECLINE' });
  assert.equal(callee.report, 'rejected');
  assert.equal(callee.call.status, 'rejected');

  const caller = transition(outgoing(), status('rejected')).call;
  assert.equal(caller.status, 'rejected');
  assert.equal(caller.endReason, 'declined');
  assert.equal(callStatusLabel(caller), 'Declined');
});

test('busy: caller sees "Busy"', () => {
  const caller = transition(outgoing(), status('busy')).call;
  assert.equal(caller.status, 'rejected');
  assert.equal(callStatusLabel(caller), 'Busy');
});

test('auto-busy only while in another unfinished call', () => {
  assert.equal(shouldAutoBusy(null, 'x'), false);
  assert.equal(shouldAutoBusy(outgoing({ status: 'connected' }), 'call-2'), true);
  assert.equal(shouldAutoBusy(outgoing({ status: 'ended' }), 'call-2'), false);
  assert.equal(shouldAutoBusy(outgoing({ status: 'connected' }), 'call-1'), false, 'same call is not busy');
});

test('ring timeout -> missed on both sides', () => {
  const caller = transition(outgoing(), { type: 'RING_TIMEOUT' });
  assert.equal(caller.call.status, 'missed');
  assert.equal(caller.report, 'missed');
  assert.equal(callStatusLabel(caller.call), 'No answer');

  const callee = transition(incoming(), { type: 'RING_TIMEOUT' });
  assert.equal(callee.call.status, 'missed');
  assert.equal(callStatusLabel(callee.call), 'Missed call');
  assert.equal(callLogDirection(callee.call), 'missed');
});

test('ring timeout is ignored once answered', () => {
  const r = run(outgoing(), status('active', 'bob-phone'), { type: 'RING_TIMEOUT' });
  assert.equal(r.call.status, 'connecting');
  assert.equal(r.report, undefined);
});

test('caller cancels before answer: reported as cancelled, callee logs a missed call', () => {
  const caller = transition(outgoing(), { type: 'HANGUP' });
  assert.equal(caller.report, 'cancelled');
  assert.equal(caller.call.endReason, 'cancelled');

  const callee = transition(incoming(), status('cancelled')).call;
  assert.equal(callee.status, 'missed');
  assert.equal(callStatusLabel(callee), 'Missed call');
  assert.equal(callLogDirection(callee), 'missed');
});

test('callee hanging up while ringing = decline', () => {
  const r = transition(incoming(), { type: 'HANGUP' });
  assert.equal(r.report, 'rejected');
});

test('multi-device: other devices stop ringing when one answers', () => {
  const otherDevice = transition(incoming(), status('active', 'callee-tablet', 'callee-phone')).call;
  assert.equal(otherDevice.status, 'ended');
  assert.equal(otherDevice.endReason, 'answered_elsewhere');
  assert.equal(callStatusLabel(otherDevice), 'Answered on another device');
  assert.equal(callLogDirection(otherDevice), 'incoming');

  // The answering device ignores its own "active" broadcast.
  const answering = run(incoming(), { type: 'ACCEPT' }, status('active', 'callee-phone', 'callee-phone')).call;
  assert.equal(answering.status, 'connecting');

  // Losing an accept race (RPC says someone else answered first).
  const loser = run(incoming(), { type: 'ACCEPT' }, status('active', 'callee-tablet', 'callee-phone')).call;
  assert.equal(loser.endReason, 'answered_elsewhere');
});

test('multi-device: other devices stop ringing when one declines', () => {
  const c = transition(incoming(), status('rejected')).call;
  assert.equal(c.status, 'ended');
  assert.equal(c.endReason, 'declined_elsewhere');
});

test('remote hang up ends the call with a duration', () => {
  const connected = transition(outgoing({ status: 'connecting' }), { type: 'MEDIA_CONNECTED' }, T0).call;
  const r = transition(connected, status('ended'), T0 + 10_000);
  assert.equal(r.call.status, 'ended');
  assert.equal(r.call.endReason, 'remote_hangup');
  assert.equal(r.call.duration, 10);
  assert.equal(r.report, undefined, 'remote end is not echoed back');
});

test('connection lost -> reconnecting -> recovered', () => {
  let c = transition(outgoing({ status: 'connecting' }), { type: 'MEDIA_CONNECTED' }, T0).call;
  c = transition(c, { type: 'MEDIA_INTERRUPTED' }).call;
  assert.equal(c.status, 'reconnecting');
  assert.equal(callStatusLabel(c), 'Reconnecting…');
  c = transition(c, { type: 'MEDIA_CONNECTED' }, T0 + 5000).call;
  assert.equal(c.status, 'connected');
  assert.equal(c.startedAt, T0, 'duration keeps counting from the first connect');
});

test('connection never recovers -> ended (connection lost), never connected -> failed', () => {
  let c = transition(outgoing({ status: 'connecting' }), { type: 'MEDIA_CONNECTED' }, T0).call;
  c = transition(c, { type: 'MEDIA_INTERRUPTED' }).call;
  const lost = transition(c, { type: 'MEDIA_FAILED' }, T0 + 30_000);
  assert.equal(lost.call.status, 'ended');
  assert.equal(lost.call.endReason, 'connection_lost');
  assert.equal(lost.report, 'ended');

  const never = transition(outgoing({ status: 'connecting' }), { type: 'CONNECT_TIMEOUT' });
  assert.equal(never.call.status, 'failed');
  assert.equal(never.report, 'failed');
  assert.equal(callStatusLabel(never.call), "Couldn't connect");
});

test('media error before answering cancels / declines', () => {
  const caller = transition(outgoing(), { type: 'MEDIA_ERROR', message: 'Microphone permission denied' });
  assert.equal(caller.report, 'cancelled');
  assert.equal(callStatusLabel(caller.call), 'Microphone permission denied');
  const callee = transition(incoming(), { type: 'MEDIA_ERROR' });
  assert.equal(callee.report, 'rejected');
});

test('finished calls ignore further events', () => {
  const ended = transition(outgoing(), status('rejected')).call;
  for (const e of [{ type: 'HANGUP' }, { type: 'MEDIA_CONNECTED' }, status('active', 'x')] as CallEvent[]) {
    const r = transition(ended, e);
    assert.equal(r.call, ended);
    assert.equal(r.report, undefined);
  }
  assert.equal(isCallFinished('rejected'), true);
  assert.equal(isCallFinished('reconnecting'), false);
});

test('only the callee can accept or decline', () => {
  assert.equal(transition(outgoing(), { type: 'ACCEPT' }).call.status, 'calling');
  assert.equal(transition(outgoing(), { type: 'DECLINE' }).call.status, 'calling');
});
