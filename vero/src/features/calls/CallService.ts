/**
 * Vero call signalling.
 *
 * - The caller creates the call with the `start_call` RPC; the server
 *   authorises it (direct chat, not blocked) and delivers `call.invite` on the
 *   callee's private `user:<id>` topic.
 * - Both sides then use the private `call:<id>` topic (only the two
 *   participants are authorised) for accept / reject / end.
 *
 * NOTE: audio/video transport (WebRTC) is not wired up yet; this service
 * covers ringing, answering and call history. See README "Roadmap".
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../../core/network/supabase';
import { privateChannel, userChannel } from '../../core/network/realtime';
import { currentSession } from '../../core/session';
import { databaseService } from '../../core/storage/DatabaseService';
import { generateUUID } from '../../shared/utils/uuid';

export type CallType = 'voice' | 'video';
export type CallStatus = 'calling' | 'ringing' | 'connected' | 'ended' | 'rejected' | 'missed' | 'failed';

export interface ActiveCall {
  id: string;
  conversationId: string;
  peerId: string;
  peerName: string;
  callType: CallType;
  isInitiator: boolean;
  status: CallStatus;
  startedAt?: number;
  duration: number;
  error?: string;
}

export type CallListener = (call: ActiveCall | null) => void;

/** Real-time media isn't implemented yet; the UI uses this to be upfront about it. */
export const CALL_MEDIA_AVAILABLE = false;

const RING_TIMEOUT_MS = 45_000;

class CallService {
  private call: ActiveCall | null = null;
  private channel: RealtimeChannel | null = null;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<CallListener>();
  private unsubscribeInvites: (() => void) | null = null;

