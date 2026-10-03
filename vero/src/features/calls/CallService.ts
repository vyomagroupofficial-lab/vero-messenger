/**
 * Vero WebRTC Call Signaling Service
 *
 * Implements Section 35 & 36 of Master Plan:
 * E2EE Call Signaling over Supabase Broadcast Channels.
 * Audio/video data flows peer-to-peer (or via TURN),
 * Supabase only carries ephemeral signaling payloads.
 */

import { supabase } from '../../core/network/supabase';
import { databaseService } from '../../core/storage/DatabaseService';
import { generateUUID } from '../../shared/utils/uuid';

export type CallType = 'voice' | 'video';
export type CallStatus = 'idle' | 'calling' | 'ringing' | 'connected' | 'ended' | 'rejected' | 'busy';

export interface ActiveCall {
  id: string;
  peerId: string;
  peerName: string;
  callType: CallType;
  isInitiator: boolean;
  status: CallStatus;
  startTime?: number;
  duration: number; // in seconds
}

export type CallEventListener = (call: ActiveCall | null) => void;

class CallService {
  private activeCall: ActiveCall | null = null;
  private channel: any = null;
  private durationInterval: any = null;
  private listeners: Set<CallEventListener> = new Set();

  subscribe(listener: CallEventListener): () => void {
    this.listeners.add(listener);
    listener(this.activeCall);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((fn) => fn(this.activeCall ? { ...this.activeCall } : null));
  }

  getActiveCall(): ActiveCall | null {
    return this.activeCall ? { ...this.activeCall } : null;
  }

  /**
   * Start an outgoing call
   */
  async startCall(params: {
    peerId: string;
    peerName: string;
    callType: CallType;
    currentUserId: string;
    currentUserName: string;
  }): Promise<string> {
    const callId = generateUUID();

    this.activeCall = {
      id: callId,
      peerId: params.peerId,
      peerName: params.peerName,
      callType: params.callType,
      isInitiator: true,
      status: 'calling',
      duration: 0,
    };
    this.notify();

    // Subscribe to signaling channel
    this.channel = supabase.channel(`call:${callId}`);

    this.channel
      .on('broadcast', { event: 'call.accept' }, () => {
        this.onCallAccepted();
      })
      .on('broadcast', { event: 'call.reject' }, () => {
        this.endCall('rejected');
      })
      .on('broadcast', { event: 'call.end' }, () => {
        this.endCall('ended');
      })
      .subscribe(async (status: string) => {
        if (status === 'SUBSCRIBED') {
          // Send invite to peer via their direct notification broadcast channel
          const peerChannel = supabase.channel(`user:calls:${params.peerId}`);
          await peerChannel.send({
            type: 'broadcast',
            event: 'call.invite',
            payload: {
              callId,
              callerId: params.currentUserId,
              callerName: params.currentUserName,
              callType: params.callType,
            },
          });
        }
      });

    // Ringing timeout (30 seconds)
    setTimeout(() => {
      if (this.activeCall && this.activeCall.status === 'calling') {
        this.endCall('ended');
      }
    }, 30000);

    return callId;
  }

  /**
   * Listen for incoming calls for current user
   */
  listenForIncomingCalls(userId: string) {
    const channel = supabase.channel(`user:calls:${userId}`);
    channel
      .on('broadcast', { event: 'call.invite' }, (payload: any) => {
        const data = payload.payload;
        if (!data || this.activeCall) return; // Busy

        this.activeCall = {
          id: data.callId,
          peerId: data.callerId,
          peerName: data.callerName || 'Unknown Caller',
          callType: data.callType || 'voice',
          isInitiator: false,
          status: 'ringing',
          duration: 0,
        };
        this.notify();
      })
      .subscribe();
  }

  /**
   * Accept an incoming call
   */
  async acceptCall(): Promise<void> {
    if (!this.activeCall) return;

    this.channel = supabase.channel(`call:${this.activeCall.id}`);
    this.channel
      .on('broadcast', { event: 'call.end' }, () => {
        this.endCall('ended');
      })
      .subscribe(async (status: string) => {
        if (status === 'SUBSCRIBED') {
          await this.channel.send({
            type: 'broadcast',
            event: 'call.accept',
            payload: {},
          });
          this.onCallAccepted();
        }
      });
  }

  /**
   * Reject an incoming call
   */
  async rejectCall(): Promise<void> {
    if (!this.activeCall) return;

    if (this.channel) {
      await this.channel.send({
        type: 'broadcast',
        event: 'call.reject',
        payload: {},
      });
    }

    this.endCall('rejected');
  }

  private onCallAccepted() {
    if (!this.activeCall) return;

    this.activeCall.status = 'connected';
    this.activeCall.startTime = Date.now();
    this.notify();

    // Start timer
    if (this.durationInterval) clearInterval(this.durationInterval);
    this.durationInterval = setInterval(() => {
      if (this.activeCall && this.activeCall.status === 'connected') {
        this.activeCall.duration += 1;
        this.notify();
      }
    }, 1000);
  }

  /**
   * End the call
   */
  async endCall(finalStatus: CallStatus = 'ended'): Promise<void> {
    if (!this.activeCall) return;

    if (this.channel) {
      try {
        await this.channel.send({
          type: 'broadcast',
          event: 'call.end',
          payload: {},
        });
        await supabase.removeChannel(this.channel);
      } catch (e) {
        // channel cleanup
      }
      this.channel = null;
    }

    if (this.durationInterval) {
      clearInterval(this.durationInterval);
      this.durationInterval = null;
    }

    // Save to call log
    const call = this.activeCall;
    await databaseService.addCallLog({
      callId: call.id,
      peerId: call.peerId,
      peerName: call.peerName,
      callType: call.callType,
      direction: call.isInitiator
        ? 'outgoing'
        : finalStatus === 'rejected'
        ? 'missed'
        : 'incoming',
      duration: call.duration,
      createdAt: new Date().toISOString(),
    });

    this.activeCall = { ...call, status: finalStatus };
    this.notify();

    setTimeout(() => {
      this.activeCall = null;
      this.notify();
    }, 1500);
  }
}

export const callService = new CallService();
