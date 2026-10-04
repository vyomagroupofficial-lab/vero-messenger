// send-push: wakes devices through the Expo Push API.
//
// Called by the database (pg_net, see 005_settings_push_backup.sql) with the
// header `x-webhook-secret: <Vault push_webhook_secret>`; the secret is checked
// with the service-role-only RPC verify_push_webhook_secret(), so no Edge
// Function secret has to be configured.
//
// Body (ids only, never content):
//   { "type": "message",      "message_id": "<uuid>" }
//   { "type": "call",         "call_id": "<uuid>" }
//   { "type": "channel_post", "post_id": "<uuid>" }
//
// A signed-in CALLER may also invoke it for their own ringing call
// (Authorization: Bearer <user JWT>, body { "type": "call", "call_id" }),
// so the calls feature can ring without a database trigger.
//
// Notifications never contain message content: "New message", with the
// sender's name only if the recipient enabled previews (_shared/pushPayload.ts).

import { adminClient, corsHeaders, errorResponse, getCaller, json, UUID_RE } from "../_shared/http.ts";
import { sendPushItems } from "../_shared/push.ts";
import { buildCallPushes, buildChannelPostPushes, buildMessagePushes, type PushItem } from "../_shared/pushPayload.ts";

interface PushRequest {
  type?: unknown;
  message_id?: unknown;
  call_id?: unknown;
  post_id?: unknown;
}

const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: PushRequest;
  try {
    body = (await req.json()) as PushRequest;
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  try {
    const admin = adminClient();

    // ── authenticate ──────────────────────────────────────────────────────
    const secret = req.headers.get("x-webhook-secret");
    let fromDatabase = false;
    if (secret) {
      const { data, error } = await admin.rpc("verify_push_webhook_secret", { p_secret: secret });
      if (error) throw new Error("secret check failed");
      fromDatabase = data === true;
      if (!fromDatabase) return errorResponse("Unauthorized", 401);
    }
    let callerId: string | null = null;
    if (!fromDatabase) {
      // Only the caller of a ringing call may trigger a push themself.
      if (body.type !== "call") return errorResponse("Unauthorized", 401);
      const caller = await getCaller(req, admin);
      if (!caller) return errorResponse("Unauthorized", 401);
      callerId = caller.id;
    }

    // ── resolve recipients and build payloads ─────────────────────────────
    let items: PushItem[];
    switch (body.type) {
      case "message": {
        if (!isUuid(body.message_id)) return errorResponse("message_id required", 400);
        const { data, error } = await admin.rpc("get_message_push_targets", { p_message_id: body.message_id });
        if (error) throw new Error("target lookup failed");
        items = buildMessagePushes(data ?? []);
        break;
      }
      case "call": {
        if (!isUuid(body.call_id)) return errorResponse("call_id required", 400);
        const { data, error } = await admin.rpc("get_call_push_targets", {
          p_call_id: body.call_id,
          p_requester: callerId,
        });
        if (error) throw new Error("target lookup failed");
        items = buildCallPushes(data ?? []);
        break;
      }
      case "channel_post": {
        if (!isUuid(body.post_id)) return errorResponse("post_id required", 400);
        const { data, error } = await admin.rpc("get_channel_post_push_targets", { p_post_id: body.post_id });
        if (error) throw new Error("target lookup failed");
        items = buildChannelPostPushes(data ?? []);
        break;
      }
      default:
        return errorResponse("Unknown push type", 400);
    }

    const result = await sendPushItems(admin, items);
    return json(result);
  } catch (e) {
    console.error("[send-push] failed:", e instanceof Error ? e.message : "unknown error");
    return errorResponse("Push failed", 500);
  }
});
