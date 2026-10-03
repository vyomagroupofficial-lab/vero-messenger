/**
 * Payment card state machine (pure, unit-tested).
 *
 * A card is created by one member and updated by encrypted `payment_status`
 * control messages. Every device applies the same rules to the same ordered
 * stream, so all members converge on the same state. Terminal states never
 * change again, which also makes re-applying old updates harmless.
 *
 *   request (creator = payee)
 *     others  : pending|failed -> paid | failed | declined
 *     creator : pending|failed -> paid ("received") | cancelled
 *   pay (creator = payer)
 *     creator : pending|failed -> paid | failed | cancelled
 *     others  : pending|failed -> paid ("received")
 *
 * Vero cannot see UPI transactions: "paid" is what a member reported (unless
 * `verified`, which only the payee can set after checking a Razorpay link).
 */

import type { PaymentCard, PaymentState, PaymentStatus } from '../../shared/models/payloadExtensions';

export const TERMINAL: PaymentStatus[] = ['paid', 'declined', 'cancelled'];

export interface PaymentUpdate {
  status: PaymentStatus;
  txnRef?: string;
  verified?: boolean;
}

export interface PaymentActor {
  userId: string;
  isCreator: boolean;
  at?: string;
}

export function allowedTransitions(card: PaymentCard, state: PaymentState, actor: PaymentActor): PaymentStatus[] {
  if (TERMINAL.includes(state.status)) return [];
  // A card addressed to one member (group chats) can only be answered by them.
  if (!actor.isCreator && card.to && card.to !== actor.userId) return [];
  if (card.kind === 'request') return actor.isCreator ? ['paid', 'cancelled'] : ['paid', 'failed', 'declined'];
  return actor.isCreator ? ['paid', 'failed', 'cancelled'] : ['paid'];
}

/** Returns the new state, or null if the update isn't allowed (or changes nothing). */
export function applyPaymentUpdate(
  card: PaymentCard,
  state: PaymentState,
  update: PaymentUpdate,
  actor: PaymentActor
): PaymentState | null {
  if (!allowedTransitions(card, state, actor).includes(update.status)) return null;
  if (update.status === state.status) return null;
  // Only the payee can vouch that money arrived.
  const actorIsPayee = card.kind === 'request' ? actor.isCreator : !actor.isCreator;
  return {
    status: update.status,
    txnRef: update.txnRef ?? state.txnRef,
    verified: update.status === 'paid' && update.verified === true && actorIsPayee ? true : undefined,
    updatedBy: actor.userId,
    updatedAt: actor.at,
  };
}

export function statusLabel(card: PaymentCard, state: PaymentState): string {
  switch (state.status) {
    case 'pending':
      return card.kind === 'request' ? 'Requested' : 'Awaiting payment';
    case 'paid':
      return state.verified ? 'Paid · verified' : 'Marked as paid';
    case 'failed':
      return 'Payment failed';
    case 'declined':
      return 'Declined';
    case 'cancelled':
      return 'Cancelled';
  }
}
