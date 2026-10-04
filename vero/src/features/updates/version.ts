// Pure helpers for update checks (unit-tested).

export interface UpdateManifest {
  version: string;
  notes?: string;
  releaseUrl?: string;
  android?: { url: string; sha256?: string; size?: number };
}

/** Compares dotted versions ("1.2.10" > "1.2.9"); a leading "v" and pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Validates a downloaded manifest; returns null if it isn't usable. Only https GitHub URLs are accepted for APKs. */
export function parseManifest(json: unknown): UpdateManifest | null {
  if (!json || typeof json !== 'object') return null;
  const m = json as Record<string, any>;
  if (typeof m.version !== 'string' || !/^v?\d+(\.\d+){0,3}([-+].*)?$/.test(m.version)) return null;
  const out: UpdateManifest = { version: m.version.replace(/^v/i, '') };
  if (typeof m.notes === 'string') out.notes = m.notes.slice(0, 2000);
  if (typeof m.releaseUrl === 'string' && /^https:\/\/github\.com\//.test(m.releaseUrl)) out.releaseUrl = m.releaseUrl;
  const a = m.android;
  if (a && typeof a.url === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^?#]+\.apk$/.test(a.url)) {
    out.android = { url: a.url };
    if (typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(a.sha256)) out.android.sha256 = a.sha256.toLowerCase();
    if (typeof a.size === 'number' && a.size > 0) out.android.size = a.size;
  }
  return out;
}

/** Android versionCode derived from a semver: 1.2.3 -> 10203 (must grow with every release). */
export function versionCode(version: string): number {
  const [maj = 0, min = 0, pat = 0] = version.replace(/^v/i, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  return maj * 10000 + min * 100 + pat;
}
