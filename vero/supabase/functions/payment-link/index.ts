// payment-link: OPTIONAL Razorpay Payment Links (cards / netbanking / UPI via
// a Razorpay-hosted checkout page).
//
// POST { action: "status" }                                  -> { configured, allowed }
// POST { action: "create", amountPaise, description?, reference } -> { linkId, shortUrl }
// POST { action: "check", linkId }                           -> { status }
//
// Off by default. To enable, set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET
// (env secret, Vault secret or app_config row) and allow-list accounts in
// public.payment_link_merchants. Links collect money into the OPERATOR's
// Razorpay account, which is why creating them is not self-serve.
//
// Plain UPI payments between users don't use this function at all.
// Privacy: amount and description are sent to Razorpay (unavoidable for a
// hosted checkout) but are NOT stored in the Vero database.

import { adminClient, corsHeaders, errorResponse, getCaller, json } from "../_shared/http.ts";
import { configValue } from "../_shared/appConfig.ts";

const MIN_PAISE = 100;
const MAX_PAISE = 100_000_00;
const LINKS_PER_HOUR = 30;
const LINK_TTL_SECONDS = 7 * 24 * 3600;
const RAZORPAY_API = "https://api.razorpay.com/v1/payment_links";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const admin = adminClient();
    const user = await getCaller(req, admin);
    if (!user) return errorResponse("Unauthorized", 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    const keyId = await configValue(admin, "RAZORPAY_KEY_ID");
    const keySecret = await configValue(admin, "RAZORPAY_KEY_SECRET");
    const configured = !!(keyId && keySecret);
    const { data: merchant } = await admin
      .from("payment_link_merchants")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    const allowed = configured && !!merchant;

    if (body.action === "status") return json({ configured, allowed });
    if (!configured) return errorResponse("Payment links are not configured on this server", 503);
    if (!merchant) return errorResponse("Payment links are not enabled for your account", 403);
    const auth = "Basic " + btoa(`${keyId}:${keySecret}`);

    if (body.action === "create") {
      const amount = body.amountPaise;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount < MIN_PAISE || amount > MAX_PAISE) {
        return errorResponse("Amount must be between ₹1 and ₹1,00,000", 400);
      }
      const reference = body.reference;
      if (typeof reference !== "string" || !/^[A-Za-z0-9]{8,35}$/.test(reference)) {
        return errorResponse("Invalid reference", 400);
      }
      const description = typeof body.description === "string"
        ? body.description.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80)
        : "";

      const since = new Date(Date.now() - 3600_000).toISOString();
      const { count } = await admin
        .from("payment_links")
        .select("id", { count: "exact", head: true })
        .eq("creator_id", user.id)
        .gte("created_at", since);
      if ((count ?? 0) >= LINKS_PER_HOUR) return errorResponse("Too many payment links, try later", 429);

      const res = await fetch(RAZORPAY_API, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          currency: "INR",
          accept_partial: false,
          description: description || "Vero payment",
          reference_id: reference,
          expire_by: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS,
          notify: { sms: false, email: false },
          reminder_enable: false,
        }),
      });
      const link = await res.json().catch(() => null);
      if (!res.ok || typeof link?.id !== "string" || typeof link?.short_url !== "string") {
        console.error("[payment-link] razorpay create failed:", res.status);
        return errorResponse(link?.error?.description ?? "Razorpay rejected the request", 502);
      }
      if (!/^https:\/\//.test(link.short_url)) return errorResponse("Unexpected Razorpay response", 502);

      const { error } = await admin.from("payment_links").insert({
        creator_id: user.id,
        provider_link_id: link.id,
        short_url: link.short_url,
        status: "created",
      });
      if (error) throw error;
      return json({ linkId: link.id, shortUrl: link.short_url });
    }

    if (body.action === "check") {
      const linkId = body.linkId;
      if (typeof linkId !== "string" || !/^plink_[A-Za-z0-9]{1,40}$/.test(linkId)) {
        return errorResponse("Invalid link id", 400);
      }
      const { data: row } = await admin
        .from("payment_links")
        .select("id")
        .eq("provider_link_id", linkId)
        .eq("creator_id", user.id)
        .maybeSingle();
      if (!row) return errorResponse("Link not found", 404);

      const res = await fetch(`${RAZORPAY_API}/${linkId}`, { headers: { Authorization: auth } });
      const link = await res.json().catch(() => null);
      const status = link?.status;
      if (!res.ok || !["created", "partially_paid", "paid", "expired", "cancelled"].includes(status)) {
        return errorResponse("Could not check the payment link", 502);
      }
      await admin.from("payment_links").update({ status }).eq("id", row.id);
      return json({ status });
    }

    return errorResponse("Unknown action", 400);
  } catch (e) {
    console.error("[payment-link] failed:", e instanceof Error ? e.message : "unknown error");
    return errorResponse("Payment link request failed", 500);
  }
});
