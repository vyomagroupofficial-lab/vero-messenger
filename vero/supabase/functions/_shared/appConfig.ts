// Operator configuration for optional integrations (GIF search, Razorpay, ...).
//
// Lookup order for a key such as TENOR_API_KEY:
//   1. Edge Function secret / env  (supabase secrets set TENOR_API_KEY=...)
//   2. Supabase Vault secret with that name
//   3. public.app_config row        (insert into app_config (key, value) ...)
// 2 and 3 are read via get_app_secret(), which only the service role can call.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { value: string | null; at: number }>();

export async function configValue(admin: SupabaseClient, name: string): Promise<string | null> {
  const fromEnv = Deno.env.get(name);
  if (fromEnv) return fromEnv;
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const { data, error } = await admin.rpc("get_app_secret", { p_key: name });
  const value = !error && typeof data === "string" && data.length > 0 ? data : null;
  cache.set(name, { value, at: Date.now() });
  return value;
}
