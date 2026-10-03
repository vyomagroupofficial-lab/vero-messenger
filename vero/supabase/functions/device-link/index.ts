// device-link: sign a new device (web/desktop) into an account by scanning a
// QR code with an already signed-in phone. No password and no private key
// ever leaves the phone.
//
// POST JSON { action, ... }
//   create   (anonymous)  { secretHash, publicKey, deviceLabel? }       -> { linkId, expiresAt }
//   poll     (anonymous)  { linkId, claimKey }                          -> { status, tokenHash? }
//   cancel   (anonymous)  { linkId, claimKey }                          -> { ok }
//   inspect  (signed in)  { linkId }                                    -> { deviceLabel, createdAt, expiresAt }
//   approve  (signed in)  { linkId, publicKey, deviceId, senderPublicKey } -> { expiresAt }
//
// The new device keeps a random secret S (only in its QR code) and sends
// sha256(claimKey) where claimKey = BLAKE2b(S, "vero-link/claim/v1"). After the
// phone approves, the first `poll` that presents claimKey atomically claims the
// request (single use, 2-minute expiry, see device_link_claim in 009) and gets
// a one-time magic-link token hash for the approving account, which it
// exchanges with supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }).
// The token is minted at claim time and never stored.

import { adminClient, corsHeaders, errorResponse, getCaller, json, UUID_RE } from "../_shared/http.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const KEY32 = /^[A-Za-z0-9_-]{43}$/;

type Body = Record<string, unknown>;

function str(body: Body, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v : "";
}

/** Maps RPC errors (SQLSTATE) to HTTP responses without leaking internals. */
function rpcError(error: { code?: string; message?: string }): Response {
  switch (error.code) {
    case "P0002":
      return errorResponse("Link request not found, expired or already used", 404);
    case "42501":
      return errorResponse("Not allowed", 403);
    case "22023":
      return errorResponse("Invalid request", 400);
    case "PT429":
      return errorResponse("Too many requests, try again later", 429);
    default:
      console.error("[device-link] rpc failed:", error.code ?? "unknown");
      return errorResponse("Request failed", 500);
  }
}

function clientKey(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const ip = fwd.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "";
  return ip || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: Body;
  try {
    body = await req.json();
    if (!body || typeof body !== "object") throw new Error("not an object");
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  try {
    const admin = adminClient();
    const action = str(body, "action");
    const linkId = str(body, "linkId");
    if (action !== "create" && !UUID_RE.test(linkId)) return errorResponse("Invalid linkId", 400);

    switch (action) {
      case "create": {
        const secretHash = str(body, "secretHash");
        const publicKey = str(body, "publicKey");
        const deviceLabel = str(body, "deviceLabel").slice(0, 64) || null;
        if (!HEX64.test(secretHash) || !KEY32.test(publicKey)) return errorResponse("Invalid request", 400);
        const { data, error } = await admin.rpc("device_link_create", {
          p_secret_hash: secretHash,
          p_ephemeral_public_key: publicKey,
          p_device_label: deviceLabel,
          p_client_key: clientKey(req),
        });
        if (error) return rpcError(error);
        const row = Array.isArray(data) ? data[0] : data;
        return json({ linkId: row.id, expiresAt: row.expires_at });
      }

      case "poll": {
        const claimKey = str(body, "claimKey");
        if (!HEX64.test(claimKey)) return errorResponse("Invalid request", 400);
        const { data, error } = await admin.rpc("device_link_claim", { p_id: linkId, p_claim_key: claimKey });
        if (error) return rpcError(error);
        const row = Array.isArray(data) ? data[0] : data;
        const status: string = row?.status ?? "invalid";
        if (status !== "approved") return json({ status });

        // Claimed (single use). Mint a one-time sign-in token for that account.
        const { data: userData, error: userError } = await admin.auth.admin.getUserById(row.user_id);
        const email = userData?.user?.email;
        if (userError || !email) {
          console.error("[device-link] approving account has no email");
          return errorResponse("This account can't be linked this way", 409);
        }
        const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
        const tokenHash = link?.properties?.hashed_token;
        if (linkError || !tokenHash) {
          console.error("[device-link] generateLink failed:", linkError?.message ?? "no token");
          return errorResponse("Could not create a sign-in token", 500);
        }
        return json({ status: "approved", tokenHash }, 200);
      }

      case "cancel": {
        const claimKey = str(body, "claimKey");
        if (!HEX64.test(claimKey)) return errorResponse("Invalid request", 400);
        const { error } = await admin.rpc("device_link_cancel", { p_id: linkId, p_claim_key: claimKey });
        if (error) return rpcError(error);
        return json({ ok: true });
      }

      case "inspect": {
        const user = await getCaller(req, admin);
        if (!user) return errorResponse("Unauthorized", 401);
        const { data, error } = await admin.rpc("device_link_inspect", { p_id: linkId });
        if (error) return rpcError(error);
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) return errorResponse("Link request not found, expired or already used", 404);
        return json({ deviceLabel: row.device_label, createdAt: row.created_at, expiresAt: row.expires_at });
      }

      case "approve": {
        const user = await getCaller(req, admin);
        if (!user) return errorResponse("Unauthorized", 401);
        const publicKey = str(body, "publicKey");
        const senderPublicKey = str(body, "senderPublicKey");
        const deviceId = str(body, "deviceId");
        if (!KEY32.test(publicKey) || !KEY32.test(senderPublicKey) || !UUID_RE.test(deviceId)) {
          return errorResponse("Invalid request", 400);
        }
        const { data, error } = await admin.rpc("device_link_approve", {
          p_id: linkId,
          p_user_id: user.id,
          p_device_id: deviceId,
          p_ephemeral_public_key: publicKey,
          p_sender_public_key: senderPublicKey,
        });
        if (error) return rpcError(error);
        return json({ expiresAt: data });
      }

      default:
        return errorResponse("Unknown action", 400);
    }
  } catch (e) {
    console.error("[device-link] failed:", e instanceof Error ? e.message : "unknown error");
    return errorResponse("Request failed", 500);
  }
});
