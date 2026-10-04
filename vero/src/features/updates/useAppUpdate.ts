import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { checkForUpdate, installAndroidUpdate, reloadWeb, type UpdateCheck } from './UpdateService';

const RECHECK_MS = 6 * 60 * 60 * 1000;

export function useAppUpdate(opts: { auto?: boolean } = {}) {
  const [update, setUpdate] = useState<UpdateCheck>({ kind: 'none' });
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const last = useRef(0);

  const check = useCallback(async (force = false) => {
    if (!force && Date.now() - last.current < RECHECK_MS) return;
    last.current = Date.now();
    setChecking(true);
    setError(null);
    try {
      setUpdate(await checkForUpdate());
    } catch (e: any) {
      setError(e?.message ?? 'Could not check for updates');
    } finally {
      setChecking(false);
    }
  }, []);

  const install = useCallback(async () => {
    setError(null);
    if (update.kind === 'web') return reloadWeb();
    if (update.kind !== 'android') return;
    try {
      setProgress(0);
      await installAndroidUpdate(update.manifest, setProgress);
    } catch (e: any) {
      setError(e?.message ?? 'Update failed');
    } finally {
      setProgress(null);
    }
  }, [update]);

  useEffect(() => {
    if (!opts.auto) return;
    void check(true);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void check());
    return () => sub.remove();
  }, [opts.auto, check]);

  return { update, checking, progress, error, dismissed, dismiss: () => setDismissed(true), check: () => check(true), install };
}
