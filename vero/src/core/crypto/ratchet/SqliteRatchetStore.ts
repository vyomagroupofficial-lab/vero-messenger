/**
 * RatchetStore on the per-account SQLite database (expo-sqlite in the app).
 *
 * One table, every value sealed at rest (atRest.ts) with a storage key that
 * lives in the platform keystore. Atomicity without transactions: a batch is
 * ONE multi-row `INSERT OR REPLACE` statement (SQLite statements are atomic),
 * and deletions inside a batch are written as tombstones (v = '') that
 * purge() removes later. That matters because expo-sqlite's shared connection
 * can interleave other queries into a `withTransactionAsync` block.
 *
 * The table is created lazily here (not in DatabaseService's migrations), is
 * not part of device-to-device transfers (TRANSFER_TABLES is an allow-list),
 * and is crypto-shredded when the storage key is deleted from the keystore.
 */

import type { Sodium } from '../primitives';
import { openRow, sealRow } from './atRest';
import type { RatchetNamespace, RatchetStore, StoreWrite } from './store';

/** The subset of expo-sqlite's SQLiteDatabase this store needs. */
export interface MinimalSqlDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: (string | number | null)[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params: (string | number | null)[]): Promise<T[]>;
}

export const RATCHET_TABLE = 'vero_ratchet_kv';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${RATCHET_TABLE} (
    ns TEXT NOT NULL,
    k TEXT NOT NULL,
    v TEXT NOT NULL,
    ref TEXT,
    exp INTEGER,
    created INTEGER NOT NULL,
    PRIMARY KEY (ns, k)
  );
  CREATE INDEX IF NOT EXISTS idx_${RATCHET_TABLE}_exp ON ${RATCHET_TABLE}(exp) WHERE exp IS NOT NULL;
`;

/** Rows per statement: 6 bound params each, well under SQLite's 999 limit. */
const ROWS_PER_STATEMENT = 150;
/** Plaintext of messages that never made it into (or left) the messages table is dropped after this. */
const ORPHAN_PLAINTEXT_MS = 10 * 60 * 1000;

export class SqliteRatchetStore implements RatchetStore {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly sodium: Sodium,
    private readonly db: () => Promise<MinimalSqlDb>,
    private readonly storageKey: Uint8Array,
    private readonly now: () => number = Date.now
  ) {}

  private async conn(): Promise<MinimalSqlDb> {
    const db = await this.db();
    if (!this.ready) {
      this.ready = db.execAsync(SCHEMA);
      this.ready.catch(() => {
        this.ready = null;
      });
    }
    await this.ready;
    return db;
  }

  async get<T>(ns: RatchetNamespace, key: string): Promise<T | null> {
    const db = await this.conn();
    const row = await db.getFirstAsync<{ v: string; exp: number | null }>(
      `SELECT v, exp FROM ${RATCHET_TABLE} WHERE ns = ? AND k = ?`,
      [ns, key]
    );
    if (!row || row.v === '' || (row.exp != null && row.exp <= this.now())) return null;
    return openRow<T>(this.sodium, this.storageKey, ns, key, row.v);
  }

  async keys(ns: RatchetNamespace): Promise<string[]> {
    const db = await this.conn();
    const rows = await db.getAllAsync<{ k: string }>(
      `SELECT k FROM ${RATCHET_TABLE} WHERE ns = ? AND v <> '' AND (exp IS NULL OR exp > ?)`,
      [ns, this.now()]
    );
    return rows.map((r) => r.k);
  }

  async write(writes: StoreWrite[]): Promise<void> {
    if (writes.length === 0) return;
    const now = this.now();
    // Seal everything before touching the database.
    const rows = writes.map((w) => [
      w.ns,
      w.key,
      w.value === null ? '' : sealRow(this.sodium, this.storageKey, w.ns, w.key, w.value),
      w.ref ?? null,
      w.value === null ? null : w.expiresAt ?? null,
      now,
    ]);
    const db = await this.conn();
    // Batches larger than one statement only happen for prekey generation,
    // where partial application is harmless (private halves stored first).
    for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
      const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
      await db.runAsync(
        `INSERT OR REPLACE INTO ${RATCHET_TABLE} (ns, k, v, ref, exp, created) VALUES ${chunk
          .map(() => '(?, ?, ?, ?, ?, ?)')
          .join(', ')}`,
        chunk.flat()
      );
    }
  }

  async purge(now: number): Promise<void> {
    const db = await this.conn();
    await db.runAsync(`DELETE FROM ${RATCHET_TABLE} WHERE v = '' OR (exp IS NOT NULL AND exp <= ?)`, [now]);
    // Message plaintext follows the messages table: once a message is deleted,
    // has disappeared, or was never stored (reactions, control messages), its
    // cached plaintext goes too. Story plaintext just expires.
    const hasMessages = await db.getFirstAsync<{ n: number }>(
      `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'messages'`,
      []
    );
    if (hasMessages?.n) {
      await db.runAsync(
        `DELETE FROM ${RATCHET_TABLE}
          WHERE ns = 'pt' AND ref IS NOT NULL AND k NOT LIKE 'story:%' AND created <= ?
            AND NOT EXISTS (
              SELECT 1 FROM messages m
               WHERE m.id = ${RATCHET_TABLE}.ref
                 AND m.deleted_at IS NULL
                 AND (m.expires_at IS NULL OR m.expires_at > ?)
            )`,
        [now - ORPHAN_PLAINTEXT_MS, new Date(now).toISOString()]
      );
    }
  }

  async wipe(): Promise<void> {
    const db = await this.conn();
    await db.runAsync(`DELETE FROM ${RATCHET_TABLE}`, []);
  }
}
