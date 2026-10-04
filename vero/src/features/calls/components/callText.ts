import type { TFunction } from 'i18next';
import type { ActiveCall } from '../CallService';

/** Localized call status; same cases as callStatusLabel() in callStateMachine.ts. */
export function callStatusText(t: TFunction, call: Pick<ActiveCall, 'status' | 'endReason' | 'isInitiator' | 'callType' | 'duration' | 'remoteRinging' | 'error'> | null): string {
  if (!call) return t('call.ended');
  switch (call.status) {
    case 'calling':
      return call.remoteRinging ? t('call.ringing') : t('call.calling');
    case 'ringing':
      return call.isInitiator ? t('call.ringing') : call.callType === 'video' ? t('call.incomingVideo') : t('call.incomingVoice');
    case 'connecting':
      return t('call.connecting');
    case 'connected': {
      const d = call.duration || 0;
      const h = Math.floor(d / 3600);
      const mm = String(Math.floor((d % 3600) / 60)).padStart(2, '0');
      const ss = String(d % 60).padStart(2, '0');
      return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }
    case 'reconnecting':
      return t('call.reconnecting');
  }
  switch (call.endReason) {
    case 'declined':
      return t('call.declined');
    case 'busy':
      return t('call.busy');
    case 'no_answer':
      return call.isInitiator ? t('call.noAnswer') : t('call.missed');
    case 'cancelled':
      return call.isInitiator ? t('call.cancelled') : t('call.missed');
    case 'answered_elsewhere':
      return t('call.answeredElsewhere');
    case 'declined_elsewhere':
      return t('call.declinedElsewhere');
    case 'connection_lost':
      return t('call.connectionLost');
    case 'connection_failed':
      return t('call.cantConnect');
    case 'media_error':
      return call.error || t('call.mediaError');
    case 'error':
      return call.error || t('call.failed');
    default:
      return call.status === 'failed' ? t('call.failed') : t('call.ended');
  }
}
