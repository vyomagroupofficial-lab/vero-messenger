// call-push: wakes the callee's devices (or a group's members) for an
// incoming call when the app is in the background or closed.
//
// Kept separate from `send-push` (messages) on purpose. The caller's app
// invokes it right after start_direct_call / start_group_call:
//   POST (Authorization: Bearer <caller JWT>) { callId }
// It only pushes for a call this user started in the last minute that is still
// ringing / live, and only once per call (call_sessions.push_sent_at).
//
// Payload: "Incoming voice/video call from <name>" with category
// `incoming_call` (Accept / Decline buttons, registered by the app in
// src/features/calls/callNotifications.ts) on the Android channel `calls`.
// Unlike message pushes, this shows the caller's display name (and group
// name) to the OS push services (APNs / FCM via Expo) - a deliberate trade-off
// so people know who is calling; no media or keys are involved.

import { adminClient, corsHeaders, errorResponse, getCaller, json, UUID_RE } from "../_shared/http.ts";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const RING_SECONDS = 45;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const admin = adminClient();
  const caller = await getCaller(req, admin);
  if (!caller) return errorResponse("Unauthorized", 401);

  let callId = "";
  try {
    callId = String((await req.json())?.callId ?? "");
  } catch {
    // fallthrough
  }
  if (!UUID_RE.test(callId)) return errorResponse("Invalid request", 400);

  try {
    // Claim the push atomically: only the caller, only once, only while fresh.
    const since = new Date(Date.now() - 60_000).toISOString();
    const { data: claimed, error } = await admin
      .from("call_sessions")
      .update({ push_sent_at: new Date().toISOString() })
      .eq("id", callId)
      .eq("caller_id", caller.id)
      .is("push_sent_at", null)
      .in("status", ["ringing", "active"])
      .gte("created_at", since)
      .select("id, conversation_id, caller_id, caller_device_id, callee_id, call_type, is_group, created_at")
      .maybeSingle();
    if (error) throw error;
    if (!claimed) return json({ sent: 0, skipped: true });

    let recipients: string[] = [];
    let groupName: string | null = null;
    if (claimed.is_group) {
      const { data: members } = await admin
        .from("conversation_members")
        .select("user_id")
        .eq("conversation_id", claimed.conversation_id)
        .is("left_at", null)
        .neq("user_id", caller.id);
      recipients = (members ?? []).map((m) => m.user_id as string);
      const { data: conv } = await admin
        .from("conversations")
        .select("group_name")
        .eq("id", claimed.conversation_id)
        .maybeSingle();
      groupName = (conv?.group_name as string | null) ?? null;
    } else if (claimed.callee_id) {
      recipients = [claimed.callee_id as string];
    }
    if (!recipients.length) return json({ sent: 0 });

    // Nobody gets rung by someone they blocked (or who blocked them).
    const { data: blocks } = await admin
      .from("blocks")
      .select("blocker_user_id, blocked_user_id")
      .or(`blocker_user_id.eq.${caller.id},blocked_user_id.eq.${caller.id}`);
    const blocked = new Set(
      (blocks ?? []).map((b) => (b.blocker_user_id === caller.id ? b.blocked_user_id : b.blocker_user_id) as string)
    );
    recipients = recipients.filter((id) => !blocked.has(id));
    if (!recipients.length) return json({ sent: 0 });

    const { data: profile } = await admin.from("profiles").select("display_name").eq("id", caller.id).maybeSingle();
    const callerName = ((profile?.display_name as string | undefined) || "Someone").slice(0, 64);

    const { data: tokens } = await admin.from("push_tokens").select("device_id, token").in("user_id", recipients);
    if (!tokens?.length) return json({ sent: 0 });

    const kind = claimed.call_type === "video" ? "video" : "voice";
    const title = claimed.is_group ? (groupName || "Group call") : "Vero";
    const body = claimed.is_group
      ? `${callerName} started a ${kind} call`
      : `Incoming ${kind} call from ${callerName}`;
    const expiresAt = Math.floor(new Date(claimed.created_at as string).getTime() / 1000) + RING_SECONDS;

    const messages = tokens.map((t) => ({
      to: t.token,
      title,
      body,
      sound: "default",
      channelId: "calls",
      categoryId: "incoming_call",
      priority: "high",
      interruptionLevel: "time-sensitive",
      expiration: expiresAt,
      data: {
        type: "call",
        callId: claimed.id,
        conversationId: claimed.conversation_id,
        callType: kind,
        isGroup: claimed.is_group,
        groupName,
        callerId: caller.id,
        callerDeviceId: claimed.caller_device_id,
        callerName,
      },
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
      const dead = ((tickets ?? []) as { status: string; details?: { error?: string } }[])
        .map((ticket, j) => (ticket.details?.error === "DeviceNotRegistered" ? tokens[i + j].device_id : null))
        .filter((id): id is string => !!id);
      if (dead.length) await admin.from("push_tokens").delete().in("device_id", dead);
      sent += batch.length - dead.length;
    }
    return json({ sent });
  } catch (e) {
    console.error("[call-push] failed:", e instanceof Error ? e.message : "unknown error");
    return errorResponse("Push failed", 500);
  }
});
