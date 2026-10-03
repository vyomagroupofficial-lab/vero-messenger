// Supabase Edge Function: cleanup-expired
// Cleans up expired disappearing messages and old one-time prekeys
// Implements Section 33 & 39 of Master Plan

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req: Request) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Call database cleanup function
    const { error: cleanupError } = await supabase.rpc("cleanup_expired_messages");
    if (cleanupError) throw cleanupError;

    // Delete one-time prekeys older than 30 days that have been used
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from("device_prekeys")
      .delete()
      .lt("created_at", thirtyDaysAgo);

    return new Response(
      JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
