/**
 * <AppLockGate>: wraps the app (app/_layout.tsx).
 *   - With app lock on, covers the app with a lock screen after it spent the
 *     chosen time in the background (and on a cold start) until the user
 *     authenticates with biometrics or the device passcode.
 *   - With app lock on, hides the app's content while it is not in the
 *     foreground, so the app switcher snapshot shows nothing private.
 * The screen stays mounted underneath, so nothing is lost while locked.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { tx } from '../../shared/i18n/phrases';
import { AppState, AppStateStatus, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { appLockSupport, authenticate, shouldLock, useAppLockStore } from './appLock';
import { makeStyles, useLegacyColors } from '../../shared/theme/ThemeProvider';
import { BorderRadius, Spacing, Typography, legacyColors } from '../../shared/theme/theme';
import { Glyph } from '../../shared/ui';

export function AppLockGate({ children }: { children: React.ReactNode }) {
  const Colors = useLegacyColors();
  const styles = useStyles();
  const enabled = useAppLockStore((s) => s.enabled);
  const [hydrated, setHydrated] = useState(() => useAppLockStore.persist.hasHydrated());
  const [locked, setLocked] = useState(false);
  const [covered, setCovered] = useState(false);
  const [methodLabel, setMethodLabel] = useState('passcode');
  const backgroundedAt = useRef<number | null>(null);
  const authenticating = useRef(false);
  const coldStartChecked = useRef(false);

  useEffect(() => {
    if (hydrated) return;
    return useAppLockStore.persist.onFinishHydration(() => setHydrated(true));
  }, [hydrated]);

  // Cold start: lock straight away if app lock is on.
  useEffect(() => {
    if (!hydrated || coldStartChecked.current) return;
    coldStartChecked.current = true;
    if (useAppLockStore.getState().enabled && Platform.OS !== 'web') setLocked(true);
  }, [hydrated]);

  useEffect(() => {
    if (!enabled) {
      setLocked(false);
      setCovered(false);
      return;
    }
    void appLockSupport().then((s) => s.available && setMethodLabel(s.label));
  }, [enabled]);

  const unlock = useCallback(async () => {
    if (authenticating.current) return;
    authenticating.current = true;
    try {
      if (await authenticate(tx('Unlock Vero'))) {
        setLocked(false);
        backgroundedAt.current = null;
      }
    } finally {
      authenticating.current = false;
    }
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const onChange = (state: AppStateStatus) => {
      if (authenticating.current) return; // the system prompt itself makes the app inactive
      const lockOn = useAppLockStore.getState().enabled;
      if (state === 'active') {
        setCovered(false);
        if (
          shouldLock({
            enabled: lockOn,
            timeoutSeconds: useAppLockStore.getState().timeoutSeconds,
            backgroundedAt: backgroundedAt.current,
            now: Date.now(),
          })
        ) {
          setLocked(true);
        }
        backgroundedAt.current = null;
      } else {
        if (lockOn) setCovered(true);
        if (state === 'background' && backgroundedAt.current === null) backgroundedAt.current = Date.now();
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, []);

  // Prompt automatically once the lock screen is visible.
  useEffect(() => {
    if (locked && AppState.currentState === 'active') void unlock();
  }, [locked, unlock]);

  return (
    <View style={styles.root}>
      {children}
      {enabled && locked ? (
        <View style={[StyleSheet.absoluteFill, styles.lock]}>
          <View style={styles.badge}>
            <Glyph name="lock-closed" size={34} color={Colors.accent} />
          </View>
          <Text style={styles.title}>{tx("Vero is locked")}</Text>
          <Text style={styles.body}>Unlock with your {methodLabel} to continue.</Text>
          <TouchableOpacity style={styles.button} onPress={() => void unlock()} activeOpacity={0.85}>
            <Glyph name="finger-print" size={18} color={Colors.white} style={{ marginRight: 8 }} />
            <Text style={styles.buttonText}>{tx("Unlock")}</Text>
          </TouchableOpacity>
        </View>
      ) : enabled && covered ? (
        <View style={[StyleSheet.absoluteFill, styles.lock]}>
          <Glyph name="shield-checkmark" size={44} color={Colors.accent} />
          <Text style={styles.title}>Vero</Text>
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => {
  const Colors = legacyColors(c);
  return {
  root: { flex: 1, width: '100%' },
  lock: {
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
    padding: Spacing.xl,
    zIndex: 1000,
    elevation: 1000,
  },
  badge: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: Colors.accentSubtle,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  title: { fontSize: Typography.xl, fontWeight: Typography.bold, color: Colors.textPrimary },
  body: { fontSize: Typography.sm, color: Colors.textSecondary, textAlign: 'center' },
  button: {
    marginTop: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.accent,
    paddingHorizontal: Spacing.xl,
    height: 48,
    borderRadius: BorderRadius.lg,
  },
  buttonText: { color: Colors.white, fontWeight: Typography.bold, fontSize: Typography.base },
} as const;
});
