/**
 * Small key/value wrapper over the platform keystore.
 *
 * Native: expo-secure-store (Android Keystore / iOS Keychain).
 * Web: expo-secure-store is unsupported, so we fall back to localStorage.
 * That is NOT a secure enclave; the web build is for development/demo only.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const isWeb = Platform.OS === 'web';
let warned = false;

function webStorage(): Storage | null {
  if (!warned) {
    warned = true;
    console.warn('[Vero] Web build stores device keys in localStorage. Use a native build for real security.');
  }
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export const secureStorage = {
  async get(key: string): Promise<string | null> {
    if (isWeb) return webStorage()?.getItem(key) ?? null;
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (isWeb) {
      webStorage()?.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async remove(key: string): Promise<void> {
    if (isWeb) {
      webStorage()?.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};
