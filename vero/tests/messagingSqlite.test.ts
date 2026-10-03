/**
 * Runs the local messaging schema (FTS5 index + triggers) and the search SQL
 * against a real SQLite (node:sqlite) through a tiny expo-sqlite-shaped adapter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { ensureMessagingSchema, isFtsAvailable } from '../src/core/storage/messagingSchema';
import { buildSearchSql } from '../src/core/storage/messagingSql';

// node:sqlite exists from Node 22.5; skip (don't fail) on older runtimes.
const sqlite = (() => {
  try {
    return (process as any).getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined;
  } catch {
    return undefined;
  }
})();
const skip = sqlite ? false : 'node:sqlite is not available in this Node.js version';

class Adapter {
  constructor(readonly db: DatabaseSyncType) {}
  async execAsync(sql: string) {
    this.db.exec(sql);
  }
  async getAllAsync<T>(sql: string, params: any[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }
  async getFirstAsync<T>(sql: string, params: any[] = []): Promise<T | null> {
    return (this.db.prepare(sql).get(...params) as T) ?? null;
  }
  async runAsync(sql: string, params: any[] = []) {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
  }
  async withTransactionAsync(fn: () => Promise<void>) {
    this.db.exec('BEGIN');
    try {
      await fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

// Same columns as DatabaseService MIGRATIONS[1].
const BASE = `
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_device_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL, sender_name TEXT, content TEXT, message_type TEXT NOT NULL,
    media_json TEXT, reply_to_id TEXT, reply_preview TEXT, reactions_json TEXT, status TEXT NOT NULL,
    is_own INTEGER NOT NULL DEFAULT 0, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    expires_at TEXT, deleted_at TEXT
  );`;

async function setup() {
  const db = new Adapter(new sqlite!.DatabaseSync(':memory:'));
  await db.execAsync(BASE);
  return db;
}

async function insert(db: Adapter, id: string, content: string | null, over: Record<string, any> = {}) {
  const row = {
    id,
    conversation_id: 'c1',
    sender_device_id: 'd',
    sender_user_id: 'u',
    content,
    message_type: 'text',
    status: 'delivered',
    created_at: `2026-05-01T12:00:0${id.slice(-1)}Z`,
    ...over,
  };
  const cols = Object.keys(row);
  await db.runAsync(
    `INSERT INTO messages (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    cols.map((c) => (row as any)[c])
  );
}

async function search(db: Adapter, q: string, opts: { conversationId?: string; fts?: boolean } = {}) {
  const stmt = buildSearchSql(q, {
    conversationId: opts.conversationId,
    limit: 50,
    nowIso: '2026-05-02T00:00:00Z',
    fts: opts.fts ?? true,
  });
  if (!stmt) return null;
  return (await db.getAllAsync<{ id: string }>(stmt.sql, stmt.params)).map((r) => r.id);
}

test('schema is idempotent and indexes messages stored before it existed', { skip }, async () => {
  const db = await setup();
  await insert(db, 'm1', 'Meet at the café tomorrow');
  await ensureMessagingSchema(db as any);
  assert.equal(isFtsAvailable(), true);
  await ensureMessagingSchema(db as any); // second open
  const cols = (await db.getAllAsync<{ name: string }>('PRAGMA table_info(messages)')).map((c) => c.name);
  for (const c of ['edited_at', 'revoked_at', 'forward_count']) assert.ok(cols.includes(c), c);
  assert.deepEqual(await search(db, 'cafe'), ['m1'], 'diacritics-insensitive, backfilled');
  assert.deepEqual(await search(db, 'tomo'), ['m1'], 'prefix match');
});

test('FTS index follows inserts, edits, deletions for everyone and local deletes', { skip }, async () => {
  const db = await setup();
  await ensureMessagingSchema(db as any);
  await insert(db, 'm2', 'Hello world');
  await insert(db, 'm3', 'hello there', { conversation_id: 'c2' });
  await insert(db, 'm4', 'hello hidden', { deleted_at: '2026-05-01T13:00:00Z' });
  await insert(db, 'm5', 'hello expired', { expires_at: '2026-05-01T13:00:00Z' });
  await insert(db, 'm6', 'unreadable hello', { message_type: 'unavailable' });

  assert.deepEqual(await search(db, 'hel'), ['m3', 'm2'], 'newest first, hidden/expired/unavailable excluded');
  assert.deepEqual(await search(db, 'hello', { conversationId: 'c1' }), ['m2']);
  assert.deepEqual(await search(db, 'hello world'), ['m2'], 'all terms must match');

  // edit
  await db.runAsync('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', ['Goodbye world', 'x', 'm2']);
  assert.deepEqual(await search(db, 'hello', { conversationId: 'c1' }), []);
  assert.deepEqual(await search(db, 'goodbye'), ['m2']);

  // delete for everyone (tombstone keeps the row, drops the text)
  await db.runAsync('UPDATE messages SET content = NULL, revoked_at = ? WHERE id = ?', ['2026-05-01T14:00:00Z', 'm3']);
  assert.deepEqual(await search(db, 'there'), []);

  // local hard delete
  await db.runAsync('DELETE FROM messages WHERE id = ?', ['m2']);
  assert.deepEqual(await search(db, 'goodbye'), []);

  await db.execAsync("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')");
});

test('hostile queries are plain text for FTS5 and LIKE', { skip }, async () => {
  const db = await setup();
  await ensureMessagingSchema(db as any);
  await insert(db, 'm1', 'price is 100% off_today');
  await insert(db, 'm2', 'price is 1000 offXtoday');
  for (const q of [
    '"',
    'content:*',
    'NEAR(a b',
    'a OR',
    '***',
    '-x',
    '^hello',
    'AND AND',
    "'; DROP TABLE messages; --",
    '{content} : x',
  ]) {
    for (const fts of [true, false]) {
      await assert.doesNotReject(search(db, q, { fts }), `${q} (fts=${fts})`);
    }
  }
  assert.equal((await db.getAllAsync('SELECT id FROM messages')).length, 2);

  // Wildcards never reach LIKE as wildcards: '%' / '_' split terms instead of matching anything.
  assert.deepEqual(await search(db, '%%', { fts: false }), null);
  assert.deepEqual(await search(db, '_x_', { fts: false }), ['m2'], 'only the literal x matches');
  assert.deepEqual(await search(db, '1000%', { fts: false }), ['m2']);
  assert.deepEqual(await search(db, '1000%', { fts: true }), ['m2']);
  assert.deepEqual(await search(db, 'PRICE', { fts: false }), ['m2', 'm1'], 'case-insensitive');
});