  subscribe(listener: CallListener): () => void {
    this.listeners.add(listener);
    listener(this.getActiveCall());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getActiveCall(): ActiveCall | null {
    return this.call ? { ...this.call } : null;
  }

  private update(patch: Partial<ActiveCall> | null) {
    this.call = patch === null || !this.call ? (patch as ActiveCall | null) : { ...this.call, ...patch };
    const snapshot = this.getActiveCall();
    this.listeners.forEach((l) => l(snapshot));
  }

  /** Start listening for invites (call once after sign-in). */
  start(): void {
    this.unsubscribeInvites?.();
    this.unsubscribeInvites = userChannel.on('call.invite', (p) => this.onInvite(p));
  }

  stop(): void {
    this.unsubscribeInvites?.();
    this.unsubscribeInvites = null;
    if (this.call) void this.teardown();
    this.update(null);
  }

  async startCall(params: { conversationId: string; peerId: string; peerName: string; callType: CallType }): Promise<string> {
    if (this.call && !this.isFinished()) throw new Error('You are already in a call');
    this.resetTimers();
    const session = currentSession();
    if (!session) throw new Error('Not signed in');

    if (session.isDemo) {
      const id = generateUUID();
      this.update({ id, ...params, isInitiator: true, status: 'calling', duration: 0 });
      this.ringTimer = setTimeout(() => void this.finish('missed'), 4000);
      return id;
    }

    const { data, error } = await supabase.rpc('start_call', {
      p_conversation_id: params.conversationId,
      p_call_type: params.callType,
    });
    if (error) throw new Error(error.message);
    const id = data as string;

    this.update({ id, ...params, isInitiator: true, status: 'calling', duration: 0 });
    this.joinChannel(id);
    this.ringTimer = setTimeout(() => {
      if (this.call?.id === id && this.call.status === 'calling') void this.finish('missed', true);
    }, RING_TIMEOUT_MS);
    return id;
  }

  private onInvite(p: any) {
    if (!p?.call_id || !p?.caller_id) return;
    if (this.call && !this.isFinished()) {
      // Busy: decline the new call.
      void supabase.rpc('update_call_status', { p_call_id: p.call_id, p_status: 'rejected' });
      return;
    }
    this.resetTimers();
    this.update({
      id: p.call_id,
      conversationId: p.conversation_id,
      peerId: p.caller_id,
      peerName: p.caller_name || 'Unknown caller',
      callType: p.call_type === 'video' ? 'video' : 'voice',
      isInitiator: false,
      status: 'ringing',
      duration: 0,
    });
    this.joinChannel(p.call_id);
    this.ringTimer = setTimeout(() => {
      if (this.call && this.call.id === p.call_id && this.call.status === 'ringing') void this.finish('missed');
    }, RING_TIMEOUT_MS);
  }

  private joinChannel(callId: string) {
    this.leaveChannel();
    const channel = privateChannel(`call:${callId}`);
    channel
      .on('broadcast', { event: 'call.accept' }, () => {
        if (this.call?.id === callId && this.call.isInitiator) this.onConnected();
      })
      .on('broadcast', { event: 'call.reject' }, () => {
        if (this.call?.id === callId) void this.finish('rejected');
      })
      .on('broadcast', { event: 'call.end' }, () => {
        if (this.call?.id === callId) void this.finish(this.call.status === 'connected' ? 'ended' : 'missed');
      })
      .subscribe();
    this.channel = channel;
  }

  async acceptCall(): Promise<void> {
    if (!this.call || this.call.isInitiator || this.call.status !== 'ringing') return;
    await this.signal('call.accept');
    void supabase.rpc('update_call_status', { p_call_id: this.call.id, p_status: 'active' });
    this.onConnected();
  }

  async rejectCall(): Promise<void> {
    if (!this.call || this.call.isInitiator) return;
    await this.signal('call.reject');
    await this.finish('rejected', true);
  }

  /** Hang up (or cancel an outgoing call). */
  async endCall(): Promise<void> {
    if (!this.call || this.isFinished()) return;
    const status: CallStatus = this.call.status === 'connected' ? 'ended' : this.call.isInitiator ? 'missed' : 'rejected';
    await this.signal(this.call.isInitiator || this.call.status === 'connected' ? 'call.end' : 'call.reject');
    await this.finish(status, true);
  }

  private onConnected() {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = null;
    this.update({ status: 'connected', startedAt: Date.now(), duration: 0 });
    if (this.tick) clearInterval(this.tick);
    this.tick = setInterval(() => {
      if (this.call?.status === 'connected' && this.call.startedAt) {
        this.update({ duration: Math.floor((Date.now() - this.call.startedAt) / 1000) });
      }
    }, 1000);
  }

  private async signal(event: 'call.accept' | 'call.reject' | 'call.end') {
    try {
      await this.channel?.send({ type: 'broadcast', event, payload: {} });
    } catch {
      // the server-side status update still records the outcome
    }
  }

  private isFinished(): boolean {
    return !!this.call && ['ended', 'rejected', 'missed', 'failed'].includes(this.call.status);
  }

  private async finish(status: CallStatus, reportToServer = false) {
    const call = this.call;
    if (!call || this.isFinished()) return;
    this.resetTimers();
    if (reportToServer && !currentSession()?.isDemo) {
      const serverStatus = status === 'ended' ? 'ended' : status === 'rejected' ? 'rejected' : 'missed';
      void supabase.rpc('update_call_status', { p_call_id: call.id, p_status: serverStatus });
    }
    await this.teardown();

    await databaseService.addCallLog({
      id: call.id,
      peerId: call.peerId,
      peerName: call.peerName,
      callType: call.callType,
      direction: call.isInitiator ? 'outgoing' : call.status === 'connected' ? 'incoming' : 'missed',
      duration: call.duration,
      createdAt: new Date(call.startedAt ?? Date.now()).toISOString(),
    });

    this.update({ status });
    this.clearTimer = setTimeout(() => {
      if (this.call?.id === call.id) this.update(null);
    }, 1500);
  }

  private async teardown() {
    this.leaveChannel();
  }

  private leaveChannel() {
    if (this.channel) void supabase.removeChannel(this.channel);
    this.channel = null;
  }

  private resetTimers() {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    if (this.tick) clearInterval(this.tick);
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.ringTimer = this.tick = this.clearTimer = null;
  }
}

export const callService = new CallService();
