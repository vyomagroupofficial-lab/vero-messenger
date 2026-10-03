// gif-search: privacy proxy for Tenor / GIPHY.
//
// POST { action: "status" }                              -> { configured, provider }
// POST { action: "trending" | "search", q?, pos?, limit? } -> { provider, results[], next }
//   (requires a user JWT; rate limited per user via gif_rate_limit_hit)
// GET  ?m=<url>&e=<expiry>&s=<signature>                 -> the GIF/preview bytes
//
// The client never talks to the GIF provider: searches AND every preview/GIF
// download go through this function, so the provider sees neither the user's
// IP nor the API key. Result URLs are rewritten to short-lived HMAC-signed
// proxy paths (signed with a key derived from the service-role key), which is
// why this function runs with verify_jwt = false: <img> tags can't send an
// Authorization header. Searches still require and verify a user JWT.
//
// Configuration (optional; without it the app shows "GIFs aren't set up"):
//   TENOR_API_KEY  or  GIPHY_API_KEY   (env secret, Vault secret or app_config row)
//   GIF_PROVIDER = tenor | giphy       (only needed if both keys are set)

import { adminClient, corsHeaders, env, errorResponse, getCaller, json } from "../_shared/http.ts";
import { configValue } from "../_shared/appConfig.ts";
import { giphy, type GifPage, isAllowedMediaUrl, type Provider, tenor } from "./providers.ts";

const SEARCHES_PER_MINUTE = 60;
const URL_TTL_SECONDS = 2 * 60 * 60;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = /^(image\/gif|image\/webp|video\/mp4)$/;

// ── signed proxy URLs ─────────────────────────────────────────────────────────

let signingKey: Promise<CryptoKey> | null = null;
function getSigningKey(): Promise<CryptoKey> {
  signingKey ??= (async () => {
    const material = new TextEncoder().encode(`vero/gif-proxy/v1|${env("SUPABASE_SERVICE_ROLE_KEY")}`);
    const raw = await crypto.subtle.digest("SHA-256", material);
    return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  })();
  return signingKey;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function signedPath(url: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
  const m = b64url(new TextEncoder().encode(url));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await getSigningKey(), new TextEncoder().encode(`${m}.${exp}`)),
  );
  return `/functions/v1/gif-search?m=${m}&e=${exp}&s=${b64url(sig)}`;
}

async function verifySigned(m: string, e: string, s: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(m) || !/^\d{1,12}$/.test(e) || !/^[A-Za-z0-9_-]{43}$/.test(s)) return null;
  if (parseInt(e, 10) < Date.now() / 1000) return null;
  const ok = await crypto.subtle.verify(
    "HMAC",
    await getSigningKey(),
    fromB64url(s),
    new TextEncoder().encode(`${m}.${e}`),
  );
  if (!ok) return null;
  const url = new TextDecoder().decode(fromB64url(m));
  return isAllowedMediaUrl(url) ? url : null;
}

// ── media proxy ───────────────────────────────────────────────────────────────

async function proxyMedia(url: string): Promise<Response> {
  // No client headers are forwarded: the provider only sees this server.
  // Redirects are followed only within the provider CDN allow-list.
  let upstream = await fetch(url, { redirect: "manual" });
  for (let hops = 0; upstream.status >= 300 && upstream.status < 400 && hops < 3; hops++) {
    const next = new URL(upstream.headers.get("location") ?? "", url).toString();
    await upstream.body?.cancel();
    if (!isAllowedMediaUrl(next)) return errorResponse("Not found", 404);
    upstream = await fetch(next, { redirect: "manual" });
  }
  if (!upstream.ok || !upstream.body) return errorResponse("Not found", 404);
  const type = (upstream.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MEDIA_TYPES.test(type)) return errorResponse("Unsupported media", 415);
  const declared = parseInt(upstream.headers.get("content-length") ?? "0", 10);
  if (declared > MAX_MEDIA_BYTES) return errorResponse("Too large", 413);

  let seen = 0;
  const limited = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > MAX_MEDIA_BYTES) controller.error(new Error("too large"));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, {
    headers: {
      ...corsHeaders,
      "Content-Type": type,
      "Cache-Control": "private, max-age=7200",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ── provider selection ────────────────────────────────────────────────────────

async function providerConfig(
  admin: ReturnType<typeof adminClient>,
): Promise<{ provider: Provider; key: string } | null> {
  const preferred = (await configValue(admin, "GIF_PROVIDER"))?.toLowerCase();
  const tenorKey = await configValue(admin, "TENOR_API_KEY");
  const giphyKey = await configValue(admin, "GIPHY_API_KEY");
  if (preferred === "giphy" && giphyKey) return { provider: "giphy", key: giphyKey };
  if (tenorKey) return { provider: "tenor", key: tenorKey };
  if (giphyKey) return { provider: "giphy", key: giphyKey };
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    if (req.method === "GET") {
      const q = new URL(req.url).searchParams;
      const url = await verifySigned(q.get("m") ?? "", q.get("e") ?? "", q.get("s") ?? "");
      if (!url) return errorResponse("Invalid or expired link", 403);
      return await proxyMedia(url);
    }
    if (req.method !== "POST") return errorResponse("Method not allowed", 405);

    const admin = adminClient();
    const user = await getCaller(req, admin);
    if (!user) return errorResponse("Unauthorized", 401);

    let body: { action?: unknown; q?: unknown; pos?: unknown; limit?: unknown };
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    const config = await providerConfig(admin);
    if (body.action === "status") {
      return json({ configured: !!config, provider: config?.provider ?? null });
    }
    if (body.action !== "search" && body.action !== "trending") return errorResponse("Unknown action", 400);
    if (!config) return json({ configured: false, error: "GIF search is not configured" }, 503);

    const q = body.action === "search" && typeof body.q === "string" ? body.q.trim().slice(0, 100) : "";
    if (body.action === "search" && !q) return errorResponse("Missing query", 400);
    const pos = typeof body.pos === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(body.pos) ? body.pos : undefined;
    const limit = Math.max(1, Math.min(50, typeof body.limit === "number" ? Math.floor(body.limit) : 24));

    const { data: allowed, error: rlError } = await admin.rpc("gif_rate_limit_hit", {
      p_user_id: user.id,
      p_limit: SEARCHES_PER_MINUTE,
      p_window_seconds: 60,
    });
    if (rlError) throw rlError;
    if (allowed !== true) return errorResponse("Too many searches, slow down", 429);

    let page: GifPage;
    try {
      page = config.provider === "tenor"
        ? await tenor(config.key, { q: q || undefined, pos, limit })
        : await giphy(config.key, { q: q || undefined, pos, limit });
    } catch (e) {
      console.error("[gif-search] provider error:", e instanceof Error ? e.message : "unknown");
      return errorResponse("GIF provider unavailable", 502);
    }

    const results = await Promise.all(
      page.results
        .filter((r) => isAllowedMediaUrl(r.preview.url) && isAllowedMediaUrl(r.send.url))
        .map(async (r) => ({
          id: r.id,
          title: r.title,
          width: r.width,
          height: r.height,
          preview: { path: await signedPath(r.preview.url), mimeType: r.preview.mimeType },
          send: {
            path: await signedPath(r.send.url),
            mimeType: r.send.mimeType,
            width: r.send.width,
            height: r.send.height,
            size: r.send.size ?? null,
          },
        })),
    );
    return json({ configured: true, provider: config.provider, results, next: page.next });
  } catch (e) {
    console.error("[gif-search] failed:", e instanceof Error ? e.message : "unknown error");
    return errorResponse("GIF search failed", 500);
  }
});
