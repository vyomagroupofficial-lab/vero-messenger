/**
 * Vero calls: 1:1 and group (mesh, up to 8 people) voice / video calls with
 * screen sharing.
 *
 * Server (supabase/migrations/002_calls.sql)
 *   1:1   start_direct_call -> `call.invite` on the callee's user:<id>;
 *         answer_call (first device wins), update_call_status; every change
 *         is broadcast as `call.status` to both users and call:<id>.
 *   group start_group_call -> invites every member; join_group_call /
 *         leave_call / set_call_media_state -> `call.participant`.
 * Media / signalling: CallEngine (sealed signalling over call:<id>, one
 * RTCPeerConnection per remote device). Rules for 1:1 outcomes live in the
 * pure callStateMachine.ts, group bookkeeping in groupCallState.ts.
 *
 * The UI uses `useCall()` (snapshot + controls) or subscribe()/getActiveCall().
 */

import { supabase } from '../../core/network/supabase';
import { userChannel } from '../../core/network/realtime';
import { currentSession } from '../../core/session';
import { databaseService } from '../../core/storage/DatabaseService';
import { generateUUID } from '../../shared/utils/uuid';
import {
  callLogDirection,
  isCallFinished,
  shouldAutoBusy,
  transition,
  type CallEvent,
  type CallState,
  type CallType,
  type ServerCallStatus,
} from './callStateMachine';
import {
  applyParticipantEvent,
  GROUP_CALL_MAX_PARTICIPANTS,
  groupTransition,
  parseParticipantEvent,
  pickActiveSpeaker,
  remoteParticipants,
  rosterFromRows,
  SPEAKING_THRESHOLD,
  type GroupCallEvent,
  type Roster,
  type SpeakerState,
} from './groupCallState';
import { CallEngine } from './CallEngine';
import { LocalMedia, type LocalMediaState } from './LocalMedia';
import { prefetchIceServers } from './iceServers';
import type { StreamLike } from './mediaTypes';
import type { PeerConnectionState } from './PeerSession';
import { mediaAdapter } from './webrtc';
import {
  dismissCallNotifications,
  listenForCallNotificationResponses,
  setupCallNotifications,
  type CallNotificationResponse,
  type CallPushData,
} from './callNotifications';
import { registerCallNotificationTask } from './callNotificationTask';

export type { CallType, CallStatus, CallEndReason } from './callStateMachine';
export { callStatusLabel, isCallFinished } from './callStateMachine';
export { GROUP_CALL_MAX_PARTICIPANTS, groupSizeNotice } from './groupCallState';

export interface CallParticipantView {
  deviceId: string;
  userId: string;
  name: string;
  audioMuted: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
  /** 'waiting' = in the call, our connection to them isn't up yet. */
  connection: PeerConnectionState | 'waiting';
  stream: StreamLike | null;
  audioLevel: number;
  speaking: boolean;
}

export interface LocalCallView extends LocalMediaState {
  stream: StreamLike | null;
  speakerOn: boolean;
  speakerToggleSupported: boolean;
  canScreenShare: boolean;
  screenShareUnavailableReason?: string;
  audioLevel: number;
  speaking: boolean;
}

export interface ActiveCall extends CallState {
  kind: 'direct' | 'group';
  groupName?: string;
  /** Group invites: who started the call. */
  inviterName?: string;
  /** Remote devices in the call (1:1: the peer once answered). */
  participants: CallParticipantView[];
  local: LocalCallView;
  /** Device id of the loudest participant, 'local' for you, or null. */
  activeSpeakerId: string | null;
  /** Device id of whoever shares their screen ('local' for you), or null. */
  presenterId: string | null;
  /** Transient message for the user (e.g. "Screen sharing was cancelled."). */
  notice?: string;
}

export type CallListener = (call: ActiveCall | null) => void;

/** Whether real-time audio/video works in this build (false in Expo Go / unsupported browsers). */
export function callMediaUnavailableReason(): string | null {
  return mediaAdapter.unavailableReason();
}
export const CALL_MEDIA_AVAILABLE = callMediaUnavailableReason() === null;

