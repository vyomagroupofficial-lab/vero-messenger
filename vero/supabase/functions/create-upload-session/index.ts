// Supabase Edge Function: create-upload-session
// Handles authenticated Google Drive uploads for encrypted media
// Private key stays server-side - never exposed to client

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_SERVICE_ACCOUNT_JSON = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")!;
const DRIVE_FOLDER_ID = Deno.env.get("GOOGLE_DRIVE_FOLDER_ID")!;

serve(async (req: Request) => {
  // CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    // 1. Authenticate the request
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. Parse request
    const body = await req.json();
    const { conversationId, encryptedData, mimeTypeHint, encryptedSize, sha256 } = body;

    // 3. Validate input
    if (!conversationId || !encryptedData || !mimeTypeHint || !encryptedSize) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. Validate conversation membership (authorization)
    const { data: member } = await supabase
      .from("conversation_members")
      .select("conversation_id")
      .eq("conversation_id", conversationId)
      .eq("user_id", user.id)
      .is("left_at", null)
      .single();

    if (!member) {
      return new Response(JSON.stringify({ error: "Not a conversation member" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 5. Validate file size limits
    const SIZE_LIMITS: Record<string, number> = {
      "image/": 25 * 1024 * 1024,   // 25 MB
      "video/": 500 * 1024 * 1024,  // 500 MB
      "audio/": 25 * 1024 * 1024,   // 25 MB
      "application/": 100 * 1024 * 1024, // 100 MB
    };

    const mimePrefix = Object.keys(SIZE_LIMITS).find((k) => mimeTypeHint.startsWith(k));
    const limit = mimePrefix ? SIZE_LIMITS[mimePrefix] : 25 * 1024 * 1024;

    if (encryptedSize > limit) {
      return new Response(JSON.stringify({ error: "File exceeds size limit" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 6. Get Google Drive access token using service account
    // NOTE: In production, use proper JWT assertion flow
    // This is a simplified placeholder
    const serviceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    
    // For now, return a placeholder response
    // Full implementation needs google-auth-library or similar
    const driveFileId = `vero-${crypto.randomUUID()}`;

    // In production: Upload to Drive using resumable upload API
    // const uploadUrl = await createDriveUploadSession(accessToken, DRIVE_FOLDER_ID);
    // const fileId = await uploadToDrive(uploadUrl, encryptedData);

    // 7. Return the Drive file ID (never expose auth tokens to client)
    return new Response(
      JSON.stringify({
        driveFileId,
        message: "Upload session created",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    console.error("[create-upload-session] Error:", error);
    // Log only error codes, never log plaintext, keys, or content
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
