// Supabase client. Only the publishable (anon) key ever ships in the app;
// authorization is enforced by RLS + RPCs (supabase/migrations).

import 'react-native-url-polyfill/auto';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

/** False when .env is missing: the app then only offers demo mode. */
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

if (!isSupabaseConfigured) {
  console.warn(
    '[Vero] EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY are not set. ' +
      'Copy .env.example to .env to connect a backend; until then only demo mode works.'
  );
}

export const supabase = createClient(
  SUPABASE_URL || 'https://not-configured.invalid',
  SUPABASE_ANON_KEY || 'not-configured',
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  }
);

// Refresh tokens only while the app is in the foreground (Supabase's RN guidance).
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}

/** Turns PostgREST/RPC errors into something presentable. */
export function friendlyError(e: unknown, fallback = 'Something went wrong'): string {
  const msg = (e as any)?.message;
  if (typeof msg !== 'string' || !msg) return fallback;
  if (/network request failed|fetch failed/i.test(msg)) return 'No connection. Check your internet and try again.';
  return msg;
}
