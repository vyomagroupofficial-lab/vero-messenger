/**
 * Payments: the user's own UPI id (device keystore only), payment cards in
 * chat, opening UPI apps, reporting results, payment history (local), and
 * the optional Razorpay payment-link flow.
 *
 * Nothing about a UPI payment is stored on the server: the card and every
 * status update are E2EE messages.
 */

import { Linking, Platform } from 'react-native';
import * as ExpoCrypto from 'expo-crypto';
import { supabase } from '../../core/network/supabase';
import { requireSession } from '../../core/session';
import { databaseService } from '../../core/storage/DatabaseService';
import { secureStorage } from '../../core/storage/secureStorage';
import type { Message } from '../../shared/models/Message';
import type { MessageExt, PaymentCard, PaymentStatus } from '../../shared/models/payloadExtensions';
import { messageRepository } from '../messages/MessageRepository';
import { useMessagesStore } from '../messages/useMessagesStore';
import { functionError } from '../stickers/extMedia';
import { applyPaymentUpdate } from './paymentCard';
import { generatePaymentRef, normalizeVpa, sanitizeUpiText, upiUrlForCard } from './upi';

export interface MyUpiProfile {
  vpa: string;
  name: string;
}

const key = (userId: string) => `vero.${userId}.upi_profile`;
const random = (n: number) => ExpoCrypto.getRandomBytes(n);

type PaymentMessage = Message & { ext: Extract<MessageExt, { t: 'payment' }> };

export function isPaymentMessage(m: Message | null | undefined): m is PaymentMessage {
  return !!m && m.messageType === 'payment' && m.ext?.t === 'payment';
}

class PaymentService {
  // ── My UPI id (never leaves the device except inside E2EE payment cards) ──

  async getMyUpi(): Promise<MyUpiProfile | null> {
    const raw = await secureStorage.get(key(requireSession().userId));
    if (!raw) return null;
    try {
      const p = JSON.parse(raw);
      return typeof p?.vpa === 'string' ? { vpa: p.vpa, name: typeof p.name === 'string' ? p.name : '' } : null;
    } catch {
      return null;
    }
  }

  async setMyUpi(vpaInput: string, name: string): Promise<MyUpiProfile> {
    const vpa = normalizeVpa(vpaInput);
    if (!vpa) throw new Error('That doesn’t look like a UPI id (for example name@okbank).');
    const profile = { vpa, name: sanitizeUpiText(name, 64) };
    await secureStorage.set(key(requireSession().userId), JSON.stringify(profile));
    return profile;
  }

  async clearMyUpi(): Promise<void> {
    await secureStorage.remove(key(requireSession().userId));
  }

  // ── Creating cards ─────────────────────────────────────────────────────────

  newRef(): string {
    return generatePaymentRef(random);
  }

  /** "Request money": the card carries MY UPI id so the other side can pay it. */
  async requestMoney(conversationId: string, amountPaise: number, note: string, to?: string): Promise<Message | null> {
    const me = await this.getMyUpi();
    if (!me) throw new Error('Add your UPI id in Settings → Payments first.');
    const card: PaymentCard = {
      ref: this.newRef(),
      kind: 'request',
      method: 'upi',
      amountPaise,
      currency: 'INR',
      note: sanitizeUpiText(note, 80) || undefined,
      payeeVpa: me.vpa,
      payeeName: me.name || requireSession().displayName,
      to,
    };
    return useMessagesStore.getState().send(conversationId, { t: 'payment', card });
  }

  /** "Pay": a card describing a payment I'm making to someone's UPI id. */
  async pay(
    conversationId: string,
    input: { amountPaise: number; note: string; payeeVpa: string; payeeName?: string; to?: string }
  ): Promise<Message | null> {
    const vpa = normalizeVpa(input.payeeVpa);
    if (!vpa) throw new Error('Enter a valid UPI id for the person you’re paying.');
    const card: PaymentCard = {
      ref: this.newRef(),
      kind: 'pay',
      method: 'upi',
      amountPaise: input.amountPaise,
      currency: 'INR',
      note: sanitizeUpiText(input.note, 80) || undefined,
      payeeVpa: vpa,
      payeeName: input.payeeName ? sanitizeUpiText(input.payeeName, 64) : undefined,
      to: input.to,
    };
    return useMessagesStore.getState().send(conversationId, { t: 'payment', card });
  }

