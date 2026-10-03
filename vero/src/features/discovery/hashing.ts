/**
 * Private contact discovery: hashing, k-anonymous prefix queries and local
 * matching. Pure functions (unit-tested in tests/discovery.test.ts).
 *
 * Protocol
 *   1. Normalise every phone/email in the address book (normalize.ts).
 *   2. h = SHA-256("vero-discovery-v1|<kind>|<normalised>")   (same as the server)
 *   3. Send only the first PREFIX_LENGTH hex chars of each h. With 4 hex chars
 *      there are 65,536 buckets, so each prefix is shared by a huge number of
 *      possible phone numbers/emails: the server can't tell which one we hold.
 *   4. The server returns every discoverable (hash, user) in those buckets.
 *   5. We keep only rows whose FULL hash is in our address book.
 */

import { sha256Hex } from './sha256';
import { CountryCode, DEFAULT_COUNTRY, normalizeEmail, normalizePhone } from './normalize';

export const DISCOVERY_HASH_VERSION = 'vero-discovery-v1';
export const PREFIX_LENGTH = 4;
/** Must not exceed the server's per-request cap (discovery_lookup in 009). */
export const MAX_PREFIXES_PER_REQUEST = 2000;

export type IdentifierKind = 'email' | 'phone';

export function identifierHash(kind: IdentifierKind, normalized: string): string {
  return sha256Hex(`${DISCOVERY_HASH_VERSION}|${kind}|${normalized}`);
}

export function hashPrefix(hash: string, length = PREFIX_LENGTH): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Not a SHA-256 hex digest');
  if (length < 3 || length > 5) throw new Error('Prefix length must be 3-5 hex characters');
  return hash.slice(0, length);
}

export interface AddressBookContact {
  id: string;
  name: string;
  phones: string[];
  emails: string[];
}

export interface PlannedIdentifier {
  kind: IdentifierKind;
  normalized: string;
  contactId: string;
  contactName: string;
}

export interface LookupPlan {
  /** full hash -> address-book entries that produced it (kept on device) */
  byHash: Map<string, PlannedIdentifier[]>;
  /** sorted, de-duplicated prefixes: the ONLY thing sent to the server */
  prefixes: string[];
}

export function buildLookupPlan(
  contacts: AddressBookContact[],
  opts: { defaultCountry?: CountryCode; prefixLength?: number; exclude?: { emails?: string[]; phones?: string[] } } = {}
): LookupPlan {
  const country = opts.defaultCountry ?? DEFAULT_COUNTRY;
  const prefixLength = opts.prefixLength ?? PREFIX_LENGTH;
  const excluded = new Set<string>([
    ...(opts.exclude?.emails ?? []).map((e) => normalizeEmail(e)).filter((e): e is string => !!e),
    ...(opts.exclude?.phones ?? []).map((p) => normalizePhone(p, country)).filter((p): p is string => !!p),
  ]);

  const byHash = new Map<string, PlannedIdentifier[]>();
  const add = (kind: IdentifierKind, normalized: string | null, c: AddressBookContact) => {
    if (!normalized || excluded.has(normalized)) return;
    const hash = identifierHash(kind, normalized);
    const list = byHash.get(hash) ?? [];
    if (!list.some((p) => p.contactId === c.id)) list.push({ kind, normalized, contactId: c.id, contactName: c.name });
    byHash.set(hash, list);
  };

  for (const c of contacts) {
    for (const p of c.phones) add('phone', normalizePhone(p, country), c);
    for (const e of c.emails) add('email', normalizeEmail(e), c);
  }

  const prefixes = [...new Set([...byHash.keys()].map((h) => hashPrefix(h, prefixLength)))].sort();
  return { byHash, prefixes };
}

export function batchPrefixes(prefixes: string[], size = MAX_PREFIXES_PER_REQUEST): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < prefixes.length; i += size) out.push(prefixes.slice(i, i + size));
  return out;
}

export interface LookupRow {
  identifier_hash: string;
  user_id: string;
  username: string;
  display_name: string;
}

export interface DiscoveredFriend {
  userId: string;
  username: string;
  displayName: string;
  /** Names of the address-book entries that matched (shown as "In your contacts as ...") */
  contactNames: string[];
  matchedBy: IdentifierKind[];
}

/**
 * Keeps only server rows whose full hash we actually hold. Rows for other
 * hashes in the same bucket (other people's contacts) are discarded.
 */
export function matchLookupResults(plan: LookupPlan, rows: LookupRow[]): DiscoveredFriend[] {
  const friends = new Map<string, DiscoveredFriend>();
  for (const row of rows) {
    const hash = typeof row.identifier_hash === 'string' ? row.identifier_hash.toLowerCase() : '';
    const planned = plan.byHash.get(hash);
    if (!planned) continue;
    const f =
      friends.get(row.user_id) ??
      ({ userId: row.user_id, username: row.username, displayName: row.display_name, contactNames: [], matchedBy: [] } as DiscoveredFriend);
    for (const p of planned) {
      if (!f.contactNames.includes(p.contactName)) f.contactNames.push(p.contactName);
      if (!f.matchedBy.includes(p.kind)) f.matchedBy.push(p.kind);
    }
    friends.set(row.user_id, f);
  }
  return [...friends.values()].sort((a, b) =>
    (a.contactNames[0] ?? a.displayName).localeCompare(b.contactNames[0] ?? b.displayName)
  );
}
