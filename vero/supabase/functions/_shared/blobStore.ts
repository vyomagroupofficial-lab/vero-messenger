// Ciphertext blob storage. Only ENCRYPTED bytes ever reach these backends,
// and they never pass through an Edge Function body on the way up:
//
//   1. media-upload (create)  -> a one-off upload URL for exactly one object
//   2. the app PUTs the ciphertext straight to Storage / Drive
//   3. media-upload (confirm) -> streams the stored object, checks size + hash
//
//   supabase - private bucket `vero-media`, object `<conversation_id>/<media_id>`
//              (default; signed upload URLs, signed download URLs).
//   drive    - Google Drive via a service account (requires a Shared Drive
//              folder, because service accounts have no storage quota).
//              Uploads use a resumable-upload session URL; downloads are
//              proxied by media-download because Drive has no signed URLs.
//
// Object ids are prefixed with the backend ("sb:<path>", "drive:<fileId>").

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { crypto as stdCrypto } from "jsr:@std/crypto@1";
import { encodeHex } from "jsr:@std/encoding@1/hex";
import { env } from "./http.ts";

export const BUCKET = Deno.env.get("VERO_MEDIA_BUCKET") ?? "vero-media";

export type Backend = "drive" | "supabase";

export function backend(): Backend {
  const configured = Deno.env.get("VERO_MEDIA_BACKEND");
  if (configured === "drive" || configured === "supabase") return configured;
  return Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ? "drive" : "supabase";
}

export interface UploadTarget {
  objectId: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

/** A URL the client can PUT the ciphertext to, valid for one object only. */
export async function createUploadTarget(
  admin: SupabaseClient,
  conversationId: string,
  mediaId: string,
  size: number,
): Promise<UploadTarget> {
  if (backend() === "drive") {
    return {
      objectId: "drive:pending",
      url: await drive.createUploadSession(mediaId, size),
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
    };
  }
  const path = `${conversationId}/${mediaId}`;
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(`signed upload url failed: ${error?.message ?? "no data"}`);
  return {
    objectId: `sb:${path}`,
    url: data.signedUrl,
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "x-upsert": "false" },
  };
}

/**
 * Finds the object the client uploaded. For Drive the file id is only known
 * after the upload, so we look it up by the media id we stamped on it.
 */
export async function resolveUploadedObject(objectId: string, mediaId: string): Promise<string | null> {
  if (objectId === "drive:pending") {
    const fileId = await drive.findByMediaId(mediaId);
    return fileId ? `drive:${fileId}` : null;
  }
  return objectId;
}

/** Short-lived direct download URL, or null when the backend needs the proxy. */
export async function createDownloadUrl(
  admin: SupabaseClient,
  objectId: string,
  expiresInSeconds: number,
): Promise<string | null> {
  if (!objectId.startsWith("sb:")) return null;
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(objectId.slice(3), expiresInSeconds);
  if (error || !data?.signedUrl) throw new Error("signed download url failed");
  return data.signedUrl;
}

/** Streams the stored ciphertext (never buffers the whole object). */
export async function openBlob(objectId: string): Promise<ReadableStream<Uint8Array>> {
  if (objectId.startsWith("drive:")) return drive.download(objectId.slice(6));
  if (objectId.startsWith("sb:")) {
    const path = objectId.slice(3).split("/").map(encodeURIComponent).join("/");
    const key = env("SUPABASE_SERVICE_ROLE_KEY");
    const res = await fetch(`${env("SUPABASE_URL")}/storage/v1/object/authenticated/${BUCKET}/${path}`, {
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    });
    if (res.status === 400 || res.status === 404) throw new BlobNotFoundError();
    if (!res.ok || !res.body) throw new Error(`storage download failed (${res.status})`);
    return res.body;
  }
  throw new Error("unknown object id");
}

export class BlobNotFoundError extends Error {
  constructor() {
    super("object not found");
  }
}

export class BlobTooLargeError extends Error {
  constructor() {
    super("object larger than declared");
  }
}

/**
 * Streams the object and returns its size and BLAKE2b-256 (hex), the same hash
 * the client computes with libsodium's crypto_generichash(32). Aborts as soon
 * as more than `maxBytes` arrive.
 */
export async function measureBlob(objectId: string, maxBytes: number): Promise<{ size: number; hash: string }> {
  const stream = await openBlob(objectId);
  let size = 0;
  async function* counted(): AsyncGenerator<Uint8Array<ArrayBuffer>> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        size += value.length;
        if (size > maxBytes) throw new BlobTooLargeError();
        yield value as Uint8Array<ArrayBuffer>;
      }
    } finally {
      reader.releaseLock();
      stream.cancel().catch(() => undefined);
    }
  }
  const digest = await stdCrypto.subtle.digest("BLAKE2B-256", counted());
  return { size, hash: encodeHex(new Uint8Array(digest)) };
}

export async function deleteBlob(admin: SupabaseClient, objectId: string): Promise<void> {
  if (objectId === "drive:pending") return;
  if (objectId.startsWith("drive:")) return drive.remove(objectId.slice(6));
  if (objectId.startsWith("sb:")) {
    const { error } = await admin.storage.from(BUCKET).remove([objectId.slice(3)]);
    if (error) throw new Error("storage delete failed");
  }
}

// ── Google Drive (service account, RS256 JWT bearer flow) ────────────────────

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

let cachedToken: { value: string; expiresAt: number } | null = null;

function b64url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const sa = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ?? "{}");
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is invalid");

  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${
    b64url(
      JSON.stringify({
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/drive.file",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    )
  }`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(signature)}`,
    }),
  });
  if (!res.ok) throw new Error(`google token exchange failed (${res.status})`);
  const body = await res.json();
  cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

const drive = {
  /**
   * Starts a resumable upload and returns its session URI. The URI itself
   * authorises the upload of this one file, so the client needs no Google
   * credentials. Requests from a browser must come from the same origin that
   * started the session, so on web the Drive backend is not supported.
   */
  async createUploadSession(mediaId: string, size: number): Promise<string> {
    const folderId = Deno.env.get("GOOGLE_DRIVE_FOLDER_ID");
    if (!folderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID is not set");
    const res = await fetch(`${DRIVE_UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/octet-stream",
        "X-Upload-Content-Length": String(size),
      },
      body: JSON.stringify({
        name: `${mediaId}.bin`,
        parents: [folderId],
        mimeType: "application/octet-stream",
        appProperties: { veroMediaId: mediaId },
      }),
    });
    const location = res.headers.get("Location");
    if (!res.ok || !location) throw new Error(`drive upload session failed (${res.status})`);
    return location;
  },

  async findByMediaId(mediaId: string): Promise<string | null> {
    const folderId = Deno.env.get("GOOGLE_DRIVE_FOLDER_ID") ?? "";
    const q = `appProperties has { key='veroMediaId' and value='${mediaId}' } and '${folderId}' in parents and trashed = false`;
    const res = await fetch(
      `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      { headers: { Authorization: `Bearer ${await accessToken()}` } },
    );
    if (!res.ok) throw new Error(`drive lookup failed (${res.status})`);
    const body = await res.json();
    return body.files?.[0]?.id ?? null;
  },

  async download(fileId: string): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(`${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
    });
    if (res.status === 404) throw new BlobNotFoundError();
    if (!res.ok || !res.body) throw new Error(`drive download failed (${res.status})`);
    return res.body;
  },

  async remove(fileId: string): Promise<void> {
    const res = await fetch(`${DRIVE_API}/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await accessToken()}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`drive delete failed (${res.status})`);
  },
};