  /** The most recent UPI id this person shared with me in this chat (to prefill "Pay"). */
  async knownPayee(conversationId: string, otherUserId: string): Promise<{ vpa: string; name?: string } | null> {
    const list = await databaseService.getMessagesByType('payment', 200);
    for (const m of list) {
      if (m.conversationId !== conversationId || !isPaymentMessage(m)) continue;
      const c = m.ext.card;
      if (c.kind === 'request' && m.senderUserId === otherUserId && c.payeeVpa) return { vpa: c.payeeVpa, name: c.payeeName };
      if (c.kind === 'pay' && m.isOwn && c.payeeVpa && (!c.to || c.to === otherUserId)) return { vpa: c.payeeVpa, name: c.payeeName };
    }
    return null;
  }

  // ── Paying ─────────────────────────────────────────────────────────────────

  upiUrl(card: PaymentCard): string | null {
    return upiUrlForCard(card);
  }

  /** Opens the UPI intent; Android shows its app chooser when several UPI apps are installed. */
  async openUpiApp(card: PaymentCard): Promise<void> {
    const url = upiUrlForCard(card);
    if (!url) throw new Error('This card has no UPI id.');
    if (Platform.OS === 'web') throw new Error('Scan the QR code with a UPI app on your phone.');
    try {
      await Linking.openURL(url);
    } catch {
      throw new Error('No UPI app found. Install a UPI app (BHIM, PhonePe, Google Pay, Paytm…) or scan the QR code from another phone.');
    }
  }

  async openLink(card: PaymentCard): Promise<void> {
    if (card.method !== 'link' || !card.linkUrl) return;
    await Linking.openURL(card.linkUrl);
  }

  // ── Status updates (E2EE control messages) ─────────────────────────────────

  async setStatus(message: Message, status: Exclude<PaymentStatus, 'pending'>, txnRef?: string, verified?: boolean): Promise<void> {
    if (!isPaymentMessage(message)) return;
    const session = requireSession();
    const cleanRef = txnRef?.trim().replace(/[^A-Za-z0-9 _\-/]/g, '').slice(0, 64) || undefined;
    const next = applyPaymentUpdate(
      message.ext.card,
      message.ext.state,
      { status, txnRef: cleanRef, verified },
      { userId: session.userId, isCreator: message.senderUserId === session.userId, at: new Date().toISOString() }
    );
    if (!next) throw new Error('This payment can’t be changed any more.');

    // Send first: if it fails, nothing changes locally and the user can retry.
    await messageRepository.send(session, message.conversationId, {
      t: 'payment_status',
      target: message.id,
      status,
      txnRef: cleanRef,
      verified: verified || undefined,
    });
    const ext = { ...message.ext, state: next };
    await databaseService.updateMessageExt(message.id, ext);
    useMessagesStore.getState().upsert(message.conversationId, { ...message, ext });
  }

  // ── History ────────────────────────────────────────────────────────────────

  async history(): Promise<PaymentMessage[]> {
    return (await databaseService.getMessagesByType('payment', 500)).filter(isPaymentMessage);
  }

  // ── Optional: Razorpay payment links ───────────────────────────────────────

  async linkStatus(): Promise<{ configured: boolean; allowed: boolean }> {
    try {
      const { data, error } = await supabase.functions.invoke('payment-link', { body: { action: 'status' } });
      if (error || !data) return { configured: false, allowed: false };
      return { configured: data.configured === true, allowed: data.allowed === true };
    } catch {
      return { configured: false, allowed: false };
    }
  }

  async requestViaLink(conversationId: string, amountPaise: number, note: string, to?: string): Promise<Message | null> {
    const ref = this.newRef();
    const description = sanitizeUpiText(note, 80);
    const { data, error } = await supabase.functions.invoke('payment-link', {
      body: { action: 'create', amountPaise, description, reference: ref },
    });
    if (error) throw new Error(await functionError(error, 'Could not create the payment link'));
    const card: PaymentCard = {
      ref,
      kind: 'request',
      method: 'link',
      amountPaise,
      currency: 'INR',
      note: description || undefined,
      payeeName: requireSession().displayName,
      linkUrl: data.shortUrl,
      linkId: data.linkId,
      to,
    };
    return useMessagesStore.getState().send(conversationId, { t: 'payment', card });
  }

  /** Payee only: asks Razorpay whether the link was paid; marks the card verified if so. */
  async checkLink(message: Message): Promise<string> {
    if (!isPaymentMessage(message) || !message.ext.card.linkId) throw new Error('Not a payment link');
    const { data, error } = await supabase.functions.invoke('payment-link', {
      body: { action: 'check', linkId: message.ext.card.linkId },
    });
    if (error) throw new Error(await functionError(error, 'Could not check the payment'));
    if (data?.status === 'paid' && message.ext.state.status !== 'paid') await this.setStatus(message, 'paid', undefined, true);
    return String(data?.status ?? 'unknown');
  }
}

export const paymentService = new PaymentService();
