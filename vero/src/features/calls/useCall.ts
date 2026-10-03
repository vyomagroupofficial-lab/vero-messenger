/**
 * React access to the current call: a live snapshot plus the controls, all
 * wired to the real media tracks (see CallService / LocalMedia).
 *
 *   const { call, toggleMute, toggleCamera, hangUp } = useCall();
 */

import { useEffect, useMemo, useState } from 'react';
import { callService, type ActiveCall, type CallType } from './CallService';

export interface CallControls {
  accept(): Promise<void>;
  decline(): Promise<void>;
  hangUp(): Promise<void>;
  toggleMute(): void;
  toggleCamera(): Promise<void>;
  flipCamera(): Promise<void>;
  toggleSpeaker(): void;
  toggleScreenShare(): Promise<void>;
  startCall(params: { conversationId: string; peerId: string; peerName: string; callType: CallType }): Promise<string>;
  startGroupCall(params: { conversationId: string; groupName: string; callType: CallType }): Promise<string>;
}

export function useCall(): { call: ActiveCall | null } & CallControls {
  const [call, setCall] = useState<ActiveCall | null>(() => callService.getActiveCall());
  useEffect(() => callService.subscribe(setCall), []);

  const controls = useMemo<CallControls>(
    () => ({
      accept: () => callService.acceptCall(),
      decline: () => callService.rejectCall(),
      hangUp: () => callService.endCall(),
      toggleMute: () => callService.toggleMute(),
      toggleCamera: () => callService.toggleCamera(),
      flipCamera: () => callService.flipCamera(),
      toggleSpeaker: () => callService.toggleSpeaker(),
      toggleScreenShare: () => callService.toggleScreenShare(),
      startCall: (p) => callService.startCall(p),
      startGroupCall: (p) => callService.startGroupCall(p),
    }),
    []
  );

  return { call, ...controls };
}
