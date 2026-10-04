// cleanup-expired: deletes expired disappearing messages and the encrypted
// blobs of deleted/expired media.
//
// Schedule it (e.g. every 15 minutes) with:
//   Authorization: Bearer <CRON_SECRET>
// (pg_cron already runs the SQL part every 5 minutes when enabled; this
// function additionally removes the blobs from Drive / Storage.)

import { adminClient, corsHeaders, errorResponse, json, safeEqual } from "../_shared/http.ts";
import { configValue } from "../_shared/appConfig.ts";
import { deleteBlob } from "../_shared/blobStore.ts";

const BATCH = 200;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  // CRON_SECRET comes from a function secret, or from Vault (so it can be set with SQL alone).
  const cronSecret = await configValue(adminClient(), "CRON_SECRET");
  if (!cronSecret || !safeEqual(token, cronSecret)) return errorResponse("Unauthorized", 401);

  try {
    const admin = adminClient();

    const { data: expired, error } = await admin.rpc("cleanup_expired_messages");
    if (error) throw error;
    // Uploads that were started but never confirmed (004_media.sql).
    const { error: staleError } = await admin.rpc("cleanup_stale_media_uploads");
    if (staleError) console.error("[cleanup-expired] stale upload sweep failed:", staleError.code ?? "unknown");

    const { data: media } = await admin
      .from("media")
      .select("id, storage_object_id")
      .not("deleted_at", "is", null)
      .limit(BATCH);

    let blobsDeleted = 0;
    for (const m of media ?? []) {
      try {
        // Forwarded attachments share one blob (forward_media in 006): only
        // remove it once no live media row references it any more.
        const { count: stillUsed, error: refError } = await admin
          .from("media")
          .select("id", { count: "exact", head: true })
          .eq("storage_object_id", m.storage_object_id)
          .is("deleted_at", null);
        if (refError) throw refError;
        if ((stillUsed ?? 0) === 0) await deleteBlob(admin, m.storage_object_id);
        await admin.from("media").delete().eq("id", m.id);
        blobsDeleted++;
      } catch (e) {
        console.error("[cleanup-expired] blob delete failed:", e instanceof Error ? e.message : "unknown");
      }
    }

    return json({ messagesDeleted: expired ?? 0, blobsDeleted });
  } catch (e) {
    console.error("[cleanup-expired] failed:", e instanceof Error ? e.message : "unknown error");
    return errorResponse("Cleanup failed", 500);
  }
});
