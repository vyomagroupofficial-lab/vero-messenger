/**
 * Keeps the cached privacy settings in step with the account's
 * `user_settings` row (RLS: owner only).
 */

import { supabase } from '../../core/network/supabase';
import { currentSession } from '../../core/session';
import { fromRow, PrivacySettings, toRow } from './privacy';
import { privacySnapshot, useSettingsStore } from './useSettingsStore';

const COLUMNS = 'read_receipts, typing_indicators, last_seen, show_online, default_disappearing_seconds, notification_previews';

type Listener = (next: PrivacySettings, prev: PrivacySettings) => void;
const listeners = new Set<Listener>();

/** Called after privacy settings change (presence uses it to stop/start tracking). */
export function onPrivacyChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function apply(next: PrivacySettings): void {
  const prev = privacySnapshot();
  useSettingsStore.getState().set(next);
  if (JSON.stringify(prev) !== JSON.stringify(next)) listeners.forEach((l) => l(next, prev));
}

/**
 * Loads the server row (creating it from the local values if it is missing,
 * e.g. an account created before 005). Offline: keeps the cached values.
 */
export async function loadPrivacySettings(): Promise<void> {
  const session = currentSession();
  if (!session || session.isDemo) return;
  const { data, error } = await supabase.from('user_settings').select(COLUMNS).eq('user_id', session.userId).maybeSingle();
  if (error) {
    console.warn('[Settings] could not load settings:', error.message);
    return;
  }
  if (data) {
    apply(fromRow(data));
    return;
  }
  const { error: insertError } = await supabase
    .from('user_settings')
    .insert({ user_id: session.userId, ...toRow(privacySnapshot()) });
  if (insertError && insertError.code !== '23505') console.warn('[Settings] could not create settings:', insertError.message);
}

/** Saves a change on the server first, then applies it locally. */
export async function updatePrivacySettings(patch: Partial<PrivacySettings>): Promise<void> {
  const session = currentSession();
  const next = { ...privacySnapshot(), ...patch };
  if (session && !session.isDemo) {
    const row = toRow(patch);
    const { data, error } = await supabase
      .from('user_settings')
      .update(row)
      .eq('user_id', session.userId)
      .select('user_id');
    if (error) throw error;
    if (!data?.length) {
      const { error: insertError } = await supabase.from('user_settings').insert({ user_id: session.userId, ...toRow(next) });
      if (insertError) throw insertError;
    }
  }
  apply(next);
}
