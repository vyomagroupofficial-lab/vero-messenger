/**
 * Message edit rules (pure, unit-tested).
 *
 * The sender may change the text of a text message, or the caption of a photo
 * or video, for EDIT_WINDOW_MS after it was sent. The edit travels as an
 * encrypted `edit` control payload; every receiving device (including the
 * sender's other devices) re-checks the rules below before applying it, using
 * SERVER timestamps (message row created_at), never the sender's clock.
 */

import type { Message, MessageType } from '../../shared/models/Message';
import { MAX_TEXT_LENGTH } from '../../shared/models/payload';
import { toMillis } from '../../shared/utils/time';

export const EDIT_WINDOW_MS = 15 * 60 * 1000;
/** Receivers allow for the edit's own delivery time on top of the window. */
export const EDIT_RECEIVE_GRACE_MS = 2 * 60 * 1000;

const EDITABLE_TYPES: MessageType[] = ['text', 'image', 'video'];

export type EditCheck = { ok: true } | { ok: false; reason: string };

/** Can the local user start editing `m` now? (UI + sender-side guard) */
export function canEditMessage(m: Message, myUserId: string, nowMs: number = Date.now()): EditCheck {
  if (!m.isOwn || m.senderUserId !== myUserId) return { ok: false, reason: 'You can only edit your own messages.' };
  if (m.revokedAt || m.deletedAt) return { ok: false, reason: 'This message was deleted.' };
  if (!EDITABLE_TYPES.includes(m.messageType)) return { ok: false, reason: 'This kind of message can’t be edited.' };
  if (m.status === 'sending' || m.status === 'failed') return { ok: false, reason: 'Wait until the message is sent.' };
  const sent = toMillis(m.createdAt);
  if (!Number.isFinite(sent) || nowMs - sent > EDIT_WINDOW_MS) {
    return { ok: false, reason: 'Messages can only be edited for 15 minutes after sending.' };
  }
  return { ok: true };
}

/** Normalises the new text; returns null when there is nothing to send. */
export function normalizeEditText(m: Message, newText: string): string | null {
  const text = newText.trim();
  if (text.length > MAX_TEXT_LENGTH) return null;
  if (m.messageType === 'text' && text.length === 0) return null; // use delete instead
  if (text === (m.content ?? '').trim()) return null; // unchanged
  return text;
}

export interface IncomingEdit {
  conversationId: string;
  senderUserId: string;
  /** Server time of the control row carrying the edit. */
  createdAt: string;
}

/** Should a received edit be applied to `target`? */
export function isIncomingEditValid(target: Message, edit: IncomingEdit): boolean {
  if (target.conversationId !== edit.conversationId) return false;
  if (target.senderUserId !== edit.senderUserId) return false;
  if (target.revokedAt || target.deletedAt) return false;
  if (!EDITABLE_TYPES.includes(target.messageType)) return false;
  const sent = toMillis(target.createdAt);
  const edited = toMillis(edit.createdAt);
  if (!Number.isFinite(sent) || !Number.isFinite(edited)) return false;
  if (edited < sent) return false;
  return edited - sent <= EDIT_WINDOW_MS + EDIT_RECEIVE_GRACE_MS;
}

/** Edits are applied last-writer-wins by server time. */
export function isNewerEdit(currentEditedAt: string | null | undefined, candidate: string): boolean {
  if (!currentEditedAt) return true;
  return toMillis(candidate) > toMillis(currentEditedAt);
}

export interface EditHistoryEntry {
  text: string;
  at: string;
}

/**
 * Versions of a message, oldest first, from its local edit records.
 * `edits` are (previousText, newText, editedAt) as recorded on this device.
 */
export function editHistory(
  current: string,
  createdAt: string,
  edits: { previousText: string | null; newText: string; editedAt: string }[]
): EditHistoryEntry[] {
  const sorted = [...edits].sort((a, b) => toMillis(a.editedAt) - toMillis(b.editedAt));
  if (sorted.length === 0) return [{ text: current, at: createdAt }];
  const out: EditHistoryEntry[] = [];
  const original = sorted[0].previousText;
  if (original !== null) out.push({ text: original, at: createdAt });
  for (const e of sorted) out.push({ text: e.newText, at: e.editedAt });
  return out;
}
