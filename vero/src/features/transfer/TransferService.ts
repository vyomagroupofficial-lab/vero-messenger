/**
 * Device-to-device transfer of the local (decrypted) message database.
 *
 *   sender   : buildSnapshot -> encrypt (transferCrypto) -> upload chunks
 *              to device_transfer_chunks -> finish_transfer_upload
 *   receiver : poll request -> download chunks as they arrive (resumable)
 *              -> decrypt + verify -> import -> complete_transfer (server
 *              deletes the ciphertext)
 *
 * Private keys are never part of a snapshot (see TRANSFER_TABLES).
 */

import { supabase } from '../../core/network/supabase';
import { getSodium } from '../../core/crypto/sodium';
import { databaseService } from '../../core/storage/DatabaseService';
import { useSettingsStore } from '../settings/useSettingsStore';
import {
  EphemeralKeyPair,
  decryptPayload,
  deriveTransferKey,
  encryptPayload,
} from './transferCrypto';
import {
  Cell,
  TRANSFER_TABLES,
  TableDump,
  TransferSnapshot,
  buildImportStatement,
  decodeSnapshot,
  encodeSnapshot,
} from './snapshot';

export interface TransferProgress {
  phase: 'preparing' | 'uploading' | 'waiting' | 'downloading' | 'importing' | 'done';
  done: number;
  total: number | null;
}

export class TransferCancelledError extends Error {
  constructor() {
    super('Transfer cancelled');
    this.name = 'TransferCancelledError';
  }
}

export interface CancelToken {
  cancelled: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Messages per chat sent to a newly LINKED device (full transfers send everything). */
export const LINK_HISTORY_PER_CHAT = 200;

function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

async function localColumns(db: Parameters<Parameters<typeof databaseService.withConnection>[0]>[0], table: string) {
  const info = await db.getAllAsync<{ name: string }>(`PRAGMA table_info("${table}")`);
  return info.map((c) => c.name);
}

/** Exports the allow-listed local tables (and, for 'full', device preferences). */
export async function buildSnapshot(
  userId: string,
  kind: 'history' | 'full',
  perChatLimit = LINK_HISTORY_PER_CHAT
): Promise<TransferSnapshot> {
  const tables: Record<string, TableDump> = {};
  await databaseService.withConnection(async (db) => {
    const now = new Date().toISOString();
    for (const table of Object.keys(TRANSFER_TABLES)) {
      if (kind === 'history' && table === 'call_logs') continue;
      const columns = await localColumns(db, table);
      if (!columns.length) continue; // table not present in this schema version
      const colList = columns.map((c) => `"${c}"`).join(', ');
      let rows: Record<string, unknown>[];
      if (table === 'messages') {
        const live = `deleted_at IS NULL AND message_type <> 'unavailable' AND (expires_at IS NULL OR expires_at > ?)`;
        rows =
          kind === 'history'
            ? await db.getAllAsync<Record<string, unknown>>(
                `SELECT ${colList} FROM (
                   SELECT *, ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC) AS vero_rn
                   FROM messages WHERE ${live}
                 ) WHERE vero_rn <= ?`,
                [now, perChatLimit]
              )
            : await db.getAllAsync<Record<string, unknown>>(`SELECT ${colList} FROM messages WHERE ${live}`, [now]);
      } else {
        rows = await db.getAllAsync<Record<string, unknown>>(`SELECT ${colList} FROM "${table}"`);
      }
      tables[table] = { columns, rows: rows.map((r) => columns.map((c) => toCell(r[c]))) };
    }
  });

  let settings: TransferSnapshot['settings'];
  if (kind === 'full') {
    settings = {};
    for (const [k, v] of Object.entries(useSettingsStore.getState() as unknown as Record<string, unknown>)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) settings[k] = v as any;
    }
  }

  return { v: 1, kind, userId, createdAt: new Date().toISOString(), tables, settings };
}

/** Merges a received snapshot into this device's database. Returns the number of rows offered. */
export async function importSnapshot(snapshot: TransferSnapshot): Promise<number> {
  let count = 0;
  await databaseService.withConnection(async (db) => {
    await db.withTransactionAsync(async () => {
      for (const [table, dump] of Object.entries(snapshot.tables)) {
        const stmt = buildImportStatement(table, dump, await localColumns(db, table));
        if (!stmt) continue;
        const prepared = await db.prepareAsync(stmt.sql);
        try {
          for (const row of dump.rows) {
            await prepared.executeAsync(stmt.columnIndexes.map((i) => row[i]));
            count++;
          }
        } finally {
          await prepared.finalizeAsync();
        }
      }
    });
  });

  if (snapshot.kind === 'full' && snapshot.settings) {
    const current = useSettingsStore.getState() as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(snapshot.settings)) {
      // Only known preferences of the same type; never functions or new keys.
      if (k in current && typeof current[k] === typeof v && typeof current[k] !== 'function') patch[k] = v;
    }
    if (Object.keys(patch).length) useSettingsStore.getState().set(patch as any);
  }
  return count;
}

