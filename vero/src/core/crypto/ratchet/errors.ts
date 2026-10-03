/**
 * Error taxonomy of the session layer. Everything that means "this message
 * can't be read" extends DecryptionError so existing callers keep working.
 */

import { DecryptionError, NotAddressedToDeviceError } from '../primitives';

/** A normal (non-X3DH) message arrived but we hold no session with that device. */
export class SessionNotFoundError extends DecryptionError {
  constructor() {
    super('No secure session with the sender device');
    this.name = 'SessionNotFoundError';
  }
}

/** We hold sessions with the device, but none of them can decrypt the message (state lost/out of sync). */
export class SessionMismatchError extends DecryptionError {
  constructor() {
    super('Secure session with the sender device is out of sync');
    this.name = 'SessionMismatchError';
  }
}

/** An X3DH message references a prekey we no longer have (expired signed prekey / used one-time prekey). */
export class PreKeyNotFoundError extends DecryptionError {
  constructor(what: string) {
    super(`Prekey not available: ${what}`);
    this.name = 'PreKeyNotFoundError';
  }
}

/** The message key was already used: a replay (or a duplicate delivery of an un-cached message). */
export class DuplicateMessageError extends DecryptionError {
  constructor() {
    super('Message was already received');
    this.name = 'DuplicateMessageError';
  }
}

/** Too many messages skipped in one chain (MAX_SKIP); refuse rather than burn CPU/storage. */
export class TooManySkippedMessagesError extends DecryptionError {
  constructor() {
    super('Too many skipped messages');
    this.name = 'TooManySkippedMessagesError';
  }
}

/** X3DH header names an identity key different from the pinned one for that device. */
export class UntrustedIdentityError extends DecryptionError {
  constructor() {
    super('Sender identity key does not match the pinned key');
    this.name = 'UntrustedIdentityError';
  }
}

/** A prekey bundle failed signature / identity binding verification. */
export class InvalidBundleError extends Error {
  constructor(reason: string) {
    super(`Invalid prekey bundle: ${reason}`);
    this.name = 'InvalidBundleError';
  }
}

/** Our own message, but this device kept no key slot for itself (v3 doesn't encrypt to the sending device). */
export class OwnMessageUnavailableError extends NotAddressedToDeviceError {
  constructor() {
    super();
    this.message = 'Sent from this device; the local copy is no longer stored';
    this.name = 'OwnMessageUnavailableError';
  }
}

/**
 * Thrown by the message-level decrypt API for session-layer control messages
 * (e.g. "session reset"). They were handled internally and must not be shown.
 */
export class ControlMessageHandled extends Error {
  constructor(public readonly control: string) {
    super(`Session control message (${control}) handled`);
    this.name = 'ControlMessageHandled';
  }
}

/** Errors that indicate our session state with the sender is gone or broken (recoverable by a reset). */
export function isSessionBroken(e: unknown): boolean {
  return e instanceof SessionNotFoundError || e instanceof SessionMismatchError || e instanceof PreKeyNotFoundError;
}

/** None of the other recipients' devices could be reached securely (no prekeys published / invalid bundles). */
export class NoReachableDevicesError extends Error {
  constructor() {
    super("The recipient's devices haven't published encryption keys yet (they may need to update Vero).");
    this.name = 'NoReachableDevicesError';
  }
}
