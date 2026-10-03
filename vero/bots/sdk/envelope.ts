/**
 * Bot-side message encryption: the SAME envelope format and payload schema
 * as the app (src/core/crypto/primitives.ts, src/shared/models/payload.ts),
 * so a bot is just another device in the conversation.
 */

import {
  DeviceKeyRef,
  EnvelopeContext,
  Sodium,
  decryptEnvelope,
  encryptEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from '../../src/core/crypto/primitives';
import { MessagePayload, parsePayload, serverTypeFor } from '../../src/shared/models/payload';

export type { DeviceKeyRef, EnvelopeContext, MessagePayload, Sodium };

export interface SealedMessage {
  ciphertext: string;
  messageType: ReturnType<typeof serverTypeFor>;
}

/** Encrypts a payload for every recipient device (including the bot's own). */
export function sealPayload(
  sodium: Sodium,
  payload: MessagePayload,
  ctx: EnvelopeContext,
  senderSecretKey: string,
  recipients: DeviceKeyRef[]
): SealedMessage {
  const envelope = encryptEnvelope(sodium, JSON.stringify(payload), ctx, senderSecretKey, recipients);
  return { ciphertext: serializeEnvelope(envelope), messageType: serverTypeFor(payload) };
}

/** Decrypts + validates an incoming envelope. Throws on tampering; null if the payload is unknown. */
export function openPayload(
  sodium: Sodium,
  ciphertext: string,
  ctx: EnvelopeContext,
  myDeviceId: string,
  mySecretKey: string,
  senderPublicKey: string
): MessagePayload | null {
  const plaintext = decryptEnvelope(sodium, parseEnvelope(ciphertext), ctx, myDeviceId, mySecretKey, senderPublicKey);
  return parsePayload(plaintext);
}

/** "/remind 10m tea" -> { command: 'remind', args: '10m tea' }; null if not a command. */
export function parseCommand(text: string, botUsername?: string): { command: string; args: string } | null {
  const m = /^\/([a-zA-Z0-9_]{1,32})(?:@([a-z0-9_]{3,30}))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  if (m[2] && botUsername && m[2] !== botUsername) return null;
  return { command: m[1].toLowerCase(), args: (m[3] ?? '').trim() };
}

/** Bot token: vbot_<base64url(json{u, e})>.<secret> (issued by the bot-admin function). */
export function parseBotToken(token: string): { userId: string; email: string; password: string } {
  const m = /^vbot_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{20,})$/.exec(token.trim());
  if (!m) throw new Error('Malformed bot token');
  const json = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const info = JSON.parse(json);
  if (typeof info?.u !== 'string' || typeof info?.e !== 'string') throw new Error('Malformed bot token');
  return { userId: info.u, email: info.e, password: m[2] };
}
