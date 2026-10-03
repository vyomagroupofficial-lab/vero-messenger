// Ciphertext blob storage. Only ENCRYPTED bytes ever reach these backends.
//
//   drive    - Google Drive via a service account (requires a Shared Drive
//              folder, because service accounts have no storage quota).
//   supabase - a private Supabase Storage bucket (default; zero setup).
//
// Object ids are prefixed with the backend ("drive:<fileId>", "sb:<path>").

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = Deno.env.get("VERO_MEDIA_BUCKET") ?? "vero-media";

function backend(): "drive" | "supabase" {
  const configured = Deno.env.get("VERO_MEDIA_BACKEND");
  if (configured === "drive" || configured === "supabase") return configured;
  return Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ? "drive" : "supabase";
}

export async function putBlob(admin: SupabaseClient, bytes: Uint8Array): Promise<string> {
  if (backend() === "drive") return `drive:${await drive.upload(bytes)}`;
  const path = `${crypto.randomUUID()}.bin`;
  const { error } = await admin.storage.from(BUCKET).upload(path, bytes, {
    contentType: "application/octet-stream",
    upsert: false,
  });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  return `sb:${path}`;
}

export async function getBlob(admin: SupabaseClient, objectId: string): Promise<ReadableStream<Uint8Array> | Blob> {
  if (objectId.startsWith("drive:")) return drive.download(objectId.slice(6));
  if (objectId.startsWith("sb:")) {
    const { data, error } = await admin.storage.from(BUCKET).download(objectId.slice(3));
    if (error || !data) throw new Error("storage download failed");
    return data;
  }
  throw new Error("unknown object id");
}

export async function deleteBlob(admin: SupabaseClient, objectId: string): Promise<void> {
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
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/drive.file",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  )}`;
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
  async upload(bytes: Uint8Array): Promise<string> {
    const folderId = Deno.env.get("GOOGLE_DRIVE_FOLDER_ID");
    if (!folderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID is not set");
    const boundary = `vero-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({
      name: `${crypto.randomUUID()}.bin`,
      parents: [folderId],
      mimeType: "application/octet-stream",
    });
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);

    const res = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) throw new Error(`drive upload failed (${res.status})`);
    return (await res.json()).id as string;
  },

  async download(fileId: string): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(`${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
    });
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
