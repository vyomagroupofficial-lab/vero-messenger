// expo-sqlite's async API (the MinimalSqlDb subset) over node:sqlite.
import type { DatabaseSync } from 'node:sqlite';
import type { MinimalSqlDb } from '../../../../src/core/crypto/ratchet/SqliteRatchetStore';

export function nodeSqliteDb(raw: DatabaseSync): MinimalSqlDb {
  return {
    execAsync: async (sql) => void raw.exec(sql),
    runAsync: async (sql, params) => raw.prepare(sql).run(...params),
    getFirstAsync: async <T>(sql: string, params: (string | number | null)[]) => ((raw.prepare(sql).get(...params) as T) ?? null),
    getAllAsync: async <T>(sql: string, params: (string | number | null)[]) => raw.prepare(sql).all(...params) as T[],
  };
}
