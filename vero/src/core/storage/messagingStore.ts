/**
 * Local (decrypted) storage for messaging features: edits and their history,
 * delete-for-everyone tombstones, stars, full-text search, read watermarks
 * and sync cursors. Lives next to DatabaseService and uses its connection;
 * like DatabaseService, storage errors are logged and never break messaging.
 */

import type * as SQLite from 'expo-sqlite';
import type { Message } from '../../shared/models/Message';
import { databaseService, MESSAGE_SELECT, rowToMessage } from './DatabaseService';
import { isFtsAvailable } from './messagingSchema';
import { buildSearchSql } from './messagingSql';

export interface EditRecord {
  id: string;
  targetId: string;
  conversationId: string;
  senderUserId: string;
  previousText: string | null;
  newText: string;
  editedAt: string;
}

export interface StarRecord {
  messageId: string;
  conversationId: string;
  starred: boolean;
  updatedAt: string;
}

async function safe<T>(label: string, fallback: T, fn: (db: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  if (!databaseService.isOpen) return fallback;
  try {
    return await databaseService.withConnection(fn);
  } catch (e) {
    console.warn(`[messagingStore] ${label} failed:`, e);
    return fallback;
  }
}

const placeholders = (n: number) => new Array(n).fill('?').join(',');

class MessagingStore {
  // ── Sent / failed ────────────────────────────────────────────────────────

  /** The server accepted our message: adopt its timestamp (receipts and cursors use server time). */
  confirmSent(id: string, serverCreatedAt: string | null): Promise<void> {
    return safe('confirmSent', undefined, async (db) => {
      if (serverCreatedAt) {
        await db.runAsync(`UPDATE messages SET status = 'sent', created_at = ? WHERE id = ? AND status IN ('sending', 'failed')`, [
          serverCreatedAt,
          id,
        ]);
      } else {
        await db.runAsync(`UPDATE messages SET status = 'sent' WHERE id = ? AND status IN ('sending', 'failed')`, [id]);
      }
    });
  }

  /** Messages stuck in 'sending' (app killed mid-send) become retryable. */
  failStaleSending(conversationId: string, olderThanIso: string): Promise<number> {
    return safe('failStaleSending', 0, async (db) => {
      const res = await db.runAsync(
        `UPDATE messages SET status = 'failed' WHERE conversation_id = ? AND status = 'sending' AND created_at < ?`,
        [conversationId, olderThanIso]
      );
      return res.changes;
    });
  }

  // ── Delete for everyone ──────────────────────────────────────────────────

  /**
   * Replaces a message with a "This message was deleted" tombstone and drops
   * its edit history and star. Returns the message as it was (for cache cleanup).
   */
  revoke(id: string, at: string = new Date().toISOString()): Promise<Message | null> {
    return safe('revoke', null, async (db) => {
      const before = await db.getFirstAsync<any>(`${MESSAGE_SELECT} WHERE m.id = ?`, [id]);
      if (!before) return null;
      await db.runAsync(
        `UPDATE messages SET revoked_at = COALESCE(revoked_at, ?), content = NULL, media_json = NULL,
           reply_preview = NULL, reactions_json = NULL, edited_at = NULL WHERE id = ?`,
        [at, id]
      );
      await db.runAsync('DELETE FROM message_edits WHERE target_id = ?', [id]);
      await db.runAsync('DELETE FROM message_stars WHERE message_id = ?', [id]);
      return rowToMessage(before);
    });
  }

  // ── Edits ────────────────────────────────────────────────────────────────

  /** Stores an edit record (idempotent by control-message id). Returns false if already known. */
  recordEdit(e: EditRecord): Promise<boolean> {
    return safe('recordEdit', false, async (db) => {
      const res = await db.runAsync(
        `INSERT OR IGNORE INTO message_edits (id, target_id, conversation_id, sender_user_id, previous_text, new_text, edited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [e.id, e.targetId, e.conversationId, e.senderUserId, e.previousText, e.newText, e.editedAt]
      );
      return res.changes > 0;
    });
  }

  setEditPreviousText(id: string, previousText: string | null): Promise<void> {
    return safe('setEditPreviousText', undefined, async (db) => {
      await db.runAsync('UPDATE message_edits SET previous_text = COALESCE(previous_text, ?) WHERE id = ?', [previousText, id]);
    });
  }

  removeEdit(id: string): Promise<void> {
    return safe('removeEdit', undefined, async (db) => {
      await db.runAsync('DELETE FROM message_edits WHERE id = ?', [id]);
    });
  }

  getEdits(targetId: string): Promise<EditRecord[]> {
    return safe('getEdits', [], async (db) => {
      const rows = await db.getAllAsync<any>('SELECT * FROM message_edits WHERE target_id = ? ORDER BY edited_at', [targetId]);
      return rows.map((r) => ({
        id: r.id,
        targetId: r.target_id,
        conversationId: r.conversation_id,
        senderUserId: r.sender_user_id,
        previousText: r.previous_text,
        newText: r.new_text,
        editedAt: r.edited_at,
      }));
    });
  }

  /** Sets the visible text after an edit (never on deleted messages). */
  applyEdit(targetId: string, newText: string, editedAt: string): Promise<void> {
    return safe('applyEdit', undefined, async (db) => {
      await db.runAsync(
        'UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND revoked_at IS NULL AND deleted_at IS NULL',
        [newText, editedAt, targetId]
      );
    });
  }

  /** Restores text after a failed edit. */
  revertEdit(targetId: string, content: string | null, editedAt: string | null): Promise<void> {
    return safe('revertEdit', undefined, async (db) => {
      await db.runAsync('UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND revoked_at IS NULL', [
        content,
        editedAt,
        targetId,
      ]);
    });
  }

  // ── Stars ────────────────────────────────────────────────────────────────

  getStarStates(messageIds: string[]): Promise<Map<string, StarRecord>> {
    if (messageIds.length === 0) return Promise.resolve(new Map());
    return safe('getStarStates', new Map(), async (db) => {
      const rows = await db.getAllAsync<any>(
        `SELECT * FROM message_stars WHERE message_id IN (${placeholders(messageIds.length)})`,
        messageIds
      );
      return new Map(
        rows.map((r) => [
          r.message_id,
          { messageId: r.message_id, conversationId: r.conversation_id, starred: r.starred === 1, updatedAt: r.updated_at },
        ])
      );
    });
  }

  setStars(items: StarRecord[]): Promise<void> {
    return safe('setStars', undefined, async (db) => {
      for (const it of items) {
        await db.runAsync(
          'INSERT OR REPLACE INTO message_stars (message_id, conversation_id, starred, updated_at) VALUES (?, ?, ?, ?)',
          [it.messageId, it.conversationId, it.starred ? 1 : 0, it.updatedAt]
        );
      }
    });
  }

  /** Starred, still visible messages; newest first. */
  getStarredMessages(conversationId?: string, limit = 500): Promise<Message[]> {
    return safe('getStarredMessages', [], async (db) => {
      const rows = await db.getAllAsync<any>(
        `${MESSAGE_SELECT}
         WHERE s.starred = 1 AND m.deleted_at IS NULL AND m.revoked_at IS NULL
           AND (m.expires_at IS NULL OR m.expires_at > ?)
           ${conversationId ? 'AND m.conversation_id = ?' : ''}
         ORDER BY m.created_at DESC LIMIT ?`,
        conversationId ? [new Date().toISOString(), conversationId, limit] : [new Date().toISOString(), limit]
      );
      return rows.map(rowToMessage);
    });
  }

  // ── Search ───────────────────────────────────────────────────────────────

  /** Local search over decrypted messages, newest first (FTS5, or LIKE where FTS5 is unavailable). */
  search(query: string, opts: { conversationId?: string; limit?: number } = {}): Promise<Message[]> {
    const base = { conversationId: opts.conversationId, limit: opts.limit ?? 100, nowIso: new Date().toISOString() };
    return safe('search', [] as Message[], async (db) => {
      const run = async (fts: boolean) => {
        const stmt = buildSearchSql(query, { ...base, fts });
        if (!stmt) return [];
        const rows = await db.getAllAsync<any>(stmt.sql, stmt.params);
        return rows.map(rowToMessage);
      };
      if (!isFtsAvailable()) return run(false);
      try {
        return await run(true);
      } catch (e) {
        console.warn('[messagingStore] FTS query failed, using LIKE:', (e as Error)?.message);
        return run(false);
      }
    });
  }

  /**
   * Everything from `context` messages before `target` up to the newest
   * message (capped), oldest first: the chat view after jumping to a result.
   */
  getMessagesFrom(conversationId: string, targetCreatedAt: string, context = 20, cap = 2000): Promise<Message[]> {
    return safe('getMessagesFrom', [], async (db) => {
      const now = new Date().toISOString();
      const older = await db.getAllAsync<any>(
        `${MESSAGE_SELECT}
         WHERE m.conversation_id = ? AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND m.created_at < ?
         ORDER BY m.created_at DESC LIMIT ?`,
        [conversationId, now, targetCreatedAt, context]
      );
      const newer = await db.getAllAsync<any>(
        `${MESSAGE_SELECT}
         WHERE m.conversation_id = ? AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND m.created_at >= ?
         ORDER BY m.created_at ASC LIMIT ?`,
        [conversationId, now, targetCreatedAt, cap]
      );
      return [...older.reverse(), ...newer].map(rowToMessage);
    });
  }

  // ── Unread / read state ──────────────────────────────────────────────────

  /** Applies the server read watermark (e.g. read on another of my devices). */
  markReadUpTo(conversationId: string, watermark: string): Promise<number> {
    return safe('markReadUpTo', 0, async (db) => {
      const res = await db.runAsync(
        'UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND is_read = 0 AND created_at <= ?',
        [conversationId, watermark]
      );
      return res.changes;
    });
  }

  /**
   * Messages from others not yet marked read on this device, per conversation.
   * The chat list counts the ones after the account's read watermark
   * (computeUnreadCount), so reading on another device clears them here too.
   */
  getUnreadCandidates(): Promise<Record<string, Pick<Message, 'isOwn' | 'messageType' | 'createdAt' | 'deletedAt' | 'revokedAt' | 'expiresAt'>[]>> {
    return safe('getUnreadCandidates', {}, async (db) => {
      const rows = await db.getAllAsync<any>(
        `SELECT conversation_id, message_type, created_at, deleted_at, revoked_at, expires_at FROM messages
         WHERE is_read = 0 AND is_own = 0 AND deleted_at IS NULL`
      );
      const out: Record<string, Pick<Message, 'isOwn' | 'messageType' | 'createdAt' | 'deletedAt' | 'revokedAt' | 'expiresAt'>[]> = {};
      for (const r of rows) {
        (out[r.conversation_id] ??= []).push({
          isOwn: false,
          messageType: r.message_type,
          createdAt: r.created_at,
          deletedAt: r.deleted_at,
          revokedAt: r.revoked_at,
          expiresAt: r.expires_at,
        });
      }
      return out;
    });
  }

  /** Newest message from someone else, per conversation (for auto-unarchive). */
  getLastIncomingTimes(): Promise<Record<string, string>> {
    return safe('getLastIncomingTimes', {}, async (db) => {
      const rows = await db.getAllAsync<{ conversation_id: string; t: string }>(
        `SELECT conversation_id, MAX(created_at) AS t FROM messages
         WHERE is_own = 0 AND deleted_at IS NULL AND message_type != 'system'
         GROUP BY conversation_id`
      );
      return Object.fromEntries(rows.map((r) => [r.conversation_id, r.t]));
    });
  }

  // ── Sync cursors ─────────────────────────────────────────────────────────

  getState(key: string): Promise<string | null> {
    return safe('getState', null, async (db) => {
      const r = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_state WHERE key = ?', [key]);
      return r?.value ?? null;
    });
  }

  setState(key: string, value: string): Promise<void> {
    return safe('setState', undefined, async (db) => {
      await db.runAsync('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)', [key, value]);
    });
  }
}

export const messagingStore = new MessagingStore();
