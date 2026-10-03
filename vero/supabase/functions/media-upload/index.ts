// media-upload: stores an already-ENCRYPTED attachment and records it.
//
// POST { conversationId, data: base64(ciphertext), hash }
//   -> { mediaId, objectId }
// The plaintext, the file key and the real MIME type never reach this function.

import { adminClient, corsHeaders, errorResponse, getCaller, isMember, json, UUID_RE } from "../_shared/http.ts";
import { putBlob } from "../_shared/blobStore.ts";

const MAX_BYTES = 16 * 1024 * 1024; // ciphertext = plaintext (15 MB client cap) + 16-byte tag
const MAX_UPLOADS_PER_MINUTE = 30;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const admin = adminClient();
    const user = await getCaller(req, admin);
    if (!user) return errorResponse("Unauthorized", 401);

    let body: { conversationId?: unknown; data?: unknown; hash?: unknown };
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }
    const { conversationId, data, hash } = body;
    if (typeof conversationId !== "string" || !UUID_RE.test(conversationId)) {
      return errorResponse("Invalid conversationId", 400);
    }
    if (typeof data !== "string" || data.length === 0) return errorResponse("Missing data", 400);
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) return errorResponse("Invalid hash", 400);
    if (data.length > Math.ceil(MAX_BYTES / 3) * 4) return errorResponse("File too large", 413);

    if (!(await isMember(admin, conversationId, user.id))) {
      return errorResponse("Not a member of this conversation", 403);
    }

    // Simple per-user rate limit.
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count } = await admin
      .from("media")
      .select("id", { count: "exact", head: true })
      .eq("uploader_id", user.id)
      .gte("created_at", since);
    if ((count ?? 0) >= MAX_UPLOADS_PER_MINUTE) return errorResponse("Too many uploads, slow down", 429);

    let bytes: Uint8Array;
    try {
      const bin = atob(data);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      return errorResponse("data must be base64", 400);
    }
    if (bytes.length > MAX_BYTES) return errorResponse("File too large", 413);

    const objectId = await putBlob(admin, bytes);

    const { data: row, error } = await admin
      .from("media")
      .insert({
        conversation_id: conversationId,
        uploader_id: user.id,
        storage_object_id: objectId,
        encrypted_size: bytes.length,
        encrypted_hash: hash.toLowerCase(),
      })
      .select("id")
      .single();
    if (error) throw error;

    return json({ mediaId: row.id, objectId });
  } catch (e) {
    console.error("[media-upload] failed:", e instanceof Error ? e.message : "unknown error");
    return errorResponse("Upload failed", 500);
  }
});
