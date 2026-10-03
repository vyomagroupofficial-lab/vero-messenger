// media-upload: hands out a one-off upload URL for an already-ENCRYPTED
// attachment and verifies the upload afterwards. The ciphertext itself never
// passes through this function (no body-size or memory limits), and the
// plaintext, the file key and the real MIME type never reach the server.
//
// POST { action: "create", conversationId, size, hash }
//   -> { mediaId, objectId, upload: { url, method, headers }, maxBytes }
//   Checks membership, size (<= 50 MB ciphertext) and rate limits, creates a
//   *pending* media row and a signed upload URL for exactly that object.
//
// The app then PUTs the ciphertext to upload.url.
//
// POST { action: "confirm", mediaId }
//   -> { mediaId, objectId }
//   Streams the stored object, checks its size and BLAKE2b-256 against what
//   was declared, and marks the row ready. Only ready media can be referenced
//   by a message (trigger in 004_media.sql). A mismatch deletes the upload.

import { adminClient, corsHeaders, errorResponse, getCaller, json, UUID_RE } from "../_shared/http.ts";
import {
  backend,
  BlobNotFoundError,
  BlobTooLargeError,
  createUploadTarget,
  deleteBlob,
  measureBlob,
  resolveUploadedObject,
} from "../_shared/blobStore.ts";

/** Supabase free plan: 50 MB per Storage object. Applies to the ciphertext. */
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_UPLOADS_PER_MINUTE = 30;
const MAX_PENDING_UPLOADS = 20;
const HASH_RE = /^[0-9a-f]{64}$/;

type Admin = ReturnType<typeof adminClient>;

/** Maps the SQL errcodes raised by begin_media_upload to HTTP responses. */
function rpcError(error: { code?: string; message?: string }): Response {
  switch (error.code) {
    case "42501":
      return errorResponse("Not a member of this conversation", 403);
    case "54000":
      return errorResponse(`Files can be up to ${MAX_BYTES / 1024 / 1024} MB`, 413);
    case "53400":
      return errorResponse("Too many uploads, slow down", 429);
    case "22023":
      return errorResponse("Invalid upload", 400);
    default:
      throw new Error(`begin_media_upload failed (${error.code ?? "unknown"})`);
  }
}

async function create(admin: Admin, userId: string, body: Record<string, unknown>): Promise<Response> {
  const { conversationId, size, hash } = body;
  if (typeof conversationId !== "string" || !UUID_RE.test(conversationId)) {
    return errorResponse("Invalid conversationId", 400);
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) return errorResponse("Invalid size", 400);
  if (size > MAX_BYTES) return errorResponse(`Files can be up to ${MAX_BYTES / 1024 / 1024} MB`, 413);
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return errorResponse("Invalid hash", 400);

  const { data: mediaId, error } = await admin.rpc("begin_media_upload", {
    p_conversation_id: conversationId,
    p_uploader_id: userId,
    p_encrypted_size: size,
    p_encrypted_hash: hash,
    p_backend: backend(),
    p_max_bytes: MAX_BYTES,
    p_max_per_minute: MAX_UPLOADS_PER_MINUTE,
    p_max_pending: MAX_PENDING_UPLOADS,
  });
  if (error) return rpcError(error);
  if (typeof mediaId !== "string") throw new Error("begin_media_upload returned no id");

  try {
    const target = await createUploadTarget(admin, conversationId, mediaId, size);
    return json({
      mediaId,
      objectId: target.objectId,
      upload: { url: target.url, method: target.method, headers: target.headers },
      maxBytes: MAX_BYTES,
    });
  } catch (e) {
    await admin.rpc("complete_media_upload", { p_media_id: mediaId, p_uploader_id: userId, p_ok: false });
    throw e;
  }
}

async function confirm(admin: Admin, userId: string, body: Record<string, unknown>): Promise<Response> {
  const { mediaId } = body;
  if (typeof mediaId !== "string" || !UUID_RE.test(mediaId)) return errorResponse("Invalid mediaId", 400);

  const { data: row } = await admin
    .from("media")
    .select("storage_object_id, encrypted_size, encrypted_hash, upload_status")
    .eq("id", mediaId)
    .eq("uploader_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) return errorResponse("Upload not found", 404);
  if (row.upload_status === "ready") return json({ mediaId, objectId: row.storage_object_id });

  const objectId = await resolveUploadedObject(row.storage_object_id, mediaId);
  // Not there (yet): the client may retry the PUT, so keep the row pending.
  if (!objectId) return errorResponse("The upload has not arrived yet", 409);

  let measured: { size: number; hash: string } | null = null;
  try {
    measured = await measureBlob(objectId, row.encrypted_size);
  } catch (e) {
    if (e instanceof BlobNotFoundError) return errorResponse("The upload has not arrived yet", 409);
    if (!(e instanceof BlobTooLargeError)) throw e;
  }

  const ok = !!measured && measured.size === row.encrypted_size && measured.hash === row.encrypted_hash;
  const { data: updated, error } = await admin.rpc("complete_media_upload", {
    p_media_id: mediaId,
    p_uploader_id: userId,
    p_ok: ok,
    p_object_id: objectId,
  });
  if (error) throw new Error(`complete_media_upload failed (${error.code ?? "unknown"})`);
  if (!ok) {
    // Best effort now; cleanup-expired retries rows marked deleted.
    await deleteBlob(admin, objectId).catch(() => undefined);
    return errorResponse("The uploaded file did not match (size or checksum). Please try again.", 422);
  }
  if (!updated) return errorResponse("Upload not found", 404);
  return json({ mediaId, objectId });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const admin = adminClient();
    const user = await getCaller(req, admin);
    if (!user) return errorResponse("Unauthorized", 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }
    if (!body || typeof body !== "object") return errorResponse("Invalid JSON", 400);

    switch (body.action) {
      case "create":
        return await create(admin, user.id, body);
      case "confirm":
        return await confirm(admin, user.id, body);
      default:
        // Pre-004 clients posted the whole base64 ciphertext here.
        return errorResponse("Unsupported request. Please update Vero.", 400);
    }
  } catch (e) {
    console.error("[media-upload] failed:", e instanceof Error ? e.message : "unknown error");
    return errorResponse("Upload failed", 500);
  }
});
