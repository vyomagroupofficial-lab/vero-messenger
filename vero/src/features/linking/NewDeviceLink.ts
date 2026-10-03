/**
 * Signed-out side of "Link a device with a QR code" (web / desktop / a
 * second phone):
 *
 *   1. make an ephemeral X25519 key pair + random 32-byte secret S
 *   2. register a link request with sha256(claimKey(S)) and show the QR
 *        vero-link:<linkId>:<S>:<ephemeralPub>
 *   3. poll with claimKey; once a signed-in phone approves, the first poll
 *      returns a one-time magic-link token hash -> verifyOtp -> session
 *   4. register THIS device's own identity keys (normal registration)
 *   5. receive the recent history the phone encrypted to the ephemeral key
 *
 * The QR is renewed automatically when it expires (2 minutes).
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import { supabase } from '../../core/network/supabase';
import { getSodium } from '../../core/crypto/sodium';
import { buildLinkQr } from './qrPayloads';
import { deviceLinkApi } from './deviceLinkApi';
import { adoptCurrentSession } from './adoptSession';
import {
  EphemeralKeyPair,
  claimKeyHash,
  deriveClaimKey,
  generateEphemeralKeyPair,
  generateQrSecret,
} from '../transfer/transferCrypto';
import { TransferProgress, receiveSnapshot, CancelToken } from '../transfer/TransferService';

export type LinkPhase = 'creating' | 'waiting' | 'signing-in' | 'history' | 'done' | 'error' | 'stopped';

export interface LinkState {
  phase: LinkPhase;
  qr?: string;
  expiresAt?: number;
  error?: string;
  progress?: TransferProgress;
  /** true when signed in but the history could not be received */
  historyFailed?: boolean;
}

const POLL_MS = 2000;
const MAX_QR_RENEWALS = 5;

function linkDeviceLabel(): string {
  if (Platform.OS === 'web') {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isElectron = /Electron/i.test(ua);
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Web';
    return isElectron ? `Vero Desktop (${os})` : `${browser} on ${os}`;
  }
  return (Device.modelName || Device.deviceName || 'New device').slice(0, 64);
}

export class NewDeviceLinkSession {
  private state: LinkState = { phase: 'creating' };
  private linkId: string | null = null;
  private claimKey: string | null = null;
  private secret: string | null = null;
  private keyPair: EphemeralKeyPair | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private renewals = 0;
  private readonly cancel: CancelToken = { cancelled: false };
  private historySkipped = false;
  private stopped = false;

  constructor(private readonly onChange: (s: LinkState) => void) {}

  private set(patch: Partial<LinkState>) {
    this.state = { ...this.state, ...patch };
    if (!this.stopped) this.onChange(this.state);
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    this.set({ phase: 'creating', error: undefined });
    try {
      const sodium = await getSodium();
      this.keyPair = generateEphemeralKeyPair(sodium);
      this.secret = generateQrSecret(sodium);
      this.claimKey = deriveClaimKey(sodium, this.secret);
      const { linkId, expiresAt } = await deviceLinkApi.create({
        secretHash: claimKeyHash(this.claimKey),
        publicKey: this.keyPair.publicKey,
        deviceLabel: linkDeviceLabel(),
      });
      this.linkId = linkId;
      this.set({
        phase: 'waiting',
        qr: buildLinkQr({ linkId, secret: this.secret, publicKey: this.keyPair.publicKey }),
        expiresAt: new Date(expiresAt).getTime(),
      });
      this.schedule();
    } catch (e) {
      this.set({ phase: 'error', error: (e as Error)?.message || 'Could not create a link code' });
    }
  }

  /** Shows a fresh QR code (after an error or when the user asks). */
  async restart(): Promise<void> {
    this.renewals = 0;
    this.clearTimer();
    await this.start();
  }

  private schedule() {
    this.clearTimer();
    if (!this.stopped) this.timer = setTimeout(() => void this.poll(), POLL_MS);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.linkId || !this.claimKey) return;
    let res: Awaited<ReturnType<typeof deviceLinkApi.poll>>;
    try {
      res = await deviceLinkApi.poll({ linkId: this.linkId, claimKey: this.claimKey });
    } catch {
      this.schedule(); // transient network error: keep waiting
      return;
    }
    if (this.stopped) return;

    if (res.status === 'pending') {
      if (this.state.expiresAt && Date.now() > this.state.expiresAt + 3000) return this.renew();
      return this.schedule();
    }
    if (res.status === 'approved' && res.tokenHash) return this.signIn(res.tokenHash);
    // expired / used / invalid: show a new code
    return this.renew();
  }

  private async renew(): Promise<void> {
    if (++this.renewals > MAX_QR_RENEWALS) {
      this.set({ phase: 'error', qr: undefined, error: 'The code expired. Tap "New code" to try again.' });
      return;
    }
    await this.start();
  }

  private async signIn(tokenHash: string): Promise<void> {
    this.set({ phase: 'signing-in', qr: undefined });
    try {
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
      if (error) throw error;
      const result = await adoptCurrentSession();
      if (!result.success || !result.user) throw new Error(result.error || 'Sign-in failed');

      this.set({ phase: 'history', progress: { phase: 'waiting', done: 0, total: null } });
      try {
        await receiveSnapshot({
          requestId: this.linkId!,
          secret: this.secret!,
          keyPair: this.keyPair!,
          userId: result.user.id,
          cancel: this.cancel,
          onProgress: (progress) => this.set({ progress }),
        });
        this.set({ phase: 'done' });
      } catch (e) {
        if (this.historySkipped) return;
        console.warn('[DeviceLink] history transfer failed:', (e as Error)?.message);
        this.set({ phase: 'done', historyFailed: true });
      }
    } catch (e) {
      this.set({ phase: 'error', error: (e as Error)?.message || 'Sign-in failed' });
    } finally {
      this.wipeSecrets();
    }
  }

  /** Continue without waiting for the history (it is then discarded). */
  skipHistory(): void {
    this.historySkipped = true;
    this.cancel.cancelled = true;
    this.set({ phase: 'done', historyFailed: true });
  }

  stop(): void {
    const wasWaiting = this.state.phase === 'waiting';
    this.stopped = true;
    this.cancel.cancelled = true;
    this.clearTimer();
    if (wasWaiting && this.linkId && this.claimKey) {
      void deviceLinkApi.cancel({ linkId: this.linkId, claimKey: this.claimKey }).catch(() => undefined);
    }
    if (this.state.phase !== 'history') this.wipeSecrets();
  }

  private wipeSecrets() {
    this.secret = null;
    this.keyPair = null;
    this.claimKey = null;
  }
}
