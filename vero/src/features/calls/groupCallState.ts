/**
 * Group call bookkeeping (pure, unit-tested in tests/callGroup.test.ts):
 * the participant roster built from join_group_call() + `call.participant`
 * broadcasts, the group call lifecycle, and active-speaker selection.
 */

import type { CallState } from './callStateMachine';

/** Mirrors public.group_call_max_participants() in 002_calls.sql. */
export const GROUP_CALL_MAX_PARTICIPANTS = 8;

export interface ParticipantRow {
  userId: string;
  deviceId: string;
  joinedAt?: string;
  audioMuted: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
}

/** Keyed by device id. */
export type Roster = Readonly<Record<string, ParticipantRow>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseRow(r: any): ParticipantRow | null {
  const userId = r?.user_id ?? r?.userId;
  const deviceId = r?.device_id ?? r?.deviceId;
  if (typeof userId !== 'string' || typeof deviceId !== 'string' || !UUID.test(userId) || !UUID.test(deviceId)) {
    return null;
  }
  return {
    userId,
    deviceId,
    joinedAt: typeof r.joined_at === 'string' ? r.joined_at : undefined,
    audioMuted: r.audio_muted === true || r.audioMuted === true,
    videoEnabled: r.video_enabled === true || r.videoEnabled === true,
    screenSharing: r.screen_sharing === true || r.screenSharing === true,
  };
}

export function rosterFromRows(rows: unknown): Roster {
  const out: Record<string, ParticipantRow> = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const p = parseRow(r);
    if (p) out[p.deviceId] = p;
  }
  return out;
}

export interface ParticipantEvent {
  action: 'joined' | 'left' | 'media';
  row: ParticipantRow;
}

/** Parses an (untrusted) `call.participant` broadcast for `callId`. */
export function parseParticipantEvent(payload: any, callId: string): ParticipantEvent | null {
  if (!payload || payload.call_id !== callId) return null;
  if (payload.action !== 'joined' && payload.action !== 'left' && payload.action !== 'media') return null;
  const row = parseRow(payload);
  return row ? { action: payload.action, row } : null;
}

export function applyParticipantEvent(roster: Roster, ev: ParticipantEvent): Roster {
  const next: Record<string, ParticipantRow> = { ...roster };
  switch (ev.action) {
    case 'joined':
      next[ev.row.deviceId] = { ...ev.row };
      break;
    case 'left':
      delete next[ev.row.deviceId];
      break;
    case 'media':
      // A media update for someone we haven't seen join means they're in the call.
      next[ev.row.deviceId] = { ...(next[ev.row.deviceId] ?? {}), ...ev.row };
      break;
  }
  return next;
}

/** Everyone in the roster except this device. */
export function remoteParticipants(roster: Roster, myDeviceId: string): ParticipantRow[] {
  return Object.values(roster)
    .filter((p) => p.deviceId !== myDeviceId)
    .sort((a, b) => (a.joinedAt ?? '').localeCompare(b.joinedAt ?? '') || a.deviceId.localeCompare(b.deviceId));
}

/** Number of distinct people in the call. */
export function peopleInCall(roster: Roster): number {
  return new Set(Object.values(roster).map((p) => p.userId)).size;
}

/** Shown before starting / joining when the group is bigger than a call can be. */
export function groupSizeNotice(memberCount: number): string | null {
  if (memberCount <= GROUP_CALL_MAX_PARTICIPANTS) return null;
  return `Group calls are limited to ${GROUP_CALL_MAX_PARTICIPANTS} people. This group has ${memberCount} members, so only the first ${GROUP_CALL_MAX_PARTICIPANTS} to join can take part.`;
}

/** Client-side pre-check (the server enforces the same limit in join_group_call). */
export function joinBlockedReason(roster: Roster, myUserId: string): string | null {
  const others = new Set(Object.values(roster).filter((p) => p.userId !== myUserId).map((p) => p.userId));
  return others.size >= GROUP_CALL_MAX_PARTICIPANTS
    ? `This call is full (group calls are limited to ${GROUP_CALL_MAX_PARTICIPANTS} people).`
    : null;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export type GroupCallEvent =
  | { type: 'JOIN' } // local user taps Join / Start
  | { type: 'JOINED' } // join_group_call succeeded
  | { type: 'JOIN_FAILED'; message: string }
  | { type: 'DECLINE' }
  | { type: 'RING_TIMEOUT' }
  | { type: 'LEAVE' }
  | { type: 'CALL_ENDED' } // server: the call is over
  | { type: 'REMOVED' }; // heartbeat says this device is no longer in the call

export function groupTransition(call: CallState, ev: GroupCallEvent, now: number = Date.now()): CallState {
  const s = call.status;
  if (s === 'ended' || s === 'rejected' || s === 'missed' || s === 'failed') return call;
  const duration = () => (call.startedAt ? Math.max(0, Math.floor((now - call.startedAt) / 1000)) : 0);

  switch (ev.type) {
    case 'JOIN':
      return s === 'ringing' ? { ...call, status: 'connecting' } : call;
    case 'JOINED':
      return s === 'connecting' ? { ...call, status: 'connected', startedAt: call.startedAt ?? now } : call;
    case 'JOIN_FAILED':
      return s === 'connecting' || s === 'ringing'
        ? { ...call, status: 'failed', endReason: 'error', error: ev.message, duration: 0 }
        : call;
    case 'DECLINE':
      return s === 'ringing' ? { ...call, status: 'rejected', endReason: 'declined' } : call;
    case 'RING_TIMEOUT':
      return s === 'ringing' ? { ...call, status: 'missed', endReason: 'no_answer' } : call;
    case 'LEAVE':
      return s === 'ringing'
        ? { ...call, status: 'rejected', endReason: 'declined' }
        : { ...call, status: 'ended', endReason: 'hangup', duration: duration() };
    case 'CALL_ENDED':
      return s === 'ringing'
        ? { ...call, status: 'missed', endReason: 'cancelled' }
        : { ...call, status: 'ended', endReason: 'remote_hangup', duration: duration() };
    case 'REMOVED':
      return { ...call, status: 'ended', endReason: 'connection_lost', duration: duration() };
  }
}

// ── Active speaker ──────────────────────────────────────────────────────────

export const SPEAKING_THRESHOLD = 0.04;
const SPEAKER_HOLD_MS = 1500;

export interface SpeakerState {
  id: string | null;
  /** When `id` was last heard above the threshold. */
  heardAt: number;
}

/**
 * Picks who to highlight from audio levels (0..1, by participant id; include
 * 'local' for yourself). The current speaker is kept for a short hold so the
 * highlight doesn't flicker between words or on brief interjections.
 */
export function pickActiveSpeaker(levels: Record<string, number>, prev: SpeakerState, now: number): SpeakerState {
  let loudest: string | null = null;
  let max = SPEAKING_THRESHOLD;
  for (const [id, level] of Object.entries(levels)) {
    if (level >= max) {
      max = level;
      loudest = id;
    }
  }
  if (prev.id && (levels[prev.id] ?? 0) >= SPEAKING_THRESHOLD) {
    // Still talking: keep them unless someone is clearly louder.
    if (!loudest || loudest === prev.id || max < (levels[prev.id] ?? 0) * 1.5) return { id: prev.id, heardAt: now };
  }
  if (loudest) {
    if (prev.id && prev.id !== loudest && now - prev.heardAt < SPEAKER_HOLD_MS) return prev;
    return { id: loudest, heardAt: now };
  }
  if (prev.id && now - prev.heardAt < SPEAKER_HOLD_MS) return prev;
  return { id: null, heardAt: prev.heardAt };
}
