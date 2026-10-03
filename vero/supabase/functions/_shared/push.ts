// Reusable Expo push sender for Edge Functions.
//
//   import { sendPushItems } from "../_shared/push.ts";
//   import { buildCallPushes } from "../_shared/pushPayload.ts";
//   const { data } = await admin.rpc("get_call_push_targets", { p_call_id, p_requester });
//   await sendPushItems(admin, buildCallPushes(data ?? []));
//
// Batches of 100 (Expo's limit), removes tokens Expo reports as
// DeviceNotRegistered, never logs tokens or payloads.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { chunk, deadTokens, EXPO_PUSH_URL, type PushItem } from "./pushPayload.ts";

export interface PushResult {
  sent: number;
  failed: number;
  removed: number;
}

export async function sendPushItems(admin: SupabaseClient, items: PushItem[]): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, removed: 0 };
  if (items.length === 0) return result;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
  };
  // Optional: only needed if "Enhanced push security" is enabled for the Expo project.
  const accessToken = Deno.env.get("EXPO_ACCESS_TOKEN");
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  for (const batch of chunk(items)) {
    let tickets: unknown = null;
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(batch.map((i) => i.message)),
      });
      if (!res.ok) {
        console.warn(`[push] Expo rejected a batch: HTTP ${res.status}`);
        result.failed += batch.length;
        continue;
      }
      tickets = ((await res.json()) as { data?: unknown }).data;
    } catch (e) {
      console.warn("[push] Expo request failed:", e instanceof Error ? e.name : "unknown");
      result.failed += batch.length;
      continue;
    }

    const dead = deadTokens(batch, tickets);
    for (const item of dead) {
      // Match the token too, so a token the device re-registered meanwhile survives.
      const { error } = await admin.from("push_tokens").delete().eq("device_id", item.deviceId).eq("token", item.token);
      if (!error) result.removed++;
    }
    const okCount = Array.isArray(tickets)
      ? tickets.filter((t) => (t as { status?: string } | null)?.status === "ok").length
      : 0;
    result.sent += okCount;
    result.failed += batch.length - okCount;
  }
  return result;
}
