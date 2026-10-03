/**
 * Vero CryptoManager
 *
 * Signal-inspired E2EE layer using libsodium primitives.
 * - X25519 key exchange (ECDH)
 * - XSalsa20-Poly1305 for message encryption (secretbox)
 * - Ed25519 for identity signatures
 * - AES-GCM for media encryption (via SubtleCrypto on web / native equivalent)
 *
 * WARNING: Never call this from the UI layer directly.
 * All crypto operations must go through this manager.
 */

import * as SecureStore from 'expo-secure-store';

// Keys stored in SecureStore (never in AsyncStorage or plain DB)
const KEY_IDENTITY_PRIVATE = 'vero_identity_sk';
const KEY_IDENTITY_PUBLIC = 'vero_identity_pk';
const KEY_SIGNING_PRIVATE = 'vero_signing_sk';
const KEY_SIGNING_PUBLIC = 'vero_signing_pk';
const KEY_REGISTRATION_ID = 'vero_registration_id';
const KEY_PREKEYS_PREFIX = 'vero_prekey_';

export interface DeviceKeys {
  identityPublicKey: string;       // base64 X25519 public key
  signingPublicKey: string;        // base64 Ed25519 public key
  registrationId: number;
}

export interface PreKey {
  keyId: number;
  publicKey: string;               // base64
  signature: string;               // base64 Ed25519 signature of publicKey
}

export interface EncryptedMessage {
  version: number;
  ciphertext: string;              // base64
  nonce: string;                   // base64
  senderIdentityKey: string;       // base64 (for session establishment)
  ephemeralKey?: string;           // base64 (for initial X3DH)
}

export interface DecryptedMessage {
  plaintext: string;
  senderIdentityKey: string;
}

export interface EncryptedMedia {
  version: number;
  ciphertext: string;             // base64 encrypted blob
  key: string;                    // base64 AES-256 key (encrypted with recipient key)
  iv: string;                     // base64 IV
  sha256: string;                 // base64 hash of plaintext
  mimeTypeHint: string;
  size: number;
}

// Lazy-load sodium to avoid blocking startup
let _sodium: any = null;
async function getSodium() {
  if (!_sodium) {
    try {
      const { default: sodium } = await import('libsodium-wrappers');
      await sodium.ready;
      _sodium = sodium;
    } catch (e) {
      console.error('[Vero Crypto] Failed to load libsodium:', e);
      throw e;
    }
  }
  return _sodium;
}

class CryptoManager {
  private static instance: CryptoManager;

