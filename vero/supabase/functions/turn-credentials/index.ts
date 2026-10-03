// turn-credentials: short-lived TURN credentials for calls (signed-in users only).
//
// POST (Authorization: Bearer <user JWT>) -> { iceServers: RTCIceServer[], ttl }
//
// Configuration (all optional; without any, the response is an empty list and
// the app uses public STUN only, which fails on some strict NATs / carriers):
//   1. Cloudflare Realtime TURN (recommended):
//        TURN_CLOUDFLARE_KEY_ID, TURN_CLOUDFLARE_API_TOKEN
//   2. Any TURN server with static credentials (e.g. coturn):
//        TURN_URLS="turn:turn.example.com:3478,turns:turn.example.com:5349"
//        TURN_USERNAME, TURN_CREDENTIAL
// Each value is read from the function's env first, then from Supabase Vault
// via the service-role-only RPC public.get_turn_config() (002_calls.sql), so it
// can be configured with SQL alone:
//   select vault.create_secret('<key id>', 'vero_turn_cloudflare_key_id');
//   select vault.create_secret('<api token>', 'vero_turn_cloudflare_api_token');
//
// TURN only relays DTLS-SRTP packets: it can't decrypt call audio/video.

import { adminClient, corsHeaders, errorResponse, getCaller, json } from "../_shared/http.ts";

const TTL_SECONDS = 4 * 60 * 60;

interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

type Config = Record<string, string>;

async function loadConfig(): Promise<Config> {
  const fromEnv: Config = {};
  const names: [string, string][] = [
    ["TURN_CLOUDFLARE_KEY_ID", "vero_turn_cloudflare_key_id"],
    ["TURN_CLOUDFLARE_API_TOKEN", "vero_turn_cloudflare_api_token"],
    ["TURN_URLS", "vero_turn_urls"],
    ["TURN_USERNAME", "vero_turn_username"],
    ["TURN_CREDENTIAL", "vero_turn_credential"],
  ];
  for (const [envName, vaultName] of names) {
    const v = Deno.env.get(envName);
    if (v) fromEnv[vaultName] = v;
  }
  const haveCloudflare = fromEnv.vero_turn_cloudflare_key_id && fromEnv.vero_turn_cloudflare_api_token;
  const haveStatic = fromEnv.vero_turn_urls;
  if (haveCloudflare || haveStatic) return fromEnv;

  try {
    const { data, error } = await adminClient().rpc("get_turn_config");
    if (error || !data || typeof data !== "object") return fromEnv;
    return { ...(data as Config), ...fromEnv };
  } catch {
    return fromEnv;
  }
}

function normalise(list: unknown): IceServer[] {
  const raw = Array.isArray(list) ? list : list ? [list] : [];
  const out: IceServer[] = [];
  for (const s of raw as Record<string, unknown>[]) {
    const urls = (Array.isArray(s?.urls) ? s.urls : typeof s?.urls === "string" ? [s.urls] : [])
      .filter((u): u is string => typeof u === "string" && /^(stun|turns?):/i.test(u))
      // Browsers block port 53; Cloudflare recommends dropping those URLs.
      .filter((u) => !/:53(\?|$)/.test(u));
    if (!urls.length) continue;
    out.push({
      urls,
      ...(typeof s.username === "string" ? { username: s.username } : {}),
      ...(typeof s.credential === "string" ? { credential: s.credential } : {}),
    });
  }
  return out;
}

async function cloudflare(keyId: string, token: string): Promise<IceServer[]> {
  const base = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials`;
  const init = {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: TTL_SECONDS }),
  };
  // Current endpoint returns a full iceServers array; the older one a single object.
  for (const path of ["generate-ice-servers", "generate"]) {
    const res = await fetch(`${base}/${path}`, init);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Cloudflare TURN returned ${res.status}`);
    const body = await res.json();
    return normalise(body?.iceServers);
  }
  throw new Error("Cloudflare TURN endpoint not found");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") return errorResponse("Method not allowed", 405);

  const caller = await getCaller(req, adminClient());
  if (!caller) return errorResponse("Unauthorized", 401);

  try {
    const cfg = await loadConfig();
    let iceServers: IceServer[] = [];
    let ttl = TTL_SECONDS;

    if (cfg.vero_turn_cloudflare_key_id && cfg.vero_turn_cloudflare_api_token) {
      iceServers = await cloudflare(cfg.vero_turn_cloudflare_key_id, cfg.vero_turn_cloudflare_api_token);
    } else if (cfg.vero_turn_urls) {
      const urls = cfg.vero_turn_urls.split(",").map((u) => u.trim()).filter(Boolean);
      iceServers = normalise([{ urls, username: cfg.vero_turn_username, credential: cfg.vero_turn_credential }]);
      ttl = 24 * 60 * 60; // static credentials: let clients cache for a day
    }

    return json({ iceServers, ttl, configured: iceServers.length > 0 });
  } catch (e) {
    console.error("[turn-credentials] failed:", e instanceof Error ? e.message : "unknown error");
    // Calls still work over STUN on most networks.
    return json({ iceServers: [], ttl: 300, configured: false, error: "TURN unavailable" });
  }
});
