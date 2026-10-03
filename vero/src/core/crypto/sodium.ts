/**
 * libsodium loader for React Native / web.
 *
 * Hermes has no WebCrypto, so libsodium's random number generator would fail
 * with "no secure random number generator found". We back
 * `globalThis.crypto.getRandomValues` with expo-crypto (native CSPRNG) before
 * libsodium initialises.
 */

import * as ExpoCrypto from 'expo-crypto';
import type { Sodium } from './primitives';

function ensureSecureRandom(): void {
  const g = globalThis as any;
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') return;
  g.crypto = {
    ...(g.crypto || {}),
    getRandomValues: <T extends ArrayBufferView>(array: T): T =>
      ExpoCrypto.getRandomValues(array as any) as unknown as T,
  };
}

let sodiumPromise: Promise<Sodium> | null = null;

export function getSodium(): Promise<Sodium> {
  if (!sodiumPromise) {
    sodiumPromise = (async () => {
      ensureSecureRandom();
      const sodium = (await import('libsodium-wrappers')) as unknown as Sodium & {
        default?: Sodium;
      };
      const instance = (sodium.default ?? sodium) as Sodium;
      await instance.ready;
      return instance;
    })().catch((e) => {
      sodiumPromise = null; // allow retry
      throw e;
    });
  }
  return sodiumPromise;
}