  static getInstance(): CryptoManager {
    if (!CryptoManager.instance) {
      CryptoManager.instance = new CryptoManager();
    }
    return CryptoManager.instance;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Device Identity Management
  // ──────────────────────────────────────────────────────────────────────────

  async generateDeviceKeys(): Promise<DeviceKeys> {
    const sodium = await getSodium();

    // X25519 key pair for ECDH key exchange
    const identityKeyPair = sodium.crypto_box_keypair();

    // Ed25519 key pair for signing
    const signingKeyPair = sodium.crypto_sign_keypair();

    // Cryptographically random registration ID (0 to 16380)
    const registrationId = sodium.randombytes_uniform(16381);

    // Store private keys in secure enclave
    await SecureStore.setItemAsync(
      KEY_IDENTITY_PRIVATE,
      sodium.to_base64(identityKeyPair.privateKey)
    );
    await SecureStore.setItemAsync(
      KEY_IDENTITY_PUBLIC,
      sodium.to_base64(identityKeyPair.publicKey)
    );
    await SecureStore.setItemAsync(
      KEY_SIGNING_PRIVATE,
      sodium.to_base64(signingKeyPair.privateKey)
    );
    await SecureStore.setItemAsync(
      KEY_SIGNING_PUBLIC,
      sodium.to_base64(signingKeyPair.publicKey)
    );
    await SecureStore.setItemAsync(
      KEY_REGISTRATION_ID,
      String(registrationId)
    );

    return {
      identityPublicKey: sodium.to_base64(identityKeyPair.publicKey),
      signingPublicKey: sodium.to_base64(signingKeyPair.publicKey),
      registrationId,
    };
  }

  async getDeviceKeys(): Promise<DeviceKeys | null> {
    try {
      const identityPublicKey = await SecureStore.getItemAsync(KEY_IDENTITY_PUBLIC);
      const signingPublicKey = await SecureStore.getItemAsync(KEY_SIGNING_PUBLIC);
      const registrationIdStr = await SecureStore.getItemAsync(KEY_REGISTRATION_ID);

      if (!identityPublicKey || !signingPublicKey || !registrationIdStr) {
        return null;
      }

      return {
        identityPublicKey,
        signingPublicKey,
        registrationId: parseInt(registrationIdStr, 10),
      };
    } catch {
      return null;
    }
  }

  async getIdentityPublicKey(): Promise<string | null> {
    const keys = await this.getDeviceKeys();
    return keys?.identityPublicKey || null;
  }

  async hasDeviceKeys(): Promise<boolean> {
    const keys = await this.getDeviceKeys();
    return keys !== null;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Prekey Management (Signal-style)
  // ──────────────────────────────────────────────────────────────────────────

  async generatePreKeys(count: number = 100): Promise<PreKey[]> {
    const sodium = await getSodium();
    const signingPrivateKey = await SecureStore.getItemAsync(KEY_SIGNING_PRIVATE);
    if (!signingPrivateKey) throw new Error('[Vero Crypto] Signing key not found');

    const signingSkBytes = sodium.from_base64(signingPrivateKey);
    const preKeys: PreKey[] = [];

    for (let i = 1; i <= count; i++) {
      const keyPair = sodium.crypto_box_keypair();
      const pubKeyBytes = keyPair.publicKey;

      // Sign the prekey with our identity signing key
      const signature = sodium.crypto_sign_detached(pubKeyBytes, signingSkBytes);

      const preKey: PreKey = {
        keyId: i,
        publicKey: sodium.to_base64(pubKeyBytes),
        signature: sodium.to_base64(signature),
      };

      // Store private half securely
      await SecureStore.setItemAsync(
        `${KEY_PREKEYS_PREFIX}${i}`,
        sodium.to_base64(keyPair.privateKey)
      );

      preKeys.push(preKey);
    }

    return preKeys;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Message Encryption (X3DH + Double Ratchet simplified)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Encrypt a message for a recipient.
   * Uses X25519 ECDH to derive a shared secret, then encrypts with secretbox.
   * For a production build, this should be replaced with a full Double Ratchet impl.
   */
  async encryptMessage(
    plaintext: string,
    recipientIdentityPublicKey: string
  ): Promise<EncryptedMessage> {
    const sodium = await getSodium();

    const senderPrivateKey = await SecureStore.getItemAsync(KEY_IDENTITY_PRIVATE);
    const senderPublicKey = await SecureStore.getItemAsync(KEY_IDENTITY_PUBLIC);
    if (!senderPrivateKey || !senderPublicKey) {
      throw new Error('[Vero Crypto] Sender identity keys not found');
    }

    // Generate ephemeral key pair for this message (forward secrecy)
    const ephemeralKeyPair = sodium.crypto_box_keypair();

    // ECDH: derive shared secret
    const recipientPkBytes = sodium.from_base64(recipientIdentityPublicKey);
    const senderSkBytes = sodium.from_base64(senderPrivateKey);
    const sharedSecret = sodium.crypto_scalarmult(
      ephemeralKeyPair.privateKey,
      recipientPkBytes
    );

    // Derive symmetric key via HKDF-SHA256 (simplified using crypto_generichash)
    const info = new TextEncoder().encode('vero-message-v1');
    const symmetricKey = sodium.crypto_generichash(32, sharedSecret, info);

    // Encrypt
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const plaintextBytes = new TextEncoder().encode(plaintext);
    const ciphertextBytes = sodium.crypto_secretbox_easy(plaintextBytes, nonce, symmetricKey);

    return {
      version: 1,
      ciphertext: sodium.to_base64(ciphertextBytes),
      nonce: sodium.to_base64(nonce),
      senderIdentityKey: senderPublicKey,
      ephemeralKey: sodium.to_base64(ephemeralKeyPair.publicKey),
    };
  }

  /**
   * Decrypt a message received from a sender.
   */
  async decryptMessage(envelope: EncryptedMessage): Promise<DecryptedMessage> {
    const sodium = await getSodium();

    const recipientPrivateKey = await SecureStore.getItemAsync(KEY_IDENTITY_PRIVATE);
    if (!recipientPrivateKey) {
      throw new Error('[Vero Crypto] Recipient identity key not found');
    }

    const recipientSkBytes = sodium.from_base64(recipientPrivateKey);
    const ephemeralPkBytes = sodium.from_base64(envelope.ephemeralKey!);

    // Derive the same shared secret
    const sharedSecret = sodium.crypto_scalarmult(recipientSkBytes, ephemeralPkBytes);

    const info = new TextEncoder().encode('vero-message-v1');
    const symmetricKey = sodium.crypto_generichash(32, sharedSecret, info);

    const ciphertextBytes = sodium.from_base64(envelope.ciphertext);
    const nonceBytes = sodium.from_base64(envelope.nonce);

    const plaintextBytes = sodium.crypto_secretbox_open_easy(
      ciphertextBytes,
      nonceBytes,
      symmetricKey
    );

    if (!plaintextBytes) {
      throw new Error('[Vero Crypto] Decryption failed - message may be tampered');
    }

    return {
      plaintext: new TextDecoder().decode(plaintextBytes),
      senderIdentityKey: envelope.senderIdentityKey,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Media Encryption (AES-256-GCM via SubtleCrypto)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Encrypt a media file buffer.
   * Returns the encrypted blob and the media key (to be sent via E2EE message).
   */
  async encryptMedia(
    plainBuffer: ArrayBuffer,
    mimeTypeHint: string
  ): Promise<{ encryptedBuffer: ArrayBuffer; mediaKey: string; iv: string; sha256: string }> {
    const sodium = await getSodium();

    // Generate random 256-bit media key
    const mediaKeyBytes = sodium.randombytes_buf(32);
    const ivBytes = sodium.randombytes_buf(12); // 96-bit IV for GCM

    // Import key for WebCrypto AES-GCM
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      mediaKeyBytes,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );

    const encryptedBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: ivBytes },
      cryptoKey,
      plainBuffer
    );

    // SHA-256 hash of plaintext for integrity verification
    const sha256Buffer = await crypto.subtle.digest('SHA-256', plainBuffer);
    const sha256 = sodium.to_base64(new Uint8Array(sha256Buffer));

    return {
      encryptedBuffer,
      mediaKey: sodium.to_base64(mediaKeyBytes),
      iv: sodium.to_base64(ivBytes),
      sha256,
    };
  }

  /**
   * Decrypt a media file buffer.
   */
  async decryptMedia(
    encryptedBuffer: ArrayBuffer,
    mediaKeyBase64: string,
    ivBase64: string,
    expectedSha256: string
  ): Promise<ArrayBuffer> {
    const sodium = await getSodium();

    const mediaKeyBytes = sodium.from_base64(mediaKeyBase64);
    const ivBytes = sodium.from_base64(ivBase64);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      mediaKeyBytes,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes },
      cryptoKey,
      encryptedBuffer
    );

    // Verify integrity
    const sha256Buffer = await crypto.subtle.digest('SHA-256', plainBuffer);
    const actualSha256 = sodium.to_base64(new Uint8Array(sha256Buffer));
    if (actualSha256 !== expectedSha256) {
      throw new Error('[Vero Crypto] Media integrity check failed - file may be corrupted or tampered');
    }

    return plainBuffer;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Identity Verification
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Generate a safety number (fingerprint) for verifying a contact's identity.
   * This is the string shown in the "Verify Safety Number" screen.
   */
  async generateSafetyNumber(
    myPublicKey: string,
    theirPublicKey: string
  ): Promise<string> {
    const sodium = await getSodium();

    // Combine keys in lexicographic order (deterministic)
    const keys = [myPublicKey, theirPublicKey].sort();
    const combined = new TextEncoder().encode(keys.join('|'));
    const hash = sodium.crypto_generichash(30, combined);

    // Format as groups of 5 digits
    const digits = Array.from(hash as Uint8Array)
      .map((b: any) => (b as number).toString().padStart(3, '0'))
      .join('')
      .slice(0, 60);

    return digits
      .match(/.{1,5}/g)!
      .join(' ')
      .match(/.{1,18}/g)!
      .join('\n');
  }

  /**
   * Clear all private keys from secure storage.
   * Called on logout or device revocation.
   */
  async clearAllKeys(): Promise<void> {
    const keysToDelete = [
      KEY_IDENTITY_PRIVATE,
      KEY_IDENTITY_PUBLIC,
      KEY_SIGNING_PRIVATE,
      KEY_SIGNING_PUBLIC,
      KEY_REGISTRATION_ID,
    ];

    for (const key of keysToDelete) {
      try {
        await SecureStore.deleteItemAsync(key);
      } catch {
        // Best effort
      }
    }
  }
}

export const cryptoManager = CryptoManager.getInstance();
