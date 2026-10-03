// stories-cleanup: hard-deletes expired stories and removes the ENCRYPTED
// blobs of expired/deleted stories from the private `vero-stories` bucket.
//
// Schedule it (e.g. every 15 minutes) with:
//   Authorization: Bearer <CRON_SECRET>
// (pg_cron already runs the SQL part every 10 minutes when enabled; this
// function additionally removes the blobs flagged in story_media_trash.)

import { adminClient, corsHeaders, errorResponse, env, json, safeEqual } from "../_shared/http.ts";

const BUCKET = "vero-stories";
const BATCH = 500;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(token, env("CRON_SECRET"))) return errorResponse("Unauthorized", 401);

  try {
    const admin = adminClient();

    const { data: expired, error } = await admin.rpc("cleanup_expired_stories");
    if (error) throw error;

    const { data: trash, error: trashError } = await admin
      .from("story_media_trash")
      .select("object_path")
      .order("flagged_at", { ascending: true })
      .limit(BATCH);
    if (trashError) throw trashError;

    const paths = (trash ?? []).map((t: { object_path: string }) => t.object_path);
    let blobsDeleted = 0;
    if (paths.length > 0) {
      // Removing a path that no longer exists is not an error for Storage.
      const { error: removeError } = await admin.storage.from(BUCKET).remove(paths);
      if (removeError) throw new Error(`storage delete failed: ${removeError.message}`);
      const { error: deleteError } = await admin.from("story_media_trash").delete().in("object_path", paths);
      if (deleteError) throw deleteError;
      blobsDeleted = paths.length;
    }

    return json({ storiesDeleted: expired ?? 0, blobsDeleted });
  } catch (e) {
    console.error("[stories-cleanup] failed:", e instanceof Error ? e.message : "unknown error");
    return errorResponse("Cleanup failed", 500);
  }
});
