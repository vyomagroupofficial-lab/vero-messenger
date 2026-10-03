import * as ExpoCrypto from 'expo-crypto';

/**
 * RFC 4122 v4 UUID from the platform CSPRNG.
 * (Hermes has no global `crypto`, so never fall back to Math.random.)
 */
export function generateUUID(): string {
  return ExpoCrypto.randomUUID();
}
