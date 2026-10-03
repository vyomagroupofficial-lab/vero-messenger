/**
 * The two sides of "scan a QR, then move data":
 *
 *   approveLinkAndSendHistory  phone approves a new web/desktop device
 *                              (device-link Edge Function) and sends it recent
 *                              history.
 *   approveTransferAndSend     old phone approves a transfer request created by
 *                              the user's new phone and sends everything.
 *   TransferReceiver           new phone: creates the request + QR, waits,
 *                              imports. Its ephemeral secrets are kept in the
 *                              keystore until done, so it can resume after an
 *                              app restart.
 */

import { supabase } from '../../core/network/supabase';
import { getSodium } from '../../core/crypto/sodium';
import { secureStorage } from '../../core/storage/secureStorage';
import { requireSession } from '../../core/session';
import { deviceLinkApi } from '../linking/deviceLinkApi';
import { buildTransferQr } from '../linking/qrPayloads';
import { EphemeralKeyPair, generateEphemeralKeyPair, generateQrSecret } from './transferCrypto';
import {
  CancelToken,
  LINK_HISTORY_PER_CHAT,
  TransferProgress,
  buildSnapshot,
  cancelTransfer,
  receiveSnapshot,
  sendSnapshot,
} from './TransferService';

export async function approveLinkAndSendHistory(
  payload: { linkId: string; secret: string; publicKey: string },
  opts: { onApproved?: () => void; onProgress?: (p: TransferProgress) => void; cancel?: CancelToken } = {}
): Promise<void> {
  const session = requireSession();
  const sodium = await getSodium();
  const senderKeyPair = generateEphemeralKeyPair(sodium);
  await deviceLinkApi.approve({
    linkId: payload.linkId,
    publicKey: payload.publicKey,
    deviceId: session.deviceId,
    senderPublicKey: senderKeyPair.publicKey,
  });
  opts.onApproved?.();
  opts.onProgress?.({ phase: 'preparing', done: 0, total: null });
  const snapshot = await buildSnapshot(session.userId, 'history', LINK_HISTORY_PER_CHAT);
  await sendSnapshot({
    requestId: payload.linkId,
    receiverPublicKey: payload.publicKey,
    secret: payload.secret,
    senderKeyPair,
    snapshot,
    onProgress: opts.onProgress,
    cancel: opts.cancel,
  });
}

export async function approveTransferAndSend(
  payload: { transferId: string; secret: string; publicKey: string },
  opts: { onProgress?: (p: TransferProgress) => void; cancel?: CancelToken } = {}
): Promise<void> {
  const session = requireSession();
  const sodium = await getSodium();
  const senderKeyPair = generateEphemeralKeyPair(sodium);
  const { error } = await supabase.rpc('approve_transfer_request', {
    p_id: payload.transferId,
    p_ephemeral_public_key: payload.publicKey,
    p_device_id: session.deviceId,
    p_sender_public_key: senderKeyPair.publicKey,
  });
  if (error) {
    if (error.code === 'P0002') {
      throw new Error('This QR code has expired or was already used, or it belongs to another account.');
    }
    throw error;
  }
  opts.onProgress?.({ phase: 'preparing', done: 0, total: null });
  const snapshot = await buildSnapshot(session.userId, 'full');
  try {
    await sendSnapshot({
      requestId: payload.transferId,
      receiverPublicKey: payload.publicKey,
      secret: payload.secret,
      senderKeyPair,
      snapshot,
      onProgress: opts.onProgress,
      cancel: opts.cancel,
    });
  } catch (e) {
    // A half-sent transfer can't be resumed by another sender key: cancel it so
    // the new phone shows a clear error and can start over.
    await cancelTransfer(payload.transferId).catch(() => undefined);
    throw e;
  }
}

interface PendingTransfer {
  requestId: string;
  secret: string;
  keyPair: EphemeralKeyPair;
  expiresAt: string;
}

const pendingKey = (userId: string) => `vero.${userId}.pending_transfer`;

export class TransferReceiver {
  private pending: PendingTransfer | null = null;
  private received = new Map<number, string>();
  readonly cancel: CancelToken = { cancelled: false };

  /** Resumes an unfinished transfer or creates a new request. Returns the QR text. */
  async prepare(forceNew = false): Promise<{ qr: string; expiresAt: string; resumed: boolean }> {
    const session = requireSession();
    if (!forceNew) {
      const saved = await secureStorage.get(pendingKey(session.userId)).catch(() => null);
      if (saved) {
        try {
          const p = JSON.parse(saved) as PendingTransfer;
          const { data } = await supabase
            .from('device_link_requests')
            .select('status, expires_at, data_expires_at')
            .eq('id', p.requestId)
            .maybeSingle();
          const usable =
            data &&
            new Date(data.data_expires_at).getTime() > Date.now() &&
            (data.status === 'approved' || (data.status === 'pending' && new Date(data.expires_at).getTime() > Date.now()));
          if (usable) {
            this.pending = p;
            return { qr: this.qr(p), expiresAt: p.expiresAt, resumed: data.status === 'approved' };
          }
        } catch {
          // fall through to a new request
        }
        await secureStorage.remove(pendingKey(session.userId)).catch(() => undefined);
      }
    }

    const sodium = await getSodium();
    const keyPair = generateEphemeralKeyPair(sodium);
    const secret = generateQrSecret(sodium);
    const { data, error } = await supabase.rpc('create_transfer_request', { p_ephemeral_public_key: keyPair.publicKey });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    const p: PendingTransfer = { requestId: row.id, secret, keyPair, expiresAt: row.expires_at };
    await secureStorage.set(pendingKey(session.userId), JSON.stringify(p));
    this.pending = p;
    this.received.clear();
    return { qr: this.qr(p), expiresAt: p.expiresAt, resumed: false };
  }

  private qr(p: PendingTransfer): string {
    return buildTransferQr({ transferId: p.requestId, secret: p.secret, publicKey: p.keyPair.publicKey });
  }

  /** Waits for the old phone, then downloads and imports. Safe to call again after an error. */
  async receive(onProgress?: (p: TransferProgress) => void): Promise<{ rows: number }> {
    const session = requireSession();
    if (!this.pending) throw new Error('No transfer in progress');
    const result = await receiveSnapshot({
      requestId: this.pending.requestId,
      secret: this.pending.secret,
      keyPair: this.pending.keyPair,
      userId: session.userId,
      onProgress,
      cancel: this.cancel,
      received: this.received,
    });
    await secureStorage.remove(pendingKey(session.userId)).catch(() => undefined);
    this.pending = null;
    return { rows: result.rows };
  }

  async abort(): Promise<void> {
    this.cancel.cancelled = true;
    const p = this.pending;
    this.pending = null;
    const session = requireSession();
    await secureStorage.remove(pendingKey(session.userId)).catch(() => undefined);
    if (p) await cancelTransfer(p.requestId).catch(() => undefined);
  }
}
