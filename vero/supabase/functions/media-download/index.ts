// media-download: membership-checked proxy for an ENCRYPTED attachment.
//
// GET ?id=<mediaId>  -> application/octet-stream (ciphertext)
// The client verifies the hash and decrypts with the key from the E2EE message.

import { adminClient, corsHeaders, errorResponse, getCaller, isMember, UUID_RE } from "../_shared/http.ts";
import { getBlob } from "../_shared/blobStore.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET") return errorResponse("Method not allowed", 405);

  try {
    const admin = adminClient();
    const user = await getCaller(req, admin);
    if (!user) return errorResponse("Unauthorized", 401);

    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!UUID_RE.test(id)) return errorResponse("Invalid id", 400);

    const { data: media } = await admin
      .from("media")
      .select("conversation_id, storage_object_id, encrypted_size, deleted_at")
      .eq("id", id)
      .maybeSingle();
    // Same response for "missing" and "not yours" so ids can't be probed.
    if (!media || media.deleted_at || !(await isMember(admin, media.conversation_id, user.id))) {
      return errorResponse("Not found", 404);
    }

    const blob = await getBlob(admin, media.storage_object_id);
    return new Response(blob, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(media.encrypted_size),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    console.error("[media-download] failed:", e instanceof Error ? e.message : "unknown error");
    return errorResponse("Download failed", 500);
  }
});
