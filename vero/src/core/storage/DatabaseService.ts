/**
 * Vero local SQLite store.
 *
 * Holds the DECRYPTED view of this account's data on this device only:
 * messages, a conversation cache for offline start-up, pinned device keys,
 * verified safety numbers, per-chat settings and call history.
 *
 * One database file per account, so a second account on the same phone never
 * sees the first account's plaintext.
 */

import * as SQLite from 'expo-sqlite';
import { Conversation, MediaAttachment, Message, MessageReaction } from '../../shared/models/Message';

export interface LocalCallRecord {
  id: string;
  peerId: string;
  peerName: string;
  callType: 'voice' | 'video';
  direction: 'incoming' | 'outgoing' | 'missed';
  duration: number; // seconds
  createdAt: string;
}

export interface PinnedDeviceKey {
  deviceId: string;
  userId: string;
  publicKey: string;
  revokedAt?: string | null;
}

const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_device_id TEXT NOT NULL,
      sender_user_id TEXT NOT NULL,
      sender_name TEXT,
      content TEXT,
      message_type TEXT NOT NULL,
      media_json TEXT,
      reply_to_id TEXT,
      reply_preview TEXT,
      reactions_json TEXT,
      status TEXT NOT NULL,
      is_own INTEGER NOT NULL DEFAULT 0,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS conversations_cache (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_keys (
      device_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS safety_numbers (
      user_id TEXT PRIMARY KEY,
      verified_number TEXT NOT NULL,
      verified_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_settings (
      conversation_id TEXT PRIMARY KEY,
      timer_seconds INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS call_logs (
      id TEXT PRIMARY KEY,
      peer_id TEXT NOT NULL,
      peer_name TEXT NOT NULL,
      call_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      duration INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_call_logs_created ON call_logs(created_at DESC);
  `,
};

function rowToMessage(r: any): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderDeviceId: r.sender_device_id,
    senderUserId: r.sender_user_id,
    senderName: r.sender_name ?? undefined,
    content: r.content ?? undefined,
    messageType: r.message_type,
    media: r.media_json ? (JSON.parse(r.media_json) as MediaAttachment) : undefined,
    replyToMessageId: r.reply_to_id,
    replyPreview: r.reply_preview,
    reactions: r.reactions_json ? (JSON.parse(r.reactions_json) as MessageReaction[]) : [],
    status: r.status,
    isOwn: r.is_own === 1,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    deletedAt: r.deleted_at,
  };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

class DatabaseService {
  private userId: string | null = null;
  private dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

  /** Must be called after sign-in, before any other method. */
  open(userId: string): void {
    if (this.userId === userId && this.dbPromise) return;
    void this.close();
    this.userId = userId;
    const name = `vero_${userId.replace(/[^a-zA-Z0-9-]/g, '')}.db`;
    this.dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(name);
      await db.execAsync('PRAGMA journal_mode = WAL;');
      const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      let version = row?.user_version ?? 0;
      while (version < SCHEMA_VERSION) {
        version += 1;
        await db.withTransactionAsync(async () => {
          await db.execAsync(MIGRATIONS[version]);
          await db.execAsync(`PRAGMA user_version = ${version}`);
        });
      }
      return db;
    })();
    this.dbPromise.catch(() => {
      this.dbPromise = null;
    });
  }

  async close(): Promise<void> {
    const p = this.dbPromise;
    this.dbPromise = null;
    this.userId = null;
    if (p) {
      try {
        await (await p).closeAsync();
      } catch {
        // already closed
      }
    }
  }

  get isOpen(): boolean {
    return this.dbPromise !== null;
  }

  private db(): Promise<SQLite.SQLiteDatabase> {
    if (!this.dbPromise) return Promise.reject(new Error('[DatabaseService] not opened'));
    return this.dbPromise;
  }

  /** Runs `fn` and swallows storage errors: the local cache must never break messaging. */
  private async safe<T>(label: string, fallback: T, fn: (db: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.db());
    } catch (e) {
      console.warn(`[DatabaseService] ${label} failed:`, e);
      return fallback;
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  saveMessage(m: Message): Promise<void> {
    return this.safe('saveMessage', undefined, async (db) => {
      // Never persist the sender's original file path for other devices; keep key material local only.
      await db.runAsync(
        `INSERT INTO messages (id, conversation_id, sender_device_id, sender_user_id, sender_name, content,
           message_type, media_json, reply_to_id, reply_preview, reactions_json, status, is_own, is_read,
           created_at, expires_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sender_name = excluded.sender_name,
           content = COALESCE(excluded.content, messages.content),
           message_type = excluded.message_type,
           media_json = COALESCE(excluded.media_json, messages.media_json),
           reply_preview = COALESCE(excluded.reply_preview, messages.reply_preview),
           status = excluded.status,
           expires_at = excluded.expires_at,
           deleted_at = COALESCE(messages.deleted_at, excluded.deleted_at)`,
        [
          m.id,
          m.conversationId,
          m.senderDeviceId,
          m.senderUserId,
          m.senderName ?? null,
          m.content ?? null,
          m.messageType,
          m.media ? JSON.stringify(m.media) : null,
          m.replyToMessageId ?? null,
          m.replyPreview ?? null,
          m.reactions?.length ? JSON.stringify(m.reactions) : null,
          m.status,
          m.isOwn ? 1 : 0,
          m.isOwn ? 1 : 0,
          m.createdAt,
          m.expiresAt ?? null,
          m.deletedAt ?? null,
        ]
      );
    });
  }

  getMessage(id: string): Promise<Message | null> {
    return this.safe('getMessage', null, async (db) => {
      const r = await db.getFirstAsync<any>('SELECT * FROM messages WHERE id = ?', [id]);
      return r ? rowToMessage(r) : null;
    });
  }

  /** Newest `limit` messages (optionally older than `before`), returned oldest-first. */
  getMessages(conversationId: string, limit = 50, before?: string): Promise<Message[]> {
    return this.safe('getMessages', [], async (db) => {
      const now = new Date().toISOString();
      const rows = await db.getAllAsync<any>(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND deleted_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           ${before ? 'AND created_at < ?' : ''}
         ORDER BY created_at DESC LIMIT ?`,
        before ? [conversationId, now, before, limit] : [conversationId, now, limit]
      );
      return rows.map(rowToMessage).reverse();
    });
  }

  updateMessageStatus(id: string, status: Message['status']): Promise<void> {
    return this.safe('updateMessageStatus', undefined, async (db) => {
      await db.runAsync('UPDATE messages SET status = ? WHERE id = ?', [status, id]);
    });
  }

  updateMessageMedia(id: string, media: MediaAttachment): Promise<void> {
    return this.safe('updateMessageMedia', undefined, async (db) => {
      await db.runAsync('UPDATE messages SET media_json = ? WHERE id = ?', [JSON.stringify(media), id]);
    });
  }

  /**
   * Media ids still referenced by a live local message (for sweeping the
   * decrypted media cache). Null if the database isn't available.
   */
  getLiveMediaIds(): Promise<Set<string> | null> {
    return this.safe('getLiveMediaIds', null, async (db) => {
      const rows = await db.getAllAsync<{ media_json: string }>(
        'SELECT media_json FROM messages WHERE media_json IS NOT NULL AND deleted_at IS NULL'
      );
      const ids = new Set<string>();
      for (const r of rows) {
        try {
          const id = JSON.parse(r.media_json)?.mediaId;
          if (typeof id === 'string') ids.add(id);
        } catch {
          // ignore unreadable rows
        }
      }
      return ids;
    });
  }

  setReactions(id: string, reactions: MessageReaction[]): Promise<void> {
    return this.safe('setReactions', undefined, async (db) => {
      await db.runAsync('UPDATE messages SET reactions_json = ? WHERE id = ?', [
        reactions.length ? JSON.stringify(reactions) : null,
        id,
      ]);
    });
  }

  markMessageDeleted(id: string): Promise<void> {
    return this.safe('markMessageDeleted', undefined, async (db) => {
      await db.runAsync(
        `UPDATE messages SET deleted_at = ?, content = NULL, media_json = NULL, reply_preview = NULL WHERE id = ?`,
        [new Date().toISOString(), id]
      );
    });
  }

  clearConversation(conversationId: string): Promise<void> {
    return this.safe('clearConversation', undefined, async (db) => {
      await db.runAsync('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
    });
  }

  /** Removes expired disappearing messages from this device. Returns how many were removed. */
  purgeExpired(): Promise<number> {
    return this.safe('purgeExpired', 0, async (db) => {
      const res = await db.runAsync('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?', [
        new Date().toISOString(),
      ]);
      return res.changes;
    });
  }

  /** Marks everything in the conversation read locally; returns newest message time (for receipts). */
  markConversationRead(conversationId: string): Promise<string | null> {
    return this.safe('markConversationRead', null, async (db) => {
      await db.runAsync('UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND is_read = 0', [conversationId]);
      const r = await db.getFirstAsync<{ t: string | null }>(
        'SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ?',
        [conversationId]
      );
      return r?.t ?? null;
    });
  }

  getUnreadCounts(): Promise<Record<string, number>> {
    return this.safe('getUnreadCounts', {}, async (db) => {
      const rows = await db.getAllAsync<{ conversation_id: string; n: number }>(
        `SELECT conversation_id, COUNT(*) AS n FROM messages
         WHERE is_read = 0 AND is_own = 0 AND deleted_at IS NULL GROUP BY conversation_id`
      );
      return Object.fromEntries(rows.map((r) => [r.conversation_id, r.n]));
    });
  }

  /** Latest visible message per conversation (for chat list previews). */
  getLastMessages(): Promise<Record<string, Message>> {
    return this.safe('getLastMessages', {}, async (db) => {
      const rows = await db.getAllAsync<any>(
        `SELECT m.* FROM messages m
         JOIN (SELECT conversation_id, MAX(created_at) AS t FROM messages
               WHERE deleted_at IS NULL GROUP BY conversation_id) last
           ON last.conversation_id = m.conversation_id AND last.t = m.created_at
         WHERE m.deleted_at IS NULL`
      );
      return Object.fromEntries(rows.map((r) => [r.conversation_id, rowToMessage(r)]));
    });
  }

  getNewestMessageTime(conversationId: string): Promise<string | null> {
    return this.safe('getNewestMessageTime', null, async (db) => {
      const r = await db.getFirstAsync<{ t: string | null }>(
        'SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ?',
        [conversationId]
      );
      return r?.t ?? null;
    });
  }

  searchMessages(query: string): Promise<Message[]> {
    const q = query.trim();
    if (q.length < 2) return Promise.resolve([]);
    return this.safe('searchMessages', [], async (db) => {
      const rows = await db.getAllAsync<any>(
        `SELECT * FROM messages
         WHERE content LIKE ? ESCAPE '\\' AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 50`,
        [`%${escapeLike(q)}%`]
      );
      return rows.map(rowToMessage);
    });
  }

  // ── Conversation cache ────────────────────────────────────────────────────

  saveConversations(list: Conversation[]): Promise<void> {
    return this.safe('saveConversations', undefined, async (db) => {
      await db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM conversations_cache');
        for (const c of list) {
          await db.runAsync('INSERT INTO conversations_cache (id, json, updated_at) VALUES (?, ?, ?)', [
            c.id,
            JSON.stringify({ ...c, lastMessage: undefined, unreadCount: 0 }),
            c.updatedAt,
          ]);
        }
      });
    });
  }

  getCachedConversations(): Promise<Conversation[]> {
    return this.safe('getCachedConversations', [], async (db) => {
      const rows = await db.getAllAsync<{ json: string }>(
        'SELECT json FROM conversations_cache ORDER BY updated_at DESC'
      );
      return rows.map((r) => JSON.parse(r.json) as Conversation);
    });
  }

  // ── Pinned device keys (detects a server swapping a device's key) ─────────

  getDeviceKeys(deviceIds: string[]): Promise<PinnedDeviceKey[]> {
    if (deviceIds.length === 0) return Promise.resolve([]);
    return this.safe('getDeviceKeys', [], async (db) => {
      const rows = await db.getAllAsync<any>(
        `SELECT * FROM device_keys WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`,
        deviceIds
      );
      return rows.map((r) => ({
        deviceId: r.device_id,
        userId: r.user_id,
        publicKey: r.public_key,
        revokedAt: r.revoked_at,
      }));
    });
  }

  saveDeviceKeys(keys: PinnedDeviceKey[]): Promise<void> {
    return this.safe('saveDeviceKeys', undefined, async (db) => {
      for (const k of keys) {
        // INSERT OR IGNORE: the first key seen for a device id is pinned forever.
        await db.runAsync(
          'INSERT OR IGNORE INTO device_keys (device_id, user_id, public_key, revoked_at) VALUES (?, ?, ?, ?)',
          [k.deviceId, k.userId, k.publicKey, k.revokedAt ?? null]
        );
        if (k.revokedAt) {
          await db.runAsync('UPDATE device_keys SET revoked_at = ? WHERE device_id = ?', [k.revokedAt, k.deviceId]);
        }
      }
    });
  }

  // ── Safety numbers ────────────────────────────────────────────────────────

  getVerifiedSafetyNumber(userId: string): Promise<string | null> {
    return this.safe('getVerifiedSafetyNumber', null, async (db) => {
      const r = await db.getFirstAsync<{ verified_number: string }>(
        'SELECT verified_number FROM safety_numbers WHERE user_id = ?',
        [userId]
      );
      return r?.verified_number ?? null;
    });
  }

  setVerifiedSafetyNumber(userId: string, safetyNumber: string | null): Promise<void> {
    return this.safe('setVerifiedSafetyNumber', undefined, async (db) => {
      if (safetyNumber === null) {
        await db.runAsync('DELETE FROM safety_numbers WHERE user_id = ?', [userId]);
      } else {
        await db.runAsync(
          'INSERT OR REPLACE INTO safety_numbers (user_id, verified_number, verified_at) VALUES (?, ?, ?)',
          [userId, safetyNumber, new Date().toISOString()]
        );
      }
    });
  }

  // ── Per-conversation settings ─────────────────────────────────────────────

  getDisappearingTimer(conversationId: string): Promise<number> {
    return this.safe('getDisappearingTimer', 0, async (db) => {
      const r = await db.getFirstAsync<{ timer_seconds: number }>(
        'SELECT timer_seconds FROM conversation_settings WHERE conversation_id = ?',
        [conversationId]
      );
      return r?.timer_seconds ?? 0;
    });
  }

  setDisappearingTimer(conversationId: string, seconds: number): Promise<void> {
    return this.safe('setDisappearingTimer', undefined, async (db) => {
      await db.runAsync(
        'INSERT OR REPLACE INTO conversation_settings (conversation_id, timer_seconds) VALUES (?, ?)',
        [conversationId, seconds]
      );
    });
  }

  // ── Call history ──────────────────────────────────────────────────────────

  addCallLog(record: LocalCallRecord): Promise<void> {
    return this.safe('addCallLog', undefined, async (db) => {
      await db.runAsync(
        `INSERT OR REPLACE INTO call_logs (id, peer_id, peer_name, call_type, direction, duration, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [record.id, record.peerId, record.peerName, record.callType, record.direction, record.duration, record.createdAt]
      );
    });
  }

  getCallLogs(limit = 50): Promise<LocalCallRecord[]> {
    return this.safe('getCallLogs', [], async (db) => {
      const rows = await db.getAllAsync<any>('SELECT * FROM call_logs ORDER BY created_at DESC LIMIT ?', [limit]);
      return rows.map((r) => ({
        id: r.id,
        peerId: r.peer_id,
        peerName: r.peer_name,
        callType: r.call_type,
        direction: r.direction,
        duration: r.duration,
        createdAt: r.created_at,
      }));
    });
  }

  /**
   * Raw access for bulk export/import (device-to-device transfer, see
   * src/features/transfer). Unlike the methods above, errors propagate.
   */
  async withConnection<T>(fn: (db: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
    return fn(await this.db());
  }

  /** Erases everything this account stored on this device. */
  clearAllData(): Promise<void> {
    return this.safe('clearAllData', undefined, async (db) => {
      await db.execAsync(`
        DELETE FROM messages;
        DELETE FROM conversations_cache;
        DELETE FROM device_keys;
        DELETE FROM safety_numbers;
        DELETE FROM conversation_settings;
        DELETE FROM call_logs;
      `);
    });
  }
}

export const databaseService = new DatabaseService();
