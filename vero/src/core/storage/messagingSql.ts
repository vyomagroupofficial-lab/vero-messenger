/**
 * SQL for local message search (pure; unit-tested against SQLite FTS5).
 * User input only ever travels as bound parameters.
 */

import { buildFtsQuery, buildLikePatterns } from '../../features/search/searchQuery';
import { MESSAGE_SELECT } from './messagingSchema';

export interface SearchSqlOptions {
  conversationId?: string;
  limit: number;
  nowIso: string;
  /** Use the FTS5 index (otherwise LIKE). */
  fts: boolean;
}

export interface SqlStatement {
  sql: string;
  params: (string | number)[];
}

const VISIBLE = `m.deleted_at IS NULL AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)
  AND m.message_type != 'unavailable'`;

/** Newest-first matches, or null when the query has nothing searchable. */
export function buildSearchSql(query: string, opts: SearchSqlOptions): SqlStatement | null {
  const conv = opts.conversationId ? 'AND m.conversation_id = ?' : '';
  const tail = [opts.nowIso, ...(opts.conversationId ? [opts.conversationId] : []), opts.limit];

  if (opts.fts) {
    const match = buildFtsQuery(query);
    if (!match) return null;
    return {
      sql: `SELECT m.*, s.starred AS starred FROM messages_fts f
            JOIN messages m ON m.rowid = f.rowid
            LEFT JOIN message_stars s ON s.message_id = m.id AND s.starred = 1
            WHERE messages_fts MATCH ? AND ${VISIBLE} ${conv}
            ORDER BY m.created_at DESC LIMIT ?`,
      params: [match, ...tail],
    };
  }

  const patterns = buildLikePatterns(query);
  if (patterns.length === 0) return null;
  return {
    sql: `${MESSAGE_SELECT}
          WHERE ${patterns.map(() => "lower(m.content) LIKE ? ESCAPE '\\'").join(' AND ')} AND ${VISIBLE} ${conv}
          ORDER BY m.created_at DESC LIMIT ?`,
    params: [...patterns, ...tail],
  };
}
