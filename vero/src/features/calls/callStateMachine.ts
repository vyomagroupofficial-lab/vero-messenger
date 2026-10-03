/**
 * Vero call state machine (pure, unit-tested in tests/callStateMachine.test.ts).
 *
 * CallService feeds every input (local button presses, timers, server status
 * broadcasts, WebRTC connection changes) through `transition`, which returns
 * the next call snapshot and, when the server must be told, the status to
 * report via the `update_call_status` RPC. Keeping this pure means the rules
 * ("cancel before answer = missed call for the callee", "busy", "answered on
 * another device", ...) are tested without any network or media.
 *
 * Terminal statuses stay within the original set (ended / rejected / missed /
 * failed) so existing screens keep working; `endReason` carries the detail.
 */

export type CallType = 'voice' | 'video';

export type CallStatus =
  | 'calling' // outgoing, waiting for the callee
  | 'ringing' // incoming, waiting for the local user
  | 'connecting' // answered, WebRTC negotiating
  | 'connected'
  | 'reconnecting' // media interrupted, ICE restart in progress
  | 'ended'
  | 'rejected'
  | 'missed'
  | 'failed';

export type CallEndReason =
  | 'hangup' // local user hung up
  | 'remote_hangup'
  | 'declined' // callee declined (caller's view) / I declined (callee's view)
  | 'busy'
  | 'no_answer' // ring timeout
  | 'cancelled' // caller hung up before the callee answered
  | 'answered_elsewhere' // another of my devices picked up
  | 'declined_elsewhere' // another of my devices declined
  | 'connection_lost' // media dropped after being connected and could not recover
  | 'connection_failed' // media never connected
  | 'media_error' // microphone / camera unavailable
  | 'error';

/** Statuses stored in public.call_sessions (see 002_calls.sql). */
export type ServerCallStatus = 'ringing' | 'active' | 'ended' | 'missed' | 'rejected' | 'busy' | 'cancelled' | 'failed';

export const TERMINAL_STATUSES: readonly CallStatus[] = ['ended', 'rejected', 'missed', 'failed'];

export function isCallFinished(status: CallStatus | undefined | null): boolean {
  return !!status && TERMINAL_STATUSES.includes(status);
}

export interface CallState {
  id: string;
  conversationId: string;
  peerId: string;
  peerName: string;
  callType: CallType;
  isInitiator: boolean;
  status: CallStatus;
  endReason?: CallEndReason;
  /** The peer's device that is in the call (set once known). */
  peerDeviceId?: string;
  /** Caller only: at least one callee device is ringing. */
  remoteRinging?: boolean;
  /** When media first connected (ms epoch); duration is measured from here. */
  startedAt?: number;
  duration: number;
  error?: string;
}

export type CallEvent =
  | { type: 'ACCEPT' }
  | { type: 'DECLINE' }
  | { type: 'HANGUP' }
  | { type: 'RING_TIMEOUT' }
  | { type: 'CONNECT_TIMEOUT' }
  | { type: 'REMOTE_RINGING' }
  | { type: 'REMOTE_ACCEPTED'; deviceId?: string | null }
  | { type: 'MEDIA_CONNECTED' }
  | { type: 'MEDIA_INTERRUPTED' }
  | { type: 'MEDIA_FAILED' }
  | { type: 'MEDIA_ERROR'; message?: string }
  | {
      type: 'SERVER_STATUS';
      status: ServerCallStatus;
      answeredDeviceId?: string | null;
      myDeviceId: string;
    };

export interface TransitionResult {
  call: CallState;
  /** Status to send to the server, if this transition must be reported. */
  report?: ServerCallStatus;
}

const ACTIVE_MEDIA: readonly CallStatus[] = ['connecting', 'connected', 'reconnecting'];

function end(call: CallState, status: CallStatus, endReason: CallEndReason, now: number, error?: string): CallState {
  const duration = call.startedAt ? Math.max(0, Math.floor((now - call.startedAt) / 1000)) : 0;
  return { ...call, status, endReason, duration, ...(error ? { error } : {}) };
}

