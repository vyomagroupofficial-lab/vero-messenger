// Tenor v2 / GIPHY adapters -> one normalised result shape.

export interface GifResult {
  id: string;
  title: string;
  width: number;
  height: number;
  preview: { url: string; mimeType: string };
  send: { url: string; mimeType: string; width: number; height: number; size?: number };
}

export interface GifPage {
  results: GifResult[];
  next: string | null;
}

export type Provider = "tenor" | "giphy";

const MAX_SEND_BYTES = 6 * 1024 * 1024;

function mimeOf(url: string): string {
  if (/\.mp4(\?|$)/i.test(url)) return "video/mp4";
  if (/\.webp(\?|$)/i.test(url)) return "image/webp";
  return "image/gif";
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// ── Tenor v2 ──────────────────────────────────────────────────────────────────

interface TenorFormat {
  url: string;
  dims?: number[];
  size?: number;
}

export async function tenor(
  key: string,
  opts: { q?: string; pos?: string; limit: number; locale?: string },
): Promise<GifPage> {
  const params = new URLSearchParams({
    key,
    client_key: "vero",
    limit: String(opts.limit),
    contentfilter: "medium",
    media_filter: "tinywebp,tinygif,nanogif,mp4,tinymp4",
    country: "IN",
    locale: opts.locale ?? "en_IN",
  });
  if (opts.pos) params.set("pos", opts.pos);
  let endpoint = "featured";
  if (opts.q) {
    endpoint = "search";
    params.set("q", opts.q);
  }
  const res = await fetch(`https://tenor.googleapis.com/v2/${endpoint}?${params}`);
  if (!res.ok) throw new Error(`tenor ${res.status}`);
  const body = await res.json();
  const results: GifResult[] = [];
  for (const r of body?.results ?? []) {
    const f: Record<string, TenorFormat | undefined> = r?.media_formats ?? {};
    const preview = f.tinywebp ?? f.tinygif ?? f.nanogif;
    const send = [f.mp4, f.tinymp4].find((x) => x?.url && (x.size ?? 0) <= MAX_SEND_BYTES);
    if (!preview?.url || !send?.url) continue;
    const [w, h] = send.dims ?? preview.dims ?? [0, 0];
    results.push({
      id: String(r.id),
      title: String(r.content_description ?? r.title ?? "").slice(0, 140),
      width: num(w),
      height: num(h),
      preview: { url: preview.url, mimeType: mimeOf(preview.url) },
      send: { url: send.url, mimeType: "video/mp4", width: num(w), height: num(h), size: send.size },
    });
  }
  return { results, next: typeof body?.next === "string" && body.next ? body.next : null };
}

// ── GIPHY ─────────────────────────────────────────────────────────────────────

export async function giphy(
  key: string,
  opts: { q?: string; pos?: string; limit: number },
): Promise<GifPage> {
  const offset = Math.max(0, Math.min(4999, parseInt(opts.pos ?? "0", 10) || 0));
  const params = new URLSearchParams({
    api_key: key,
    limit: String(opts.limit),
    offset: String(offset),
    rating: "pg-13",
    bundle: "messaging_non_clips",
  });
  let endpoint = "trending";
  if (opts.q) {
    endpoint = "search";
    params.set("q", opts.q);
    params.set("lang", "en");
  }
  const res = await fetch(`https://api.giphy.com/v1/gifs/${endpoint}?${params}`);
  if (!res.ok) throw new Error(`giphy ${res.status}`);
  const body = await res.json();
  const results: GifResult[] = [];
  for (const r of body?.data ?? []) {
    const img = r?.images ?? {};
    const small = img.fixed_width_small ?? {};
    const fixed = img.fixed_width ?? {};
    const original = img.original ?? {};
    const previewUrl: string | undefined = small.webp || fixed.webp || small.url || fixed.url;
    const useOriginal = original.mp4 && num(original.mp4_size) > 0 && num(original.mp4_size) <= 3 * 1024 * 1024;
    const sendRef = useOriginal ? original : fixed;
    const sendUrl: string | undefined = sendRef.mp4;
    if (!previewUrl || !sendUrl) continue;
    results.push({
      id: String(r.id),
      title: String(r.title ?? "").slice(0, 140),
      width: num(sendRef.width),
      height: num(sendRef.height),
      preview: { url: previewUrl, mimeType: mimeOf(previewUrl) },
      send: {
        url: sendUrl,
        mimeType: "video/mp4",
        width: num(sendRef.width),
        height: num(sendRef.height),
        size: num(sendRef.mp4_size) || undefined,
      },
    });
  }
  const total = num(body?.pagination?.total_count);
  const count = num(body?.pagination?.count);
  const nextOffset = offset + count;
  return { results, next: count > 0 && nextOffset < Math.min(total, 5000) ? String(nextOffset) : null };
}

/** Only provider CDNs may be proxied. */
export function isAllowedMediaUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  return /^(media\d*\.tenor\.com|c\.tenor\.com|media\d*\.giphy\.com|i\.giphy\.com)$/.test(u.hostname);
}
