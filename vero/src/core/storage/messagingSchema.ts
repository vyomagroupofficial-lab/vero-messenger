/**
 * Local schema for messaging features (edits, deletions, forwards, stars,
 * search, sync watermarks).
 *
 * Applied idempotently on every open, after DatabaseService's numbered
 * migrations, so it doesn't compete for PRAGMA user_version with other
 * features. Everything here is CREATE ... IF NOT EXISTS or guarded by a
 * column check.
 *
 * Search uses an external-content FTS5 index over messages.content kept in
 * sync by triggers (insert/update/delete). Where FTS5 isn't compiled in
 * (some web builds), search falls back to LIKE.
 */

import type * as SQLite from 'expo-sqlite';

const MESSAGE_COLUMNS: [name: string, ddl: string][] = [
  ['edited_at', 'edited_at TEXT'],
  ['revoked_at', 'revoked_at TEXT'],
  ['forward_count', 'forward_count INTEGER NOT NULL DEFAULT 0'],
];

const TABLES = `
  CREATE TABLE IF NOT EXISTS message_edits (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    previous_text TEXT,
    new_text TEXT NOT NULL,
    edited_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_message_edits_target ON message_edits(target_id);

  CREATE TABLE IF NOT EXISTS message_stars (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    starred INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_message_stars_conv ON message_stars(conversation_id) WHERE starred = 1;

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(conversation_id, is_read) WHERE is_read = 0;
`;

const FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
`;

/** Messages joined with this account's star state. Alias `m` = messages, `s` = message_stars. */
export const MESSAGE_SELECT = `SELECT m.*, s.starred AS starred FROM messages m
  LEFT JOIN message_stars s ON s.message_id = m.id AND s.starred = 1`;

let ftsAvailable = false;

/** True once the FTS5 index exists for the open database. */
export function isFtsAvailable(): boolean {
  return ftsAvailable;
}

export async function ensureMessagingSchema(db: SQLite.SQLiteDatabase): Promise<void> {
  const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(messages)');
  const have = new Set(cols.map((c) => c.name));
  for (const [name, ddl] of MESSAGE_COLUMNS) {
    if (!have.has(name)) await db.execAsync(`ALTER TABLE messages ADD COLUMN ${ddl}`);
  }
  await db.execAsync(TABLES);

  ftsAvailable = false;
  try {
    const existed = await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'"
    );
    await db.withTransactionAsync(async () => {
      await db.execAsync(FTS);
      // Index what was stored before the index existed.
      if (!existed?.n) await db.execAsync("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
    });
    ftsAvailable = true;
  } catch (e) {
    console.warn('[messagingSchema] FTS5 unavailable, search falls back to LIKE:', (e as Error)?.message);
  }
}
