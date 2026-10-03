// bot-admin: creates and manages bot accounts.
//
// Called with the OWNER's JWT:
//   POST { action: "create", username, name, description?, isPublic?, commands?, miniAppUrl? }
//        -> { botUserId, username, token }      (the token is shown ONCE)
//   POST { action: "rotate", botUserId }         -> { token }  (old token stops working,
//                                                    the bot's registered devices are revoked)
//   POST { action: "delete", botUserId }         -> { deleted: true }
// Called with the BOT's own JWT (from the SDK):
//   POST { action: "set_profile", description?, commands?, miniAppUrl? } -> { ok: true }
//
// A bot is a normal auth user with an unguessable password; the token handed
// to the owner encodes the bot's sign-in e-mail and that password:
//   vbot_<base64url(json{u: botUserId, e: email})>.<secret>
// Only SHA-256(token) is stored (bots.token_hash).
//
// Optional config: BOT_EMAIL_DOMAIN (default "bots.vero.invalid").

import { adminClient, corsHeaders, errorResponse, getCaller, json, UUID_RE } from "../_shared/http.ts";
import { configValue } from "../_shared/appConfig.ts";

const MAX_BOTS_PER_OWNER = 20;
const USERNAME_RE = /^[a-z0-9_]{3,30}$/;
const COMMAND_RE = /^[a-z0-9_]{1,32}$/;
const HTTPS_URL_RE = /^https:\/\/([a-z0-9-]+\.)+[a-z]{2,63}(:[0-9]{2,5})?(\/\S*)?$/;

type Admin = ReturnType<typeof adminClient>;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

function newSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

function makeToken(botUserId: string, email: string, secret: string): string {
  return `vbot_${b64url(new TextEncoder().encode(JSON.stringify({ u: botUserId, e: email })))}.${secret}`;
}

function parseCommands(v: unknown): { command: string; description: string }[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 50) return null;
  const out: { command: string; description: string }[] = [];
  for (const c of v) {
    const command = typeof c?.command === "string" ? c.command.replace(/^\//, "").toLowerCase() : "";
    const description = typeof c?.description === "string" ? c.description.trim().slice(0, 128) : "";
    if (!COMMAND_RE.test(command) || out.some((o) => o.command === command)) return null;
    out.push({ command, description });
  }
  return out;
}

const INVALID = Symbol("invalid");

/** undefined = not provided, null = clear, INVALID = reject. */
function optionalUrl(v: unknown): string | null | undefined | typeof INVALID {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return typeof v === "string" && v.length <= 512 && HTTPS_URL_RE.test(v) ? v : INVALID;
}

