/**
 * Client for the device-link Edge Function (supabase/functions/device-link).
 */

import { supabase } from '../../core/network/supabase';

export class DeviceLinkError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'DeviceLinkError';
  }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('device-link', { body });
  if (error) {
    let message = error.message || 'Request failed';
    let status: number | undefined;
    const ctx = (error as any).context;
    if (ctx && typeof ctx.json === 'function') {
      status = ctx.status;
      try {
        const parsed = await ctx.json();
        if (parsed?.error) message = parsed.error;
      } catch {
        // not JSON
      }
    }
    throw new DeviceLinkError(message, status);
  }
  return data as T;
}

export type LinkPollStatus = 'pending' | 'approved' | 'expired' | 'used' | 'invalid';

export const deviceLinkApi = {
  create: (p: { secretHash: string; publicKey: string; deviceLabel?: string }) =>
    call<{ linkId: string; expiresAt: string }>({ action: 'create', ...p }),

  poll: (p: { linkId: string; claimKey: string }) =>
    call<{ status: LinkPollStatus; tokenHash?: string }>({ action: 'poll', ...p }),

  cancel: (p: { linkId: string; claimKey: string }) => call<{ ok: true }>({ action: 'cancel', ...p }),

  inspect: (linkId: string) =>
    call<{ deviceLabel: string | null; createdAt: string; expiresAt: string }>({ action: 'inspect', linkId }),

  approve: (p: { linkId: string; publicKey: string; deviceId: string; senderPublicKey: string }) =>
    call<{ expiresAt: string }>({ action: 'approve', ...p }),
};