export function transition(call: CallState, event: CallEvent, now: number = Date.now()): TransitionResult {
  if (isCallFinished(call.status)) return { call };
  const s = call.status;
  const callee = !call.isInitiator;

  switch (event.type) {
    case 'ACCEPT':
      if (callee && s === 'ringing') return { call: { ...call, status: 'connecting' }, report: 'active' };
      return { call };

    case 'DECLINE':
      if (callee && s === 'ringing') return { call: end(call, 'rejected', 'declined', now), report: 'rejected' };
      return { call };

    case 'HANGUP':
      if (s === 'calling') return { call: end(call, 'ended', 'cancelled', now), report: 'cancelled' };
      if (s === 'ringing') return { call: end(call, 'rejected', 'declined', now), report: 'rejected' };
      return { call: end(call, 'ended', 'hangup', now), report: 'ended' };

    case 'RING_TIMEOUT':
      if (s === 'calling' || s === 'ringing') return { call: end(call, 'missed', 'no_answer', now), report: 'missed' };
      return { call };

    case 'CONNECT_TIMEOUT':
      if (s === 'connecting') return { call: end(call, 'failed', 'connection_failed', now), report: 'failed' };
      return { call };

    case 'REMOTE_RINGING':
      if (!callee && s === 'calling') return { call: { ...call, remoteRinging: true } };
      return { call };

    case 'REMOTE_ACCEPTED':
      if (!callee && s === 'calling') {
        return { call: { ...call, status: 'connecting', peerDeviceId: event.deviceId ?? call.peerDeviceId } };
      }
      return { call };

    case 'MEDIA_CONNECTED':
      if (s === 'connecting' || s === 'reconnecting') {
        return { call: { ...call, status: 'connected', startedAt: call.startedAt ?? now } };
      }
      return { call };

    case 'MEDIA_INTERRUPTED':
      if (s === 'connected') return { call: { ...call, status: 'reconnecting' } };
      return { call };

    case 'MEDIA_FAILED':
      if (s === 'connecting') return { call: end(call, 'failed', 'connection_failed', now), report: 'failed' };
      if (s === 'connected' || s === 'reconnecting') {
        return { call: end(call, 'ended', 'connection_lost', now), report: 'ended' };
      }
      return { call };

    case 'MEDIA_ERROR': {
      const report: ServerCallStatus = s === 'calling' ? 'cancelled' : s === 'ringing' ? 'rejected' : 'failed';
      return { call: end(call, 'failed', 'media_error', now, event.message), report };
    }

    case 'SERVER_STATUS':
      return { call: applyServerStatus(call, event, now) };
  }
}

function applyServerStatus(
  call: CallState,
  event: Extract<CallEvent, { type: 'SERVER_STATUS' }>,
  now: number
): CallState {
  const s = call.status;
  const callee = !call.isInitiator;
  const answeredElsewhere =
    callee && !!event.answeredDeviceId && event.answeredDeviceId !== event.myDeviceId;

  switch (event.status) {
    case 'ringing':
      return call;

    case 'active':
      if (!callee) {
        return s === 'calling'
          ? { ...call, status: 'connecting', peerDeviceId: event.answeredDeviceId ?? call.peerDeviceId }
          : call;
      }
      // Callee: another of my devices answered while this one was still ringing.
      if (answeredElsewhere && s === 'ringing') return end(call, 'ended', 'answered_elsewhere', now);
      if (answeredElsewhere && s === 'connecting') return end(call, 'ended', 'answered_elsewhere', now);
      return call;

    case 'rejected':
      if (!callee) return end(call, 'rejected', 'declined', now);
      return end(call, 'ended', 'declined_elsewhere', now);

    case 'busy':
      if (!callee) return end(call, 'rejected', 'busy', now);
      return end(call, 'ended', 'declined_elsewhere', now);

    case 'cancelled':
      return callee ? end(call, 'missed', 'cancelled', now) : end(call, 'ended', 'cancelled', now);

    case 'missed':
      return end(call, 'missed', 'no_answer', now);

    case 'ended':
      if (s === 'ringing') return end(call, 'missed', 'cancelled', now);
      if (s === 'calling') return end(call, 'ended', 'cancelled', now);
      if (answeredElsewhere) return end(call, 'ended', 'answered_elsewhere', now);
      return end(call, 'ended', 'remote_hangup', now);

    case 'failed':
      return ACTIVE_MEDIA.includes(s) && call.startedAt
        ? end(call, 'ended', 'connection_lost', now)
        : end(call, 'failed', 'connection_failed', now);
  }
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/** Human readable status for the call screen. */
export function callStatusLabel(call: Pick<CallState, 'status' | 'endReason' | 'isInitiator' | 'callType' | 'duration' | 'remoteRinging' | 'error'> | null): string {
  if (!call) return 'Call ended';
  switch (call.status) {
    case 'calling':
      return call.remoteRinging ? 'Ringing…' : 'Calling…';
    case 'ringing':
      return call.isInitiator ? 'Ringing…' : `Incoming ${call.callType} call`;
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return formatDuration(call.duration || 0);
    case 'reconnecting':
      return 'Reconnecting…';
  }
  switch (call.endReason) {
    case 'declined':
      return 'Declined';
    case 'busy':
      return 'Busy';
    case 'no_answer':
      return call.isInitiator ? 'No answer' : 'Missed call';
    case 'cancelled':
      return call.isInitiator ? 'Call cancelled' : 'Missed call';
    case 'answered_elsewhere':
      return 'Answered on another device';
    case 'declined_elsewhere':
      return 'Declined on another device';
    case 'connection_lost':
      return 'Connection lost';
    case 'connection_failed':
      return "Couldn't connect";
    case 'media_error':
      return call.error || 'Microphone or camera unavailable';
    case 'error':
      return call.error || 'Call failed';
    default:
      return call.status === 'failed' ? 'Call failed' : 'Call ended';
  }
}

/** Direction for the local call log. */
export function callLogDirection(call: CallState): 'incoming' | 'outgoing' | 'missed' {
  if (call.isInitiator) return 'outgoing';
  if (call.startedAt || call.endReason === 'answered_elsewhere' || call.endReason === 'declined' || call.endReason === 'declined_elsewhere') {
    return 'incoming';
  }
  return 'missed';
}

/**
 * Callee side of an incoming invite: whether this device should answer "busy"
 * automatically instead of ringing.
 */
export function shouldAutoBusy(current: CallState | null, incomingCallId: string): boolean {
  return !!current && current.id !== incomingCallId && !isCallFinished(current.status);
}
