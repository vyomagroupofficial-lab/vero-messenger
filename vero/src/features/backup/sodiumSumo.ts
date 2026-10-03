/**
 * libsodium "sumo" build, loaded only for backups: Argon2id (crypto_pwhash)
 * is not part of the standard libsodium.js build used everywhere else.
 */

import { getSodium } from '../../core/crypto/sodium';
import type { SumoSodium } from './backupCrypto';

let sumoPromise: Promise<SumoSodium> | null = null;

export function getSumoSodium(): Promise<SumoSodium> {
  if (!sumoPromise) {
    sumoPromise = (async () => {
      // Installs the native CSPRNG polyfill (Hermes has no WebCrypto) first.
      await getSodium();
      const mod = (await import('libsodium-wrappers-sumo')) as unknown as SumoSodium & { default?: SumoSodium };
      const instance = (mod.default ?? mod) as SumoSodium;
      await instance.ready;
      return instance;
    })().catch((e) => {
      sumoPromise = null;
      throw e;
    });
  }
  return sumoPromise;
}
