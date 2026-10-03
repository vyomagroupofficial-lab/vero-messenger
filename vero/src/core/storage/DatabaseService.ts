/**
 * Vero Local SQLite Database Service
 *
 * Implements Section 27 & 28 of Master Plan:
 * Local offline storage for decrypted messages, conversations,
 * call history, and cryptographic safety numbers.
 *
 * Plaintext stays strictly in local SQLite and is NEVER sent unencrypted to the server.
 */

import * as SQLite from 'expo-sqlite';
import { Message, Conversation, User } from '../../shared/models/Message';

export interface LocalCallRecord {
  id: string;
  callId?: string;
  peerId: string;
  peerName: string;
  callType: 'voice' | 'video';
  direction: 'incoming' | 'outgoing' | 'missed';
  duration: number; // in seconds
  createdAt: string;
}

class DatabaseService {
  private dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

  private async getDb(): Promise<SQLite.SQLiteDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const db = await SQLite.openDatabaseAsync('vero_local.db');
        await this.initSchema(db);
        return db;
      })();
    }
    return this.dbPromise;
  }

  private async initSchema(db: SQLite.SQLiteDatabase): Promise<void> {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender_device_id TEXT NOT NULL,
        sender_user_id TEXT,
        sender_name TEXT,
        content TEXT,
        message_type TEXT NOT NULL DEFAULT 'text',
        media_uri TEXT,
        media_id TEXT,
        reply_to_id TEXT,
        reply_preview TEXT,
        status TEXT NOT NULL DEFAULT 'sent',
        is_own INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        deleted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation 
        ON messages(conversation_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        conversation_type TEXT NOT NULL DEFAULT 'direct',
        name TEXT,
        avatar_uri TEXT,
        other_user_id TEXT,
        other_user_json TEXT,
        last_message_content TEXT,
        last_message_time TEXT,
        last_message_type TEXT,
        last_message_is_own INTEGER DEFAULT 0,
        unread_count INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS safety_numbers (
        user_id TEXT PRIMARY KEY,
        safety_number TEXT NOT NULL,
        is_verified INTEGER DEFAULT 0,
        verified_at TEXT
      );

      CREATE TABLE IF NOT EXISTS call_logs (
        id TEXT PRIMARY KEY,
        call_id TEXT,
        peer_id TEXT NOT NULL,
        peer_name TEXT NOT NULL,
        call_type TEXT NOT NULL,
        direction TEXT NOT NULL,
        duration INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_call_logs_created
        ON call_logs(created_at DESC);
    `);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Message Operations
  // ──────────────────────────────────────────────────────────────────────────

  async saveMessage(msg: Message): Promise<void> {
    try {
      const db = await this.getDb();
      await db.runAsync(
        `INSERT OR REPLACE INTO messages (
          id, conversation_id, sender_device_id, sender_user_id, sender_name,
          content, message_type, media_uri, media_id, reply_to_id,
          reply_preview, status, is_own, created_at, expires_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          msg.id,
          msg.conversationId,
          msg.senderDeviceId,
          msg.senderUserId || null,
          msg.senderProfile?.displayName || null,
          msg.content || null,
          msg.messageType,
          msg.media?.localUri || null,
          msg.media?.mediaId || null,
          msg.replyToMessageId || null,
          msg.replyToMessage?.content || null,
          msg.status,
          msg.isOwn ? 1 : 0,
          msg.createdAt,
          msg.expiresAt || null,
          msg.deletedAt || null,
        ]
      );
    } catch (e) {
      console.error('[DatabaseService] saveMessage error:', e);
    }
  }

  async getMessages(
    conversationId: string,
    limit: number = 50,
    beforeDate?: string
  ): Promise<Message[]> {
    try {
      const db = await this.getDb();
      let query = `
        SELECT * FROM messages
        WHERE conversation_id = ? AND deleted_at IS NULL
      `;
      const params: any[] = [conversationId];

      if (beforeDate) {
        query += ` AND created_at < ?`;
        params.push(beforeDate);
      }

      query += ` ORDER BY created_at ASC LIMIT ?`;
      params.push(limit);

      const rows = await db.getAllAsync<any>(query, params);

      return rows.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        senderDeviceId: r.sender_device_id,
        senderUserId: r.sender_user_id || undefined,
        senderProfile: r.sender_name
          ? { id: r.sender_user_id || '', displayName: r.sender_name, username: '' }
          : undefined,
        content: r.content || undefined,
        messageType: r.message_type as any,
        media: r.media_uri
          ? {
              mediaId: r.media_id || '',
              mimeTypeHint: '',
              encryptedObjectId: '',
              encryptedSize: 0,
              localUri: r.media_uri,
            }
          : undefined,
        replyToMessageId: r.reply_to_id || undefined,
        replyToMessage: r.reply_preview
          ? {
              id: r.reply_to_id || '',
              conversationId: r.conversation_id,
              senderDeviceId: '',
              content: r.reply_preview,
              messageType: 'text',
              createdAt: '',
              status: 'delivered',
              isOwn: false,
            }
          : undefined,
        status: r.status as any,
        isOwn: r.is_own === 1,
        createdAt: r.created_at,
        expiresAt: r.expires_at || undefined,
        deletedAt: r.deleted_at || undefined,
      }));
    } catch (e) {
      console.error('[DatabaseService] getMessages error:', e);
      return [];
    }
  }

  async updateMessageStatus(id: string, status: Message['status']): Promise<void> {
    try {
      const db = await this.getDb();
      await db.runAsync(`UPDATE messages SET status = ? WHERE id = ?`, [status, id]);
    } catch (e) {
      console.error('[DatabaseService] updateMessageStatus error:', e);
    }
  }

  async markMessageDeleted(id: string): Promise<void> {
    try {
      const db = await this.getDb();
      await db.runAsync(
        `UPDATE messages SET deleted_at = ? WHERE id = ?`,
        [new Date().toISOString(), id]
      );
    } catch (e) {
      console.error('[DatabaseService] markMessageDeleted error:', e);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Local Full-Text Message Search (Privacy-Preserving)
  // ──────────────────────────────────────────────────────────────────────────

  async searchMessages(query: string): Promise<Message[]> {
    if (!query.trim()) return [];
    try {
      const db = await this.getDb();
      const rows = await db.getAllAsync<any>(
        `SELECT * FROM messages
         WHERE content LIKE ? AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 50`,
        [`%${query}%`]
      );

      return rows.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        senderDeviceId: r.sender_device_id,
        senderUserId: r.sender_user_id || undefined,
        content: r.content || undefined,
        messageType: r.message_type as any,
        status: r.status as any,
        isOwn: r.is_own === 1,
        createdAt: r.created_at,
      }));
    } catch (e) {
      console.error('[DatabaseService] searchMessages error:', e);
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Safety Numbers & Fingerprints
  // ──────────────────────────────────────────────────────────────────────────

  async saveSafetyNumber(userId: string, safetyNumber: string): Promise<void> {
    try {
      const db = await this.getDb();
      await db.runAsync(
        `INSERT OR REPLACE INTO safety_numbers (user_id, safety_number)
         VALUES (?, ?)`,
        [userId, safetyNumber]
      );
    } catch (e) {
      console.error('[DatabaseService] saveSafetyNumber error:', e);
    }
  }

  async setSafetyNumberVerified(userId: string, isVerified: boolean): Promise<void> {
    try {
      const db = await this.getDb();
      await db.runAsync(
        `UPDATE safety_numbers SET is_verified = ?, verified_at = ? WHERE user_id = ?`,
        [isVerified ? 1 : 0, isVerified ? new Date().toISOString() : null, userId]
      );
    } catch (e) {
      console.error('[DatabaseService] setSafetyNumberVerified error:', e);
    }
  }

  async getSafetyNumber(userId: string): Promise<{ safetyNumber: string; isVerified: boolean } | null> {
    try {
      const db = await this.getDb();
      const row = await db.getFirstAsync<any>(
        `SELECT safety_number, is_verified FROM safety_numbers WHERE user_id = ?`,
        [userId]
      );
      if (!row) return null;
      return {
        safetyNumber: row.safety_number,
        isVerified: row.is_verified === 1,
      };
    } catch (e) {
      console.error('[DatabaseService] getSafetyNumber error:', e);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Call History
  // ──────────────────────────────────────────────────────────────────────────

  async addCallLog(record: Omit<LocalCallRecord, 'id'>): Promise<string> {
    try {
      const db = await this.getDb();
      const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      await db.runAsync(
        `INSERT INTO call_logs (id, call_id, peer_id, peer_name, call_type, direction, duration, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          record.callId || null,
          record.peerId,
          record.peerName,
          record.callType,
          record.direction,
          record.duration,
          record.createdAt,
        ]
      );
      return id;
    } catch (e) {
      console.error('[DatabaseService] addCallLog error:', e);
      return '';
    }
  }

  async getCallLogs(limit: number = 30): Promise<LocalCallRecord[]> {
    try {
      const db = await this.getDb();
      const rows = await db.getAllAsync<any>(
        `SELECT * FROM call_logs ORDER BY created_at DESC LIMIT ?`,
        [limit]
      );
      return rows.map((r) => ({
        id: r.id,
        callId: r.call_id || undefined,
        peerId: r.peer_id,
        peerName: r.peer_name,
        callType: r.call_type as any,
        direction: r.direction as any,
        duration: r.duration || 0,
        createdAt: r.created_at,
      }));
    } catch (e) {
      console.error('[DatabaseService] getCallLogs error:', e);
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Storage maintenance
  // ──────────────────────────────────────────────────────────────────────────

  async clearAllData(): Promise<void> {
    try {
      const db = await this.getDb();
      await db.execAsync(`
        DELETE FROM messages;
        DELETE FROM conversations;
        DELETE FROM safety_numbers;
        DELETE FROM call_logs;
      `);
    } catch (e) {
      console.error('[DatabaseService] clearAllData error:', e);
    }
  }
}

export const databaseService = new DatabaseService();
