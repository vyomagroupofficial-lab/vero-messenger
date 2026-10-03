/**
 * Storage interface of the session layer, plus an in-memory implementation
 * (unit tests, and the bot SDK, which persists the snapshot in its state file).
 *
 * Namespaces:
 *   session  remote deviceId -> SessionRecord
 *   spk      signed prekey id -> SignedPreKeyRecord (private!)
 *   opk      one-time prekey id -> OneTimePreKeyRecord (private!)
 *   meta     small bookkeeping values
 *   pt       decrypted-plaintext cache ("<conversation>|<message>|<senderDevice>" -> text)
 *
 * `write` MUST be atomic: a decrypt commits the advanced session, the
 * consumed one-time prekey and the plaintext together, or not at all.
 */

export type RatchetNamespace = 'session' | 'spk' | 'opk' | 'meta' | 'pt';

export interface StoreWrite {
  ns: RatchetNamespace;
  key: string;
  /** JSON-serialisable value; null deletes the entry. */
  value: unknown | null;
  /** Optional reference (pt: the message id) used by store-specific purges. */
  ref?: string | null;
  /** Absolute expiry (ms since epoch); expired entries read as missing. */
  expiresAt?: number | null;
}

export interface RatchetStore {
  get<T>(ns: RatchetNamespace, key: string): Promise<T | null>;
  /** Keys of the live entries in a namespace (values are not decrypted). */
  keys(ns: RatchetNamespace): Promise<string[]>;
  /** Atomic batch. */
  write(writes: StoreWrite[]): Promise<void>;
  /** Drops expired entries (and store-specific stale data). */
  purge(now: number): Promise<void>;
  /** Erases everything. */
  wipe(): Promise<void>;
}

export interface MemoryEntry {
  v: unknown;
  ref?: string | null;
  exp?: number | null;
}

export type MemorySnapshot = Record<string, MemoryEntry>;

const entryId = (ns: string, key: string) => `${ns}:${key}`;

/** Deep copy through JSON: exactly what a persistent store round-trips. */
function jsonCopy<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * Map-backed store. `onChange` is awaited after every mutation with the full
 * snapshot (the bot SDK writes it to its state file atomically).
 */
export class MemoryRatchetStore implements RatchetStore {
  private data: Map<string, MemoryEntry>;

  constructor(
    initial: MemorySnapshot = {},
    private readonly onChange?: (snapshot: MemorySnapshot) => void | Promise<void>,
    private readonly now: () => number = Date.now
  ) {
    this.data = new Map(Object.entries(jsonCopy(initial ?? {})));
  }

  async get<T>(ns: RatchetNamespace, key: string): Promise<T | null> {
    const e = this.data.get(entryId(ns, key));
    if (!e || (e.exp != null && e.exp <= this.now())) return null;
    return jsonCopy(e.v) as T;
  }

  async keys(ns: RatchetNamespace): Promise<string[]> {
    const prefix = `${ns}:`;
    const now = this.now();
    const out: string[] = [];
    for (const [k, e] of this.data) {
      if (k.startsWith(prefix) && (e.exp == null || e.exp > now)) out.push(k.slice(prefix.length));
    }
    return out;
  }

  async write(writes: StoreWrite[]): Promise<void> {
    // Validate/serialise everything first so a bad value can't half-apply.
    const prepared = writes.map((w) => ({
      id: entryId(w.ns, w.key),
      entry: w.value === null ? null : { v: jsonCopy(w.value), ref: w.ref ?? null, exp: w.expiresAt ?? null },
    }));
    for (const p of prepared) {
      if (p.entry === null) this.data.delete(p.id);
      else this.data.set(p.id, p.entry);
    }
    await this.onChange?.(this.snapshot());
  }

  async purge(now: number): Promise<void> {
    let changed = false;
    for (const [k, e] of this.data) {
      if (e.exp != null && e.exp <= now) {
        this.data.delete(k);
        changed = true;
      }
    }
    if (changed) await this.onChange?.(this.snapshot());
  }

  async wipe(): Promise<void> {
    this.data.clear();
    await this.onChange?.(this.snapshot());
  }

  snapshot(): MemorySnapshot {
    return jsonCopy(Object.fromEntries(this.data));
  }
}
