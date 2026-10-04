/**
 * App lock (device-local): biometrics / device passcode via
 * expo-local-authentication after the app spent `timeoutSeconds` in the
 * background. The lock rule itself is pure and unit-tested.
 */

import { Platform } from 'react-native';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import { APP_LOCK_TIMEOUTS } from './appLockRules';

export { APP_LOCK_TIMEOUTS, shouldLock } from './appLockRules';

interface AppLockState {
  enabled: boolean;
  timeoutSeconds: number;
  setEnabled: (enabled: boolean) => void;
  setTimeoutSeconds: (seconds: number) => void;
}

export const useAppLockStore = create<AppLockState>()(
  persist(
    (set) => ({
      enabled: false,
      timeoutSeconds: 60,
      setEnabled: (enabled) => set({ enabled }),
      setTimeoutSeconds: (seconds) =>
        set({ timeoutSeconds: APP_LOCK_TIMEOUTS.some((t) => t.seconds === seconds) ? seconds : 60 }),
    }),
    {
      name: 'vero-app-lock',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ enabled, timeoutSeconds }) => ({ enabled, timeoutSeconds }),
    }
  )
);

export type LockSupport =
  | { available: true; label: string }
  | { available: false; reason: string };

/** Whether this device can lock the app (biometrics or a device passcode). */
export async function appLockSupport(): Promise<LockSupport> {
  if (Platform.OS === 'web') return { available: false, reason: 'App lock is available in the iOS and Android apps.' };
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) {
      return { available: false, reason: 'Set up a screen lock (PIN, pattern, Face ID or fingerprint) on this device first.' };
    }
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    let label = 'device passcode';
    if (enrolled && types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
      label = Platform.OS === 'ios' ? 'Face ID' : 'face unlock';
    } else if (enrolled && types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
      label = Platform.OS === 'ios' ? 'Touch ID' : 'fingerprint';
    }
    return { available: true, label };
  } catch (e) {
    return { available: false, reason: (e as Error)?.message || 'Authentication is not available.' };
  }
}

export async function authenticate(prompt = 'Unlock Vero'): Promise<boolean> {
  if (Platform.OS === 'web') return true;
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: prompt,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}