const RING_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 30_000;
const HEARTBEAT_MS = 20_000;
const NOTICE_MS = 4_000;
const SERVER_STATUSES: readonly ServerCallStatus[] = ['ringing', 'active', 'ended', 'missed', 'rejected', 'busy', 'cancelled', 'failed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InternalCall = CallState & { kind: 'direct' | 'group'; groupName?: string; inviterName?: string; notice?: string };

interface Timers {
  ring: ReturnType<typeof setTimeout> | null;
  connect: ReturnType<typeof setTimeout> | null;
  tick: ReturnType<typeof setInterval> | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  clear: ReturnType<typeof setTimeout> | null;
  notice: ReturnType<typeof setTimeout> | null;
}

class CallService {
  private call: InternalCall | null = null;
  private engine: CallEngine | null = null;
  private local: LocalMedia | null = null;
  private roster: Roster = {};
  private joined = false;
  private finishing: string | null = null;
  private starting = false;
  private speakerOn = false;
  private levels: Record<string, number> = {};
  private speaker: SpeakerState = { id: null, heardAt: 0 };
  private names = new Map<string, string>();
  private audioKeys = new Set<string>();
  private handled = new Set<string>();
  private listeners = new Set<CallListener>();
  private unsubs: (() => void)[] = [];
  private timers: Timers = { ring: null, connect: null, tick: null, heartbeat: null, clear: null, notice: null };

  // ── Subscription / snapshot ───────────────────────────────────────────────

  subscribe(listener: CallListener): () => void {
    this.listeners.add(listener);
    listener(this.getActiveCall());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getActiveCall(): ActiveCall | null {
    const call = this.call;
    if (!call) return null;
    const me = currentSession();
    const peers = new Map((this.engine?.mesh?.list() ?? []).map((p) => [p.deviceId, p]));
    const participants: CallParticipantView[] = [];
    const seen = new Set<string>();

    const view = (deviceId: string, userId: string): CallParticipantView => {
      const row = this.roster[deviceId];
      const peer = peers.get(deviceId);
      const level = this.levels[deviceId] ?? 0;
      return {
        deviceId,
        userId,
        name: this.names.get(userId) ?? (call.kind === 'direct' ? call.peerName : 'Participant'),
        audioMuted: row?.audioMuted ?? false,
        videoEnabled: row?.videoEnabled ?? (call.kind === 'direct' && call.callType === 'video'),
        screenSharing: row?.screenSharing ?? false,
        connection: peer?.state ?? 'waiting',
        stream: peer?.stream ?? null,
        audioLevel: level,
        speaking: level >= SPEAKING_THRESHOLD,
      };
    };

    if (call.kind === 'group') {
      for (const p of remoteParticipants(this.roster, me?.deviceId ?? '')) {
        participants.push(view(p.deviceId, p.userId));
        seen.add(p.deviceId);
      }
    }
    for (const p of peers.values()) if (!seen.has(p.deviceId)) participants.push(view(p.deviceId, p.userId));

    const local = this.local;
    const share = mediaAdapter.screenShareSupport();
    const localState: LocalMediaState = local?.state ?? {
      micMuted: false,
      cameraOn: call.callType === 'video',
      screenSharing: false,
      facing: 'user',
    };
    const presenter = localState.screenSharing ? 'local' : participants.find((p) => p.screenSharing)?.deviceId ?? null;

    return {
      ...call,
      participants,
      local: {
        ...localState,
        stream: local?.stream ?? null,
        speakerOn: this.speakerOn,
        speakerToggleSupported: mediaAdapter.audio.supportsSpeakerToggle,
        canScreenShare: share.supported,
        screenShareUnavailableReason: share.reason,
        audioLevel: this.levels.local ?? 0,
        speaking: (this.levels.local ?? 0) >= SPEAKING_THRESHOLD,
      },
      activeSpeakerId: this.speaker.id,
      presenterId: presenter,
    };
  }

  private emit() {
    this.syncRemoteAudio();
    const snapshot = this.getActiveCall();
    this.listeners.forEach((l) => l(snapshot));
  }

  /** Web: one hidden <audio> per remote participant (native plays remote audio itself). */
  private syncRemoteAudio() {
    const peers = this.engine?.mesh?.list() ?? [];
    const live = new Set<string>();
    for (const p of peers) {
      if (!p.stream) continue;
      live.add(p.deviceId);
      mediaAdapter.attachRemoteAudio(p.deviceId, p.stream);
    }
    for (const key of this.audioKeys) if (!live.has(key)) mediaAdapter.attachRemoteAudio(key, null);
    this.audioKeys = live;
  }

  private showNotice(message: string) {
    if (!this.call) return;
    this.call = { ...this.call, notice: message };
    if (this.timers.notice) clearTimeout(this.timers.notice);
    this.timers.notice = setTimeout(() => {
      if (this.call?.notice === message) {
        this.call = { ...this.call, notice: undefined };
        this.emit();
      }
    }, NOTICE_MS);
    this.emit();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Start listening for invites (call once after sign-in). */
  start(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [
      userChannel.on('call.invite', (p) => this.onInvite(p)),
      userChannel.on('call.status', (p) => this.onServerStatus(p)),
      listenForCallNotificationResponses((r) => void this.onNotificationResponse(r)),
    ];
    void setupCallNotifications();
    void registerCallNotificationTask();
    void this.checkPendingInvite();
    void this.syncCallHistory();
  }

  stop(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (this.call && !isCallFinished(this.call.status)) {
      if (this.call.kind === 'group') this.groupEvent({ type: 'LEAVE' });
      else this.directEvent({ type: 'HANGUP' });
    }
    this.releaseMedia();
    this.clearTimers();
    this.call = null;
    this.handled.clear();
    this.emit();
  }

  private busy(): boolean {
    return this.starting || (!!this.call && !isCallFinished(this.call.status));
  }

  private resetForNewCall() {
    this.clearTimers();
    this.releaseMedia();
    this.roster = {};
    this.joined = false;
    this.finishing = null;
    this.levels = {};
    this.speaker = { id: null, heardAt: 0 };
    this.call = null;
  }

  private clearTimers() {
    for (const key of Object.keys(this.timers) as (keyof Timers)[]) {
      const t = this.timers[key];
      if (t) {
        clearTimeout(t as any);
        clearInterval(t as any);
      }
      this.timers[key] = null;
    }
  }

  private releaseMedia() {
    this.engine?.close(true);
    this.engine = null;
    this.local?.stop();
    this.local = null;
    for (const key of this.audioKeys) mediaAdapter.attachRemoteAudio(key, null);
    this.audioKeys.clear();
    mediaAdapter.audio.stop();
  }

  private createLocalMedia(): LocalMedia {
    return new LocalMedia({
      adapter: mediaAdapter,
      onSendTrack: async (kind, track) => {
        await this.engine?.mesh?.setTrack(kind, track);
      },
      onChange: () => this.emit(),
    });
  }

  private createEngine(callId: string, maxPeers: number): CallEngine {
    const session = currentSession()!;
    return new CallEngine({
      callId,
      me: { userId: session.userId, deviceId: session.deviceId },
      adapter: mediaAdapter,
      maxPeers,
      callbacks: {
        onStatus: (p) => this.onServerStatus(p),
        onParticipant: (p) => this.onParticipant(p),
        onRinging: (from) => {
          if (this.call?.id === callId && this.call.kind === 'direct' && from.userId === this.call.peerId) {
            this.directEvent({ type: 'REMOTE_RINGING' });
          }
        },
        onBye: (from) => this.onBye(callId, from.deviceId, from.userId),
        admitPeer: (deviceId, userId) => this.admitPeer(callId, deviceId, userId),
        onPeerAdmitted: (deviceId) => {
          if (this.call?.id === callId && this.call.kind === 'direct' && this.call.isInitiator) {
            this.directEvent({ type: 'REMOTE_ACCEPTED', deviceId });
          }
        },
        onPeerState: (deviceId, state) => this.onPeerState(callId, deviceId, state),
        onChange: () => this.emit(),
        onLevels: (levels) => {
          if (this.call?.id !== callId) return;
          this.levels = levels;
          const speaker = pickActiveSpeaker(levels, this.speaker, Date.now());
          const changed = speaker.id !== this.speaker.id;
          this.speaker = speaker;
          // Re-render for the speaking rings; cheap enough at 2 Hz.
          if (changed || Object.values(levels).some((v) => v > 0)) this.emit();
        },
      },
    });
  }

  private startHeartbeat(callId: string) {
    if (this.timers.heartbeat) clearInterval(this.timers.heartbeat);
    this.timers.heartbeat = setInterval(async () => {
      const session = currentSession();
      if (!session || this.call?.id !== callId) return;
      const { data, error } = await supabase.rpc('call_heartbeat', { p_call_id: callId, p_device_id: session.deviceId });
      if (error || data !== false || this.call?.id !== callId) return;
      // The server says this device is no longer in the call.
      if (this.call.kind === 'group') this.groupEvent({ type: 'REMOVED' });
      else this.directEvent({ type: 'SERVER_STATUS', status: 'ended', myDeviceId: session.deviceId });
    }, HEARTBEAT_MS);
  }

  private startTick() {
    if (this.timers.tick) clearInterval(this.timers.tick);
    this.timers.tick = setInterval(() => {
      const c = this.call;
      if (c?.status === 'connected' || c?.status === 'reconnecting') {
        if (c.startedAt) {
          this.call = { ...c, duration: Math.floor((Date.now() - c.startedAt) / 1000) };
          this.emit();
        }
      }
    }, 1000);
  }

  private async sendPush(callId: string) {
    try {
      await supabase.functions.invoke('call-push', { body: { callId } });
    } catch {
      // Push is best effort (the callee may be online and ringing already).
    }
  }

  // ── 1:1 calls ─────────────────────────────────────────────────────────────

  async startCall(params: { conversationId: string; peerId: string; peerName: string; callType: CallType }): Promise<string> {
    if (this.busy()) throw new Error('You are already in a call');
    const session = currentSession();
    if (!session) throw new Error('Not signed in');

    if (session.isDemo) {
      this.resetForNewCall();
      const id = generateUUID();
      this.call = { id, kind: 'direct', ...params, isInitiator: true, status: 'calling', duration: 0 };
      this.timers.ring = setTimeout(() => this.directEvent({ type: 'RING_TIMEOUT' }), 4000);
      this.emit();
      return id;
    }

    const reason = mediaAdapter.unavailableReason();
    if (reason) throw new Error(reason);

    this.starting = true;
    prefetchIceServers();
    const local = this.createLocalMedia();
    let id: string;
    try {
      await local.start(params.callType === 'video');
      const { data, error } = await supabase.rpc('start_direct_call', {
        p_conversation_id: params.conversationId,
        p_call_type: params.callType,
        p_device_id: session.deviceId,
      });
      if (error) throw new Error(error.message);
      id = data as string;
    } catch (e) {
      local.stop();
      this.starting = false;
      throw e;
    }

    this.resetForNewCall();
    this.starting = false;
    this.local = local;
    this.speakerOn = params.callType === 'video';
    this.call = { id, kind: 'direct', ...params, isInitiator: true, status: 'calling', duration: 0 };
    const engine = this.createEngine(id, 1);
    this.engine = engine;
    void engine.open();
    void engine.startMedia(local);
    mediaAdapter.audio.startOutgoing(params.callType === 'video' ? 'video' : 'audio');
    mediaAdapter.audio.setSpeakerphone(this.speakerOn);
    this.timers.ring = setTimeout(() => this.directEvent({ type: 'RING_TIMEOUT' }), RING_TIMEOUT_MS);
    this.startHeartbeat(id);
    if (params.callType === 'video') void this.publishMediaState();
    void this.sendPush(id);
    this.emit();
    return id;
  }

  private onInvite(p: any) {
    if (!p || !UUID.test(String(p.call_id)) || !UUID.test(String(p.caller_id)) || !UUID.test(String(p.conversation_id))) {
      return;
    }
    if (p.is_group === true) {
      this.onGroupInvite(p);
      return;
    }
    const session = currentSession();
    if (!session || p.caller_id === session.userId) return;
    if (this.handled.has(p.call_id) || this.call?.id === p.call_id) return;

    if (this.busy() || shouldAutoBusy(this.call, p.call_id)) {
      // In another call: tell the caller right away, keep a missed-call entry.
      void supabase.rpc('update_call_status', { p_call_id: p.call_id, p_status: 'busy' });
      this.handled.add(p.call_id);
      void databaseService.addCallLog({
        id: p.call_id,
        peerId: p.caller_id,
        peerName: typeof p.caller_name === 'string' ? p.caller_name : 'Unknown caller',
        callType: p.call_type === 'video' ? 'video' : 'voice',
        direction: 'missed',
        duration: 0,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    this.resetForNewCall();
    const callerName = typeof p.caller_name === 'string' && p.caller_name ? p.caller_name : 'Unknown caller';
    this.names.set(p.caller_id, callerName);
    this.call = {
      id: p.call_id,
      kind: 'direct',
      conversationId: p.conversation_id,
      peerId: p.caller_id,
      peerName: callerName,
      peerDeviceId: UUID.test(String(p.caller_device_id)) ? p.caller_device_id : undefined,
      callType: p.call_type === 'video' ? 'video' : 'voice',
      isInitiator: false,
      status: 'ringing',
      duration: 0,
    };
    const engine = this.createEngine(p.call_id, 1);
    this.engine = engine;
    const callerDevice = this.call.peerDeviceId;
    void engine.open().then(() => {
      const c = this.call;
      if (callerDevice && c && c.id === p.call_id && c.status === 'ringing') engine.sendRinging(callerDevice);
    });
    prefetchIceServers();
    mediaAdapter.audio.startRingtone();
    this.timers.ring = setTimeout(() => this.directEvent({ type: 'RING_TIMEOUT' }), RING_TIMEOUT_MS);
    this.emit();
  }

  async acceptCall(): Promise<void> {
    const call = this.call;
    if (!call || call.isInitiator || call.status !== 'ringing') return;
    if (call.kind === 'group') return this.acceptGroupInvite();
    const session = currentSession();
    if (!session) return;
    mediaAdapter.audio.stopRingtone();

    const reason = mediaAdapter.unavailableReason();
    if (reason) {
      this.directEvent({ type: 'MEDIA_ERROR', message: reason });
      return;
    }
    const local = this.createLocalMedia();
    try {
      await local.start(call.callType === 'video');
    } catch (e) {
      local.stop();
      this.directEvent({ type: 'MEDIA_ERROR', message: (e as Error)?.message });
      return;
    }
    if (this.call?.id !== call.id || this.call.status !== 'ringing') {
      local.stop(); // cancelled while we asked for the microphone
      return;
    }
    this.local = local;
    this.speakerOn = call.callType === 'video';
    this.directEvent({ type: 'ACCEPT' });

    const { data: won, error } = await supabase.rpc('answer_call', { p_call_id: call.id, p_device_id: session.deviceId });
    if (this.call?.id !== call.id) return;
    if (error || won !== true) {
      // Someone else (another of my devices) was faster, or the caller hung up.
      const row = await this.fetchCallRow(call.id);
      this.directEvent({
        type: 'SERVER_STATUS',
        status: (row?.status as ServerCallStatus) ?? 'ended',
        answeredDeviceId: row?.answered_device_id ?? null,
        myDeviceId: session.deviceId,
      });
      if (this.call && !isCallFinished(this.call.status)) {
        this.directEvent({ type: 'SERVER_STATUS', status: 'ended', myDeviceId: session.deviceId });
      }
      return;
    }

    let callerDevice = call.peerDeviceId;
    if (!callerDevice) callerDevice = (await this.fetchCallRow(call.id))?.caller_device_id ?? undefined;
    if (!callerDevice) {
      this.directEvent({ type: 'MEDIA_ERROR', message: "The caller's app is out of date." });
      return;
    }
    this.call = { ...this.call, peerDeviceId: callerDevice };
    this.startHeartbeat(call.id);
    const engine = this.engine ?? this.createEngine(call.id, 1);
    this.engine = engine;
    await engine.open();
    await engine.startMedia(local);
    engine.connect(callerDevice, call.peerId, true);
    if (call.callType === 'video') void this.publishMediaState();
    this.emit();
  }

  async rejectCall(): Promise<void> {
    const call = this.call;
    if (!call || call.isInitiator) return;
    if (call.kind === 'group') this.groupEvent({ type: 'DECLINE' });
    else this.directEvent({ type: 'DECLINE' });
  }

  /** Hang up, cancel an outgoing call, decline an incoming one, or leave a group call. */
  async endCall(): Promise<void> {
    const call = this.call;
    if (!call || isCallFinished(call.status)) return;
    if (call.kind === 'group') this.groupEvent({ type: 'LEAVE' });
    else this.directEvent({ type: 'HANGUP' });
  }

  private directEvent(event: CallEvent) {
    const call = this.call;
    if (!call || call.kind !== 'direct') return;
    const prev = call.status;
    const { call: next, report } = transition(call, event);
    if (next === call) return;
    this.call = { ...call, ...next };
    const now = this.call;

    if (isCallFinished(now.status)) {
      void this.finish(report);
      return;
    }
    if (now.status === 'connecting' && prev !== 'connecting') {
      if (this.timers.ring) clearTimeout(this.timers.ring);
      this.timers.ring = null;
      this.timers.connect = setTimeout(() => this.directEvent({ type: 'CONNECT_TIMEOUT' }), CONNECT_TIMEOUT_MS);
      mediaAdapter.audio.startInCall(now.callType === 'video' ? 'video' : 'audio');
      mediaAdapter.audio.setSpeakerphone(this.speakerOn);
      void dismissCallNotifications(now.id);
    }
    if (now.status === 'connected' && prev !== 'connected') {
      if (this.timers.connect) clearTimeout(this.timers.connect);
      this.timers.connect = null;
      if (!this.timers.tick) this.startTick();
    }
    this.emit();
  }

  // ── Server / peer events ──────────────────────────────────────────────────

  private onServerStatus(p: any) {
    const call = this.call;
    if (!call || !p || p.call_id !== call.id) return;
    const session = currentSession();
    if (!session) return;
    const status = SERVER_STATUSES.includes(p.status) ? (p.status as ServerCallStatus) : null;
    if (!status) return;
    if (call.kind === 'group') {
      if (status === 'ended') this.groupEvent({ type: 'CALL_ENDED' });
      return;
    }
    this.directEvent({
      type: 'SERVER_STATUS',
      status,
      answeredDeviceId: typeof p.answered_device_id === 'string' ? p.answered_device_id : null,
      myDeviceId: session.deviceId,
    });
  }

  private onParticipant(p: any) {
    const call = this.call;
    const session = currentSession();
    if (!call || !session || isCallFinished(call.status)) return;
    const ev = parseParticipantEvent(p, call.id);
    if (!ev) return;
    if (ev.row.deviceId === session.deviceId) {
      // This device was dropped (e.g. I joined from another device).
      if (ev.action === 'left' && this.joined && call.kind === 'group') {
        this.joined = false;
        this.groupEvent({ type: 'REMOVED' });
      }
      return;
    }
    this.roster = applyParticipantEvent(this.roster, ev);
    if (ev.action === 'left') this.engine?.removePeer(ev.row.deviceId);
    if (ev.action === 'joined') void this.loadNames([ev.row.userId]);
    this.emit();
  }

  private onBye(callId: string, deviceId: string, userId: string) {
    const call = this.call;
    if (!call || call.id !== callId) return;
    if (call.kind === 'group') {
      const next = { ...this.roster };
      delete next[deviceId];
      this.roster = next;
      this.emit();
      return;
    }
    const session = currentSession();
    if (session && userId === call.peerId && deviceId === call.peerDeviceId && call.status !== 'calling' && call.status !== 'ringing') {
      this.directEvent({ type: 'SERVER_STATUS', status: 'ended', myDeviceId: session.deviceId });
    }
  }

  private async admitPeer(callId: string, deviceId: string, userId: string): Promise<boolean> {
    const call = this.call;
    if (!call || call.id !== callId || isCallFinished(call.status)) return false;
    if (call.kind === 'direct') {
      return userId === call.peerId && (!call.peerDeviceId || call.peerDeviceId === deviceId);
    }
    if (!this.joined) return false;
    if (this.roster[deviceId]?.userId === userId) return true;
    // Their join broadcast may not have reached us yet: ask the server.
    const { data } = await supabase
      .from('call_participants')
      .select('user_id, device_id, joined_at, audio_muted, video_enabled, screen_sharing')
      .eq('call_id', callId)
      .is('left_at', null);
    if (this.call?.id !== callId) return false;
    this.roster = { ...this.roster, ...rosterFromRows(data) };
    const ok = this.roster[deviceId]?.userId === userId;
    if (ok) void this.loadNames([userId]);
    return ok;
  }

  private onPeerState(callId: string, deviceId: string, state: PeerConnectionState) {
    const call = this.call;
    if (!call || call.id !== callId) return;
    if (call.kind === 'direct') {
      if (deviceId !== call.peerDeviceId && call.peerDeviceId) return;
      if (state === 'connected') this.directEvent({ type: 'MEDIA_CONNECTED' });
      else if (state === 'interrupted') this.directEvent({ type: 'MEDIA_INTERRUPTED' });
      else if (state === 'failed') this.directEvent({ type: 'MEDIA_FAILED' });
      return;
    }
    this.emit();
  }

  // ── Group calls ───────────────────────────────────────────────────────────

  /** Starts (or joins the already running) call of a group chat. */
  async startGroupCall(params: { conversationId: string; groupName: string; callType: CallType }): Promise<string> {
    if (this.busy()) throw new Error('You are already in a call');
    const session = currentSession();
    if (!session) throw new Error('Not signed in');
    if (session.isDemo) throw new Error('Group calls need a Vero account.');
    const reason = mediaAdapter.unavailableReason();
    if (reason) throw new Error(reason);

    this.starting = true;
    prefetchIceServers();
    const local = this.createLocalMedia();
    let id: string;
    try {
      await local.start(params.callType === 'video');
      const { data, error } = await supabase.rpc('start_group_call', {
        p_conversation_id: params.conversationId,
        p_call_type: params.callType,
        p_device_id: session.deviceId,
      });
      if (error) throw new Error(error.message);
      id = data as string;
    } catch (e) {
      local.stop();
      this.starting = false;
      throw e;
    }
    this.resetForNewCall();
    this.starting = false;
    this.local = local;
    this.speakerOn = true;
    this.call = {
      id,
      kind: 'group',
      conversationId: params.conversationId,
      peerId: params.conversationId,
      peerName: params.groupName,
      groupName: params.groupName,
      callType: params.callType,
      isInitiator: true,
      status: 'connecting',
      duration: 0,
    };
    this.emit();
    void this.sendPush(id);
    void this.enterGroupCall(id);
    return id;
  }

  /** Joins a live group call (e.g. from the group chat's "Join" button). */
  async joinGroupCall(params: { callId: string; conversationId: string; groupName: string; callType: CallType }): Promise<void> {
    if (this.call?.id === params.callId) {
      if (this.call.status === 'ringing') await this.acceptCall();
      return;
    }
    if (this.busy()) throw new Error('You are already in a call');
    const session = currentSession();
    if (!session) throw new Error('Not signed in');
    const reason = mediaAdapter.unavailableReason();
    if (reason) throw new Error(reason);
    this.starting = true;
    const local = this.createLocalMedia();
    try {
      await local.start(params.callType === 'video');
    } catch (e) {
      local.stop();
      this.starting = false;
      throw e;
    }
    this.resetForNewCall();
    this.starting = false;
    this.local = local;
    this.speakerOn = true;
    this.call = {
      id: params.callId,
      kind: 'group',
      conversationId: params.conversationId,
      peerId: params.conversationId,
      peerName: params.groupName,
      groupName: params.groupName,
      callType: params.callType,
      isInitiator: false,
      status: 'connecting',
      duration: 0,
    };
    this.emit();
    await this.enterGroupCall(params.callId);
  }

  private onGroupInvite(p: any) {
    const session = currentSession();
    if (!session || p.caller_id === session.userId) return;
    if (this.handled.has(p.call_id) || this.call?.id === p.call_id) return;
    if (this.busy()) return; // no "busy" for groups: the invite just isn't shown

    this.resetForNewCall();
    const groupName = typeof p.group_name === 'string' && p.group_name ? p.group_name : 'Group call';
    const inviterName = typeof p.caller_name === 'string' && p.caller_name ? p.caller_name : 'Someone';
    this.names.set(p.caller_id, inviterName);
    this.call = {
      id: p.call_id,
      kind: 'group',
      conversationId: p.conversation_id,
      peerId: p.conversation_id,
      peerName: groupName,
      groupName,
      inviterName,
      callType: p.call_type === 'video' ? 'video' : 'voice',
      isInitiator: false,
      status: 'ringing',
      duration: 0,
    };
    // Listen on call:<id> so the ringing stops if the call ends first.
    this.engine = this.createEngine(p.call_id, GROUP_CALL_MAX_PARTICIPANTS - 1);
    void this.engine.open();
    prefetchIceServers();
    mediaAdapter.audio.startRingtone();
    this.timers.ring = setTimeout(() => this.groupEvent({ type: 'RING_TIMEOUT' }), RING_TIMEOUT_MS);
    this.emit();
  }

  private async acceptGroupInvite(): Promise<void> {
    const call = this.call;
    if (!call || call.kind !== 'group' || call.status !== 'ringing') return;
    mediaAdapter.audio.stopRingtone();
    if (this.timers.ring) clearTimeout(this.timers.ring);
    this.timers.ring = null;
    const reason = mediaAdapter.unavailableReason();
    if (reason) {
      this.groupEvent({ type: 'JOIN_FAILED', message: reason });
      return;
    }
    this.groupEvent({ type: 'JOIN' });
    const local = this.createLocalMedia();
    try {
      await local.start(call.callType === 'video');
    } catch (e) {
      local.stop();
      this.groupEvent({ type: 'JOIN_FAILED', message: (e as Error)?.message || 'Microphone unavailable' });
      return;
    }
    if (this.call?.id !== call.id || isCallFinished(this.call.status)) {
      local.stop();
      return;
    }
    this.local = local;
    this.speakerOn = true;
    void dismissCallNotifications(call.id);
    await this.enterGroupCall(call.id);
  }

  private async enterGroupCall(callId: string): Promise<void> {
    const session = currentSession();
    const local = this.local;
    if (!session || !local) return;
    const engine = this.engine ?? this.createEngine(callId, GROUP_CALL_MAX_PARTICIPANTS - 1);
    this.engine = engine;
    await engine.open(); // before joining, so no participant broadcast is missed

    const { data, error } = await supabase.rpc('join_group_call', { p_call_id: callId, p_device_id: session.deviceId });
    if (this.call?.id !== callId || isCallFinished(this.call.status)) return;
    if (error) {
      this.groupEvent({
        type: 'JOIN_FAILED',
        message:
          error.code === '53400'
            ? `This call is full. Group calls are limited to ${GROUP_CALL_MAX_PARTICIPANTS} people.`
            : error.message || "Couldn't join the call",
      });
      return;
    }
    this.joined = true;
    this.roster = { ...rosterFromRows(data), ...this.roster };
    void this.loadNames(Object.values(this.roster).map((r) => r.userId));
    this.startHeartbeat(callId);

    await engine.startMedia(local);
    if (this.call?.id !== callId) return;
    // Newcomer offers to everyone already in the call.
    for (const p of remoteParticipants(this.roster, session.deviceId)) engine.connect(p.deviceId, p.userId, true);
    this.groupEvent({ type: 'JOINED' });
    mediaAdapter.audio.startInCall(this.call.callType === 'video' ? 'video' : 'audio');
    mediaAdapter.audio.setSpeakerphone(this.speakerOn);
    void this.publishMediaState();
  }

  private groupEvent(ev: GroupCallEvent) {
    const call = this.call;
    if (!call || call.kind !== 'group') return;
    const prev = call.status;
    const next = groupTransition(call, ev);
    if (next === call) return;
    this.call = { ...call, ...next };
    if (isCallFinished(this.call.status)) {
      void this.finish();
      return;
    }
    if (this.call.status === 'connected' && prev !== 'connected' && !this.timers.tick) this.startTick();
    this.emit();
  }

  /** The group's live call, if any (for the "Join" button in group chats). */
  async getLiveGroupCall(conversationId: string): Promise<{ callId: string; callType: CallType; participantCount: number } | null> {
    const session = currentSession();
    if (!session || session.isDemo) return null;
    const { data } = await supabase
      .from('call_sessions')
      .select('id, call_type')
      .eq('conversation_id', conversationId)
      .eq('is_group', true)
      .eq('status', 'active')
      .maybeSingle();
    if (!data) return null;
    const { count } = await supabase
      .from('call_participants')
      .select('id', { count: 'exact', head: true })
      .eq('call_id', data.id)
      .is('left_at', null);
    return { callId: data.id, callType: data.call_type === 'video' ? 'video' : 'voice', participantCount: count ?? 0 };
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  private inCall(): boolean {
    const s = this.call?.status;
    return !!this.local && (s === 'calling' || s === 'connecting' || s === 'connected' || s === 'reconnecting');
  }

  private async publishMediaState() {
    const session = currentSession();
    const call = this.call;
    const local = this.local;
    if (!session || !call || !local || session.isDemo) return;
    const st = local.state;
    await supabase.rpc('set_call_media_state', {
      p_call_id: call.id,
      p_device_id: session.deviceId,
      p_audio_muted: st.micMuted,
      p_video_enabled: st.cameraOn || st.screenSharing,
      p_screen_sharing: st.screenSharing,
    });
  }

  toggleMute(): void {
    if (!this.local || !this.inCall()) return;
    this.local.setMicMuted(!this.local.state.micMuted);
    void this.publishMediaState();
  }

  async setCameraOn(on: boolean): Promise<void> {
    if (!this.local || !this.inCall()) return;
    try {
      await this.local.setCameraOn(on);
      void this.publishMediaState();
    } catch (e) {
      this.showNotice((e as Error)?.message || 'Camera unavailable');
    }
  }

  async toggleCamera(): Promise<void> {
    await this.setCameraOn(!(this.local?.state.cameraOn ?? false));
  }

  async flipCamera(): Promise<void> {
    if (!this.local || !this.inCall()) return;
    try {
      await this.local.flipCamera();
    } catch (e) {
      this.showNotice((e as Error)?.message || "Couldn't switch camera");
    }
  }

  toggleSpeaker(): void {
    if (!this.inCall() || !mediaAdapter.audio.supportsSpeakerToggle) return;
    this.speakerOn = !this.speakerOn;
    mediaAdapter.audio.setSpeakerphone(this.speakerOn);
    this.emit();
  }

  async toggleScreenShare(): Promise<void> {
    const local = this.local;
    if (!local || !this.inCall()) return;
    if (local.state.screenSharing) {
      await local.stopScreenShare();
      void this.publishMediaState();
      return;
    }
    const support = mediaAdapter.screenShareSupport();
    if (!support.supported) {
      this.showNotice(support.reason || 'Screen sharing is not available here.');
      return;
    }
    try {
      await local.startScreenShare();
      void this.publishMediaState();
    } catch (e) {
      this.showNotice((e as Error)?.message || "Couldn't share the screen");
    }
  }

  // ── Finishing / history ───────────────────────────────────────────────────

  private async finish(report?: ServerCallStatus) {
    const call = this.call;
    if (!call || this.finishing === call.id) return;
    this.finishing = call.id;
    this.handled.add(call.id);
    const session = currentSession();
    const wasJoined = this.joined;
    this.joined = false;
    if (this.timers.ring) clearTimeout(this.timers.ring);
    if (this.timers.connect) clearTimeout(this.timers.connect);
    if (this.timers.tick) clearInterval(this.timers.tick);
    if (this.timers.heartbeat) clearInterval(this.timers.heartbeat);
    this.timers.ring = this.timers.connect = this.timers.tick = this.timers.heartbeat = null;

    if (session && !session.isDemo) {
      if (call.kind === 'direct' && report) {
        void supabase.rpc('update_call_status', { p_call_id: call.id, p_status: report });
      } else if (call.kind === 'group' && wasJoined) {
        void supabase.rpc('leave_call', { p_call_id: call.id, p_device_id: session.deviceId });
      }
    }
    this.releaseMedia();
    void dismissCallNotifications(call.id);
    this.emit();

    const direction =
      call.kind === 'direct'
        ? callLogDirection(call)
        : call.isInitiator
          ? 'outgoing'
          : call.startedAt
            ? 'incoming'
            : 'missed';
    await databaseService.addCallLog({
      id: call.id,
      peerId: call.kind === 'group' ? `group:${call.conversationId}` : call.peerId,
      peerName: call.peerName,
      callType: call.callType,
      direction,
      duration: call.duration,
      createdAt: new Date(call.startedAt ?? Date.now()).toISOString(),
    });

    this.timers.clear = setTimeout(() => {
      if (this.call?.id === call.id) {
        this.call = null;
        this.roster = {};
        this.emit();
      }
    }, 1500);
  }

  private async fetchCallRow(callId: string): Promise<any | null> {
    const { data } = await supabase
      .from('call_sessions')
      .select('id, conversation_id, caller_id, callee_id, caller_device_id, answered_device_id, call_type, status, is_group, created_at')
      .eq('id', callId)
      .maybeSingle();
    return data ?? null;
  }

  private async loadNames(userIds: string[]) {
    const missing = [...new Set(userIds)].filter((id) => !this.names.has(id));
    if (!missing.length) return;
    const { data } = await supabase.from('profiles').select('id, display_name').in('id', missing);
    for (const p of (data as any[]) ?? []) this.names.set(p.id, p.display_name || 'Participant');
    this.emit();
  }

  /** An incoming call that started while this device was offline / before sign-in finished. */
  private async checkPendingInvite() {
    const session = currentSession();
    if (!session || session.isDemo || this.busy()) return;
    const since = new Date(Date.now() - RING_TIMEOUT_MS).toISOString();
    const { data } = await supabase
      .from('call_sessions')
      .select('id, conversation_id, caller_id, caller_device_id, call_type, created_at')
      .eq('callee_id', session.userId)
      .eq('status', 'ringing')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return;
    await this.loadNames([data.caller_id]);
    this.onInvite({
      call_id: data.id,
      conversation_id: data.conversation_id,
      caller_id: data.caller_id,
      caller_device_id: data.caller_device_id,
      caller_name: this.names.get(data.caller_id),
      call_type: data.call_type,
      is_group: false,
    });
  }

  /** Taps on the incoming-call notification (app in background / closed). */
  private async onNotificationResponse(r: CallNotificationResponse) {
    const session = currentSession();
    if (!session || session.isDemo) return;
    const d: CallPushData = r.data;
    if (r.action === 'decline') {
      void dismissCallNotifications(d.callId);
      if (this.call?.id === d.callId) {
        await this.rejectCall();
      } else if (!d.isGroup) {
        await supabase.rpc('update_call_status', { p_call_id: d.callId, p_status: 'rejected' });
      }
      this.handled.add(d.callId);
      return;
    }
    if (this.call?.id !== d.callId) {
      // Trust the server, not the push payload: is the call still ringing / live?
      const row = await this.fetchCallRow(d.callId);
      const live = row && (row.is_group ? row.status === 'active' : row.status === 'ringing');
      if (!live) return;
      if (row.is_group) {
        const { data: conv } = await supabase.from('conversations').select('group_name').eq('id', row.conversation_id).maybeSingle();
        await this.loadNames([row.caller_id]);
        this.onGroupInvite({
          call_id: row.id,
          conversation_id: row.conversation_id,
          caller_id: row.caller_id,
          caller_name: this.names.get(row.caller_id),
          group_name: conv?.group_name ?? d.groupName,
          call_type: row.call_type,
        });
      } else {
        await this.loadNames([row.caller_id]);
        this.onInvite({
          call_id: row.id,
          conversation_id: row.conversation_id,
          caller_id: row.caller_id,
          caller_device_id: row.caller_device_id,
          caller_name: this.names.get(row.caller_id),
          call_type: row.call_type,
          is_group: false,
        });
      }
    }
    if (r.action === 'accept') await this.acceptCall();
  }

  /** Adds calls this device missed while offline (answered elsewhere, missed, cancelled) to the local log. */
  private async syncCallHistory() {
    const session = currentSession();
    if (!session || session.isDemo) return;
    try {
      const [{ data }, local] = await Promise.all([
        supabase
          .from('call_sessions')
          .select('id, caller_id, callee_id, call_type, status, created_at, answered_at, ended_at, is_group')
          .eq('is_group', false)
          .in('status', ['ended', 'missed', 'rejected', 'busy', 'cancelled', 'failed'])
          .order('created_at', { ascending: false })
          .limit(50),
        databaseService.getCallLogs(200),
      ]);
      const known = new Set(local.map((l) => l.id));
      const rows = ((data as any[]) ?? []).filter((r) => !known.has(r.id));
      if (!rows.length) return;
      const peers = rows.map((r) => (r.caller_id === session.userId ? r.callee_id : r.caller_id));
      await this.loadNames(peers);
      for (const r of rows) {
        const outgoing = r.caller_id === session.userId;
        const peerId = outgoing ? r.callee_id : r.caller_id;
        const duration =
          r.answered_at && r.ended_at
            ? Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.answered_at)) / 1000))
            : 0;
        await databaseService.addCallLog({
          id: r.id,
          peerId,
          peerName: this.names.get(peerId) ?? 'Unknown',
          callType: r.call_type === 'video' ? 'video' : 'voice',
          direction: outgoing ? 'outgoing' : r.answered_at ? 'incoming' : 'missed',
          duration,
          createdAt: r.created_at,
        });
      }
    } catch {
      // history sync is best effort
    }
  }
}

export const callService = new CallService();
