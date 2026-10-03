// media-download: membership-checked access to an ENCRYPTED attachment.
//
// GET ?id=<mediaId>&mode=url
//   -> { url, size, expiresIn }   short-lived signed Storage URL (Supabase backend)
//   -> { url: null, size }        backend has no signed URLs (Drive): use the proxy
// GET ?id=<mediaId>
//   -> application/octet-stream   the ciphertext, streamed through this function
//
// Only current members of the media's conversation get anything, and only for
// verified (ready), non-deleted uploads; everything else is the same 404 so ids
// can't be probed. The client verifies the BLAKE2b hash and decrypts with the
// key from the E2EE message.

import { adminClient, corsHeaders, errorResponse, getCaller, json, UUID_RE } from "../_shared/http.ts";
import { BlobNotFoundError, createDownloadUrl, openBlob } from "../_shared/blobStore.ts";

/** Long enough to start a download on a slow link; the URL only grants this one object. */
const SIGNED_URL_TTL_SECONDS = 120;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET") return errorResponse("Method not allowed", 405);

  try {
    const admin = adminClient();
    const user = await getCaller(req, admin);
    if (!user) return errorResponse("Unauthorized", 401);

    const params = new URL(req.url).searchParams;
    const id = params.get("id") ?? "";
    if (!UUID_RE.test(id)) return errorResponse("Invalid id", 400);

    const { data, error } = await admin.rpc("media_download_target", { p_media_id: id, p_user_id: user.id });
    if (error) throw new Error(`media_download_target failed (${error.code ?? "unknown"})`);
    const target = Array.isArray(data) ? data[0] : null;
    if (!target) return errorResponse("Not found", 404);

    if (params.get("mode") === "url") {
      const url = await createDownloadUrl(admin, target.storage_object_id, SIGNED_URL_TTL_SECONDS);
      return json(
        { url, size: target.encrypted_size, expiresIn: url ? SIGNED_URL_TTL_SECONDS : null },
        200,
      );
    }

    let blob: ReadableStream<Uint8Array>;
    try {
      blob = await openBlob(target.storage_object_id);
    } catch (e) {
      if (e instanceof BlobNotFoundError) return errorResponse("Not found", 404);
      throw e;
    }
    return new Response(blob, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(target.encrypted_size),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    console.error("[media-download] failed:", e instanceof Error ? e.message : "unknown error");
    return errorResponse("Download failed", 500);
  }
});
