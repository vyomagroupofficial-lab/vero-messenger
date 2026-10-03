/**
 * Applies encrypted `payment_status` control messages to payment cards in
 * the local database (called by MessageRepository.applyRows).
 *
 * Updates can arrive before their card (e.g. paging history backwards), so
 * they're parked and replayed when the card is decrypted.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { databaseService } from '../../core/storage/DatabaseService';
import type { Message } from '../../shared/models/Message';
import type { ExtensionPayload, MessageExt } from '../../shared/models/payloadExtensions';
import { applyPaymentUpdate } from './paymentCard';

interface ControlRow {
  id: string;
  conversation_id: string;
  sender_user_id: string;
  created_at: string;
}

interface ParkedUpdate {
  conversationId: string;
  actorId: string;
  at: string;
  status: Extract<ExtensionPayload, { t: 'payment_status' }>['status'];
  txnRef?: string;
  verified?: boolean;
}

const PARKED_KEY = 'vero.payments.parked';
const MAX_PARKED = 200;

async function readParked(): Promise<Record<string, ParkedUpdate[]>> {
  try {
    const raw = await AsyncStorage.getItem(PARKED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function writeParked(map: Record<string, ParkedUpdate[]>): Promise<void> {
  const keys = Object.keys(map);
  if (keys.length > MAX_PARKED) for (const k of keys.slice(0, keys.length - MAX_PARKED)) delete map[k];
  try {
    await AsyncStorage.setItem(PARKED_KEY, JSON.stringify(map));
  } catch {
    // best effort
  }
}

/** Returns the updated card message, or null if the update was ignored/parked. */
export async function applyExtensionControl(row: ControlRow, payload: { t: string }): Promise<Message | null> {
  const p = payload as ExtensionPayload;
  if (p.t !== 'payment_status') return null;

  const target = await databaseService.getMessage(p.target);
  if (!target) {
    const parked = await readParked();
    const list = parked[p.target] ?? [];
    if (!list.some((u) => u.at === row.created_at && u.actorId === row.sender_user_id)) {
      list.push({
        conversationId: row.conversation_id,
        actorId: row.sender_user_id,
        at: row.created_at,
        status: p.status,
        txnRef: p.txnRef,
        verified: p.verified,
      });
      parked[p.target] = list;
      await writeParked(parked);
    }
    return null;
  }

  if (target.conversationId !== row.conversation_id || target.ext?.t !== 'payment') return null;
  const next = applyPaymentUpdate(target.ext.card, target.ext.state, p, {
    userId: row.sender_user_id,
    isCreator: row.sender_user_id === target.senderUserId,
    at: row.created_at,
  });
  if (!next) return null;
  const ext: MessageExt = { ...target.ext, state: next };
  await databaseService.updateMessageExt(target.id, ext);
  return { ...target, ext };
}

/** Applies parked status updates to a freshly decrypted card. */
export async function finalizeExtensionMessage(
  row: { id: string; conversation_id: string; sender_user_id: string },
  ext: MessageExt
): Promise<MessageExt> {
  if (ext.t !== 'payment') return ext;
  const parked = await readParked();
  const list = parked[row.id];
  if (!list?.length) return ext;
  delete parked[row.id];
  await writeParked(parked);

  let state = ext.state;
  for (const u of [...list].sort((a, b) => a.at.localeCompare(b.at))) {
    if (u.conversationId !== row.conversation_id) continue;
    const next = applyPaymentUpdate(ext.card, state, u, {
      userId: u.actorId,
      isCreator: u.actorId === row.sender_user_id,
      at: u.at,
    });
    if (next) state = next;
  }
  return { ...ext, state };
}
