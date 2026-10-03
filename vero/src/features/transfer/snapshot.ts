/**
 * Transfer snapshot: the decrypted local database (or a recent slice of it)
 * that one of the user's devices hands to another. Pure helpers, unit-tested.
 *
 * Only an allow-list of tables moves. Never transferred: private keys,
 * ratchet/session state or anything else secret to the sending device - the
 * receiving device registers its own keys.
 */

import type { Sodium } from '../../core/crypto/primitives';

export type Cell = string | number | null;

export interface TableDump {
  columns: string[];
  rows: Cell[][];
}

export interface TransferSnapshot {
  v: 1;
  /** 'history' = recent messages per chat (new linked device); 'full' = move to a new phone */
  kind: 'history' | 'full';
  userId: string;
  createdAt: string;
  tables: Record<string, TableDump>;
  /** Device-local preferences (zustand persisted state); 'full' only. */
  settings?: Record<string, string | number | boolean | null>;
}

type ConflictMode = 'ignore' | 'replace' | 'replace-unavailable';

/**
 * Table -> how imported rows merge with rows already on the receiver.
 * messages: a placeholder saved before the import ("sent before this device
 * was linked") is replaced by the real message; anything else is kept.
 * device_keys: keep existing pins (first key seen wins).
 */
export const TRANSFER_TABLES: Record<string, { conflict: ConflictMode; key: string }> = {
  messages: { conflict: 'replace-unavailable', key: 'id' },
  conversations_cache: { conflict: 'ignore', key: 'id' },
  conversation_settings: { conflict: 'replace', key: 'conversation_id' },
  call_logs: { conflict: 'ignore', key: 'id' },
  device_keys: { conflict: 'ignore', key: 'device_id' },
  // Messaging extras (src/core/storage/messagingSchema.ts): stars and local edit history.
  message_stars: { conflict: 'ignore', key: 'message_id' },
  message_edits: { conflict: 'ignore', key: 'id' },
};

const IDENT_RE = /^[a-z_][a-z0-9_]{0,39}$/;
const MAX_ROWS = 500_000;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export function encodeSnapshot(sodium: Sodium, snapshot: TransferSnapshot): Uint8Array {
  return sodium.from_string(JSON.stringify(snapshot));
}

/** Parses and strictly validates a decrypted snapshot. */
export function decodeSnapshot(sodium: Sodium, bytes: Uint8Array, expectedUserId: string): TransferSnapshot {
  let parsed: any;
  try {
    parsed = JSON.parse(sodium.to_string(bytes));
  } catch {
    throw new SnapshotError('Transfer data is not valid');
  }
  if (!parsed || parsed.v !== 1 || (parsed.kind !== 'history' && parsed.kind !== 'full')) {
    throw new SnapshotError('Unsupported transfer format');
  }
  if (parsed.userId !== expectedUserId) throw new SnapshotError('Transfer belongs to a different account');
  if (typeof parsed.createdAt !== 'string' || typeof parsed.tables !== 'object' || parsed.tables === null) {
    throw new SnapshotError('Transfer data is not valid');
  }

  let rowCount = 0;
  const tables: Record<string, TableDump> = {};
  for (const [name, dump] of Object.entries(parsed.tables as Record<string, any>)) {
    if (!TRANSFER_TABLES[name]) continue; // unknown tables are ignored, never created
    if (!dump || !Array.isArray(dump.columns) || !Array.isArray(dump.rows)) throw new SnapshotError(`Bad table ${name}`);
    const columns = dump.columns as unknown[];
    if (!columns.every((c) => typeof c === 'string' && IDENT_RE.test(c)) || new Set(columns).size !== columns.length) {
      throw new SnapshotError(`Bad columns in ${name}`);
    }
    if (!columns.includes(TRANSFER_TABLES[name].key)) throw new SnapshotError(`Missing key column in ${name}`);
    for (const row of dump.rows as unknown[]) {
      if (!Array.isArray(row) || row.length !== columns.length) throw new SnapshotError(`Bad row in ${name}`);
      for (const cell of row) {
        if (!(cell === null || typeof cell === 'string' || (typeof cell === 'number' && Number.isFinite(cell)))) {
          throw new SnapshotError(`Bad value in ${name}`);
        }
      }
    }
    rowCount += dump.rows.length;
    if (rowCount > MAX_ROWS) throw new SnapshotError('Transfer is too large');
    tables[name] = { columns: columns as string[], rows: dump.rows as Cell[][] };
  }

  let settings: TransferSnapshot['settings'];
  if (parsed.kind === 'full' && parsed.settings && typeof parsed.settings === 'object') {
    settings = {};
    for (const [k, v] of Object.entries(parsed.settings as Record<string, unknown>)) {
      if (!IDENT_RE.test(k.toLowerCase())) continue;
      if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) {
        settings[k] = v as string | number | boolean | null;
      }
    }
  }

  return { v: 1, kind: parsed.kind, userId: parsed.userId, createdAt: parsed.createdAt, tables, settings };
}

/**
 * Builds the INSERT for one table, restricted to columns that exist locally
 * (the sender may run a newer/older schema). Returns null if nothing usable.
 */
export function buildImportStatement(
  table: string,
  dump: TableDump,
  localColumns: string[]
): { sql: string; columnIndexes: number[] } | null {
  const spec = TRANSFER_TABLES[table];
  if (!spec) return null;
  const local = new Set(localColumns);
  const columnIndexes = dump.columns.map((c, i) => (local.has(c) ? i : -1)).filter((i) => i >= 0);
  const cols = columnIndexes.map((i) => dump.columns[i]);
  if (!cols.includes(spec.key)) return null;

  const placeholders = cols.map(() => '?').join(', ');
  const colList = cols.map((c) => `"${c}"`).join(', ');
  let sql: string;
  if (spec.conflict === 'ignore') {
    sql = `INSERT OR IGNORE INTO "${table}" (${colList}) VALUES (${placeholders})`;
  } else if (spec.conflict === 'replace') {
    sql = `INSERT OR REPLACE INTO "${table}" (${colList}) VALUES (${placeholders})`;
  } else {
    const updates = cols.filter((c) => c !== spec.key).map((c) => `"${c}" = excluded."${c}"`);
    sql =
      `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ` +
      `ON CONFLICT("${spec.key}") DO UPDATE SET ${updates.join(', ')} ` +
      `WHERE "${table}"."message_type" = 'unavailable'`;
  }
  return { sql, columnIndexes };
}
