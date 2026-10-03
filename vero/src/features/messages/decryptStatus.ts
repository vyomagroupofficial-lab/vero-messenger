/**
 * User-facing text for a message that couldn't be decrypted, by cause.
 * (Kept separate from MessageRepository so the session layer's error
 * taxonomy doesn't leak into it.)
 */

import { NotAddressedToDeviceError } from '../../core/crypto/primitives';
import {
  DuplicateMessageError,
  OwnMessageUnavailableError,
  UntrustedIdentityError,
  isSessionBroken,
} from '../../core/crypto/ratchet/errors';

export function decryptFailureText(e: unknown): string {
  if (e instanceof OwnMessageUnavailableError) return 'Sent from this device before it was reset; no copy is kept here.';
  if (e instanceof NotAddressedToDeviceError) return 'This message was sent before this device was linked.';
  if (isSessionBroken(e)) {
    return "This message couldn't be decrypted: the secure session was out of sync and has been reset. Ask the sender to send it again.";
  }
  if (e instanceof UntrustedIdentityError) return "This message couldn't be decrypted: the sender's security key doesn't match.";
  if (e instanceof DuplicateMessageError) return "This message couldn't be decrypted again on this device.";
  return "This message couldn't be decrypted.";
}