async function ownedBot(admin: Admin, ownerId: string, botUserId: unknown) {
  if (typeof botUserId !== "string" || !UUID_RE.test(botUserId)) return null;
  const { data } = await admin
    .from("bots")
    .select("id, user_id")
    .eq("user_id", botUserId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const admin = adminClient();
    const caller = await getCaller(req, admin);
    if (!caller) return errorResponse("Unauthorized", 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    const { data: callerProfile } = await admin.from("profiles").select("is_bot").eq("id", caller.id).maybeSingle();
    const callerIsBot = callerProfile?.is_bot === true;

    // ── bot updates its own profile ──────────────────────────────────────────
    if (body.action === "set_profile") {
      if (!callerIsBot) return errorResponse("Only bot accounts can call set_profile", 403);
      const patch: Record<string, unknown> = {};
      if (body.commands !== undefined) {
        const commands = parseCommands(body.commands);
        if (!commands) return errorResponse("Invalid commands", 400);
        patch.commands = commands;
      }
      if (body.description !== undefined) {
        if (typeof body.description !== "string" || body.description.length > 512) {
          return errorResponse("Invalid description", 400);
        }
        patch.description = body.description.trim() || null;
      }
      if (body.miniAppUrl !== undefined) {
        const url = optionalUrl(body.miniAppUrl);
        if (url === INVALID) return errorResponse("Mini-app URL must be https", 400);
        patch.mini_app_url = url;
      }
      if (Object.keys(patch).length === 0) return json({ ok: true });
      const { error } = await admin.from("bots").update(patch).eq("user_id", caller.id);
      if (error) return errorResponse("Invalid bot profile", 400);
      return json({ ok: true });
    }

    if (callerIsBot) return errorResponse("Bots cannot manage bots", 403);

    // ── create ───────────────────────────────────────────────────────────────
    if (body.action === "create") {
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      if (!USERNAME_RE.test(username) || !username.endsWith("bot")) {
        return errorResponse("Bot usernames use a-z, 0-9 and _, 3-30 characters, and must end in 'bot'", 400);
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 1 || name.length > 64) return errorResponse("Name must be 1-64 characters", 400);
      const description = typeof body.description === "string" ? body.description.trim().slice(0, 512) : null;
      const commands = parseCommands(body.commands);
      if (!commands) return errorResponse("Invalid commands", 400);
      const miniAppUrl = optionalUrl(body.miniAppUrl);
      if (miniAppUrl === INVALID) return errorResponse("Mini-app URL must be https", 400);

      const { data: taken } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
      if (taken) return errorResponse("That username is taken", 409);
      const { count } = await admin.from("bots").select("id", { count: "exact", head: true }).eq("owner_id", caller.id);
      if ((count ?? 0) >= MAX_BOTS_PER_OWNER) return errorResponse(`You can own up to ${MAX_BOTS_PER_OWNER} bots`, 409);

      const domain = (await configValue(admin, "BOT_EMAIL_DOMAIN")) || "bots.vero.invalid";
      const email = `${username}@${domain}`;
      const secret = newSecret();
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password: secret,
        email_confirm: true,
        user_metadata: { username, display_name: name },
        app_metadata: { is_bot: true, bot_owner_id: caller.id },
      });
      if (createError || !created.user) {
        console.error("[bot-admin] createUser failed:", createError?.message);
        return errorResponse("Could not create the bot account", 500);
      }
      const botUserId = created.user.id;
      const token = makeToken(botUserId, email, secret);

      const { error: insertError } = await admin.from("bots").insert({
        user_id: botUserId,
        owner_id: caller.id,
        name,
        description: description || null,
        commands,
        mini_app_url: miniAppUrl ?? null,
        is_public: body.isPublic === true,
        token_hash: await sha256Hex(token),
      });
      if (insertError) {
        await admin.auth.admin.deleteUser(botUserId);
        console.error("[bot-admin] insert failed:", insertError.message);
        return errorResponse("Could not create the bot", 400);
      }
      return json({ botUserId, username, token });
    }

    // ── rotate token ─────────────────────────────────────────────────────────
    if (body.action === "rotate") {
      const bot = await ownedBot(admin, caller.id, body.botUserId);
      if (!bot) return errorResponse("Bot not found", 404);
      const { data: botUser } = await admin.auth.admin.getUserById(bot.user_id);
      const email = botUser?.user?.email;
      if (!email) return errorResponse("Bot account not found", 404);
      const secret = newSecret();
      const { error } = await admin.auth.admin.updateUserById(bot.user_id, { password: secret });
      if (error) throw error;
      const token = makeToken(bot.user_id, email, secret);
      await admin.from("bots").update({ token_hash: await sha256Hex(token) }).eq("id", bot.id);
      // A leaked token may already be running somewhere: cut its devices off so
      // it can neither send nor receive new messages.
      await admin.from("devices").update({ revoked_at: new Date().toISOString() })
        .eq("user_id", bot.user_id).is("revoked_at", null);
      return json({ token });
    }

    // ── delete ───────────────────────────────────────────────────────────────
    if (body.action === "delete") {
      const bot = await ownedBot(admin, caller.id, body.botUserId);
      if (!bot) return errorResponse("Bot not found", 404);
      const { error } = await admin.auth.admin.deleteUser(bot.user_id);
      if (error) throw error;
      return json({ deleted: true });
    }

    return errorResponse("Unknown action", 400);
  } catch (e) {
    console.error("[bot-admin] failed:", e instanceof Error ? e.message : "unknown error");
    return errorResponse("Bot request failed", 500);
  }
});
