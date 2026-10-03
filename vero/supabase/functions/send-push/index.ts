// send-push: wakes recipients' devices when a message is inserted.
//
// Invoke it from a Supabase Database Webhook on `public.messages` INSERT, with
// the header `x-webhook-secret: <PUSH_WEBHOOK_SECRET>`.
//
// Privacy: the notification says only "New message". No sender name, no
// content, no message type. The app fetches and decrypts on open.

import { adminClient, corsHeaders, errorResponse, env, json, safeEqual } from "../_shared/http.ts";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  record: { id: string; conversation_id: string; sender_user_id: string; message_type: string } | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const secret = req.headers.get("x-webhook-secret") ?? "";
  if (!safeEqual(secret, env("PUSH_WEBHOOK_SECRET"))) return errorResponse("Unauthorized", 401);

  try {
    const payload = (await req.json()) as WebhookPayload;
    const msg = payload.record;
    if (payload.type !== "INSERT" || payload.table !== "messages" || !msg) return json({ skipped: true });
    // Reactions and timer changes don't need a wake-up.
    if (msg.message_type === "reaction" || msg.message_type === "system") return json({ skipped: true });

    const admin = adminClient();
    const { data: members } = await admin
      .from("conversation_members")
      .select("user_id")
      .eq("conversation_id", msg.conversation_id)
      .is("left_at", null)
      .neq("user_id", msg.sender_user_id);
    const recipientIds = (members ?? []).map((m) => m.user_id);
    if (recipientIds.length === 0) return json({ sent: 0 });

    const { data: tokens } = await admin
      .from("push_tokens")
      .select("device_id, token")
      .in("user_id", recipientIds);
    if (!tokens?.length) return json({ sent: 0 });

    const messages = tokens.map((t) => ({
      to: t.token,
      title: "Vero",
      body: "New message",
      sound: "default",
      channelId: "messages",
      priority: "high",
      data: { conversationId: msg.conversation_id },
    }));

    let sent = 0;
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(batch),
      });
      if (!res.ok) continue;
      const { data: tickets } = await res.json();
      // Drop tokens Expo reports as dead.
      const dead = (tickets as { status: string; details?: { error?: string } }[])
        .map((ticket, j) => (ticket.details?.error === "DeviceNotRegistered" ? tokens[i + j].device_id : null))
        .filter((id): id is string => !!id);
      if (dead.length) await admin.from("push_tokens").delete().in("device_id", dead);
      sent += batch.length - dead.length;
    }
    return json({ sent });
  } catch (e) {
    console.error("[send-push] failed:", e instanceof Error ? e.message : "unknown error");
    return errorResponse("Push failed", 500);
  }
});