async function insertChunk(requestId: string, idx: number, ciphertext: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const { error } = await supabase.from('device_transfer_chunks').insert({ request_id: requestId, idx, ciphertext });
    if (!error || error.code === '23505') return; // 23505: already uploaded by an earlier attempt
    if (attempt >= 4 || error.code === '42501') throw error;
    await sleep(500 * 2 ** attempt);
  }
}

/** Encrypts and uploads a snapshot for a request this device has approved. */
export async function sendSnapshot(p: {
  requestId: string;
  receiverPublicKey: string;
  secret: string;
  senderKeyPair: EphemeralKeyPair;
  snapshot: TransferSnapshot;
  onProgress?: (p: TransferProgress) => void;
  cancel?: CancelToken;
}): Promise<void> {
  const sodium = await getSodium();
  const key = deriveTransferKey(sodium, {
    transferId: p.requestId,
    secret: p.secret,
    receiverPublicKey: p.receiverPublicKey,
    senderPublicKey: p.senderKeyPair.publicKey,
    mySecretKey: p.senderKeyPair.secretKey,
    theirPublicKey: p.receiverPublicKey,
  });
  let chunks: string[];
  try {
    chunks = encryptPayload(sodium, key, p.requestId, encodeSnapshot(sodium, p.snapshot));
  } finally {
    sodium.memzero(key);
  }

  for (let i = 0; i < chunks.length; i++) {
    if (p.cancel?.cancelled) throw new TransferCancelledError();
    p.onProgress?.({ phase: 'uploading', done: i, total: chunks.length });
    await insertChunk(p.requestId, i, chunks[i]);
  }
  const { error } = await supabase.rpc('finish_transfer_upload', { p_id: p.requestId, p_total_chunks: chunks.length });
  if (error) throw error;
  p.onProgress?.({ phase: 'done', done: chunks.length, total: chunks.length });
}

/**
 * Waits for, downloads, verifies and imports a transfer addressed to this
 * device. Chunks already downloaded are kept, so a network error only costs
 * the chunk in flight; call again with the same `received` map to resume.
 */
export async function receiveSnapshot(p: {
  requestId: string;
  secret: string;
  keyPair: EphemeralKeyPair;
  userId: string;
  onProgress?: (p: TransferProgress) => void;
  cancel?: CancelToken;
  received?: Map<number, string>;
  pollMs?: number;
}): Promise<{ rows: number; kind: TransferSnapshot['kind'] }> {
  const received = p.received ?? new Map<number, string>();
  let total: number | null = null;
  let senderPublicKey: string | null = null;

  for (;;) {
    if (p.cancel?.cancelled) throw new TransferCancelledError();
    const { data: req, error } = await supabase
      .from('device_link_requests')
      .select('status, sender_public_key, total_chunks, uploaded_at, data_expires_at')
      .eq('id', p.requestId)
      .maybeSingle();
    if (error) throw error;
    if (!req) throw new Error('This transfer has expired. Start again from the other device.');
    if (req.status === 'cancelled') throw new Error('The transfer was cancelled on the other device.');
    if (req.status === 'completed') throw new Error('This transfer was already completed.');
    if (new Date(req.data_expires_at).getTime() < Date.now()) throw new Error('This transfer has expired.');
    senderPublicKey = req.sender_public_key;
    total = req.uploaded_at ? req.total_chunks : null;

    // Fetch whatever is new, a few chunks per request.
    const next = received.size;
    if (senderPublicKey) {
      const { data: rows, error: chunkError } = await supabase
        .from('device_transfer_chunks')
        .select('idx, ciphertext')
        .eq('request_id', p.requestId)
        .gte('idx', next)
        .order('idx', { ascending: true })
        .limit(8);
      if (chunkError) throw chunkError;
      for (const r of rows ?? []) received.set(r.idx, r.ciphertext);
    }
    p.onProgress?.({ phase: senderPublicKey ? 'downloading' : 'waiting', done: received.size, total });

    if (total !== null && received.size >= total) break;
    if (received.size === next) await sleep(p.pollMs ?? 1500); // nothing new yet
  }

  p.onProgress?.({ phase: 'importing', done: received.size, total });
  const sodium = await getSodium();
  const key = deriveTransferKey(sodium, {
    transferId: p.requestId,
    secret: p.secret,
    receiverPublicKey: p.keyPair.publicKey,
    senderPublicKey: senderPublicKey!,
    mySecretKey: p.keyPair.secretKey,
    theirPublicKey: senderPublicKey!,
  });
  let snapshot: TransferSnapshot;
  try {
    const ordered = Array.from({ length: total! }, (_, i) => {
      const c = received.get(i);
      if (c === undefined) throw new Error('A part of the transfer is missing.');
      return c;
    });
    snapshot = decodeSnapshot(sodium, decryptPayload(sodium, key, p.requestId, ordered), p.userId);
  } finally {
    sodium.memzero(key);
  }

  const rows = await importSnapshot(snapshot);
  await supabase.rpc('complete_transfer', { p_id: p.requestId });
  p.onProgress?.({ phase: 'done', done: total!, total });
  return { rows, kind: snapshot.kind };
}

export async function cancelTransfer(requestId: string): Promise<void> {
  await supabase.rpc('cancel_transfer', { p_id: requestId });
}
