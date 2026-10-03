/**
 * Story encryption layout (pure; reuses the message envelope from
 * core/crypto/primitives).
 *
 * A story is encrypted ONCE with encryptEnvelope(), exactly like a message,
 * for every active device of the author and of every audience member. The
 * associated data binds it to "story:<authorId>" + storyId + authorDeviceId,
 * which can never collide with a conversation id (those are bare UUIDs), so a
 * story slot cannot be replayed as a message or vice versa.
 *
 * For storage the envelope's key slots are split per user:
 *   stories.ciphertext          = { v, n, c, k: <author's own device slots> }
 *   story_recipients.key_slots  = <one recipient's device slots>
 * so every recipient downloads only their own slots, and recipients can't see
 * who else is in the audience. Reading reassembles { v, n, c, k: mySlots }.
 */

import {
  DecryptionError,
  DeviceKeyRef,
  EnvelopeContext,
  EnvelopeV2,
  Sodium,
  decryptEnvelope,
  encryptEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from '../../core/crypto/primitives';

export interface AudienceDevice extends DeviceKeyRef {
  userId: string;
}

export interface SplitStoryEnvelope {
  /** Serialized envelope with the author's own device slots only. */
  storyCiphertext: string;
  /** userId -> (deviceId -> slot), one entry per audience member with >= 1 device. */
  recipientSlots: Record<string, Record<string, string>>;
}

/** Associated-data context for a story (domain-separated from messages). */
export function storyContext(authorId: string, storyId: string, authorDeviceId: string): EnvelopeContext {
  return { conversationId: `story:${authorId}`, messageId: storyId, senderDeviceId: authorDeviceId };
}

/** Splits an encrypted envelope's key slots between the author row and per-recipient rows. */
export function splitStoryEnvelope(envelope: EnvelopeV2, devices: AudienceDevice[], authorId: string): SplitStoryEnvelope {
  const owner = new Map(devices.map((d) => [d.deviceId, d.userId]));
  const authorSlots: Record<string, string> = {};
  const recipientSlots: Record<string, Record<string, string>> = {};
  for (const [deviceId, slot] of Object.entries(envelope.k)) {
    const userId = owner.get(deviceId);
    if (!userId) continue;
    if (userId === authorId) authorSlots[deviceId] = slot;
    else (recipientSlots[userId] ??= {})[deviceId] = slot;
  }
  return {
    storyCiphertext: serializeEnvelope({ v: envelope.v, n: envelope.n, c: envelope.c, k: authorSlots }),
    recipientSlots,
  };
}

/** Rebuilds a decryptable envelope from the story row plus this user's slots (null for the author). */
export function assembleStoryEnvelope(storyCiphertext: string, mySlots: Record<string, string> | null): EnvelopeV2 {
  const base = parseEnvelope(storyCiphertext);
  if (!mySlots) return base;
  if (typeof mySlots !== 'object') throw new DecryptionError('Malformed key slots');
  const k: Record<string, string> = {};
  for (const [deviceId, slot] of Object.entries(mySlots)) if (typeof slot === 'string') k[deviceId] = slot;
  return { ...base, k };
}

/** Encrypt + split in one go (used by tests; the app goes through CryptoManager for key storage). */
export function encryptStory(
  sodium: Sodium,
  payloadJson: string,
  ctx: EnvelopeContext,
  authorSecretKey: string,
  authorId: string,
  devices: AudienceDevice[]
): SplitStoryEnvelope {
  const envelope = encryptEnvelope(sodium, payloadJson, ctx, authorSecretKey, devices);
  return splitStoryEnvelope(envelope, devices, authorId);
}

export function decryptStory(
  sodium: Sodium,
  storyCiphertext: string,
  mySlots: Record<string, string> | null,
  ctx: EnvelopeContext,
  myDeviceId: string,
  mySecretKey: string,
  authorPublicKey: string
): string {
  return decryptEnvelope(
    sodium,
    assembleStoryEnvelope(storyCiphertext, mySlots),
    ctx,
    myDeviceId,
    mySecretKey,
    authorPublicKey
  );
}
