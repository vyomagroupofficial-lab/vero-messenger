/**
 * Optional direct database access (DATABASE_URL + the psql CLI), used only
 * for things a client can't do: moving timestamps into the past to test time
 * windows, and reading pg_net's response table as evidence for push.
 */

import { execFileSync } from 'node:child_process';
import { env } from './env';

export const hasDb = (() => {
  if (!env.databaseUrl) return false;
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Runs SQL as the database owner and returns the rows (tab-separated columns). */
export function sql(query: string): string[][] {
  if (!hasDb) throw new Error('DATABASE_URL / psql not available');
  const out = execFileSync('psql', [env.databaseUrl!, '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', query], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('\t'));
}

export function sqlValue(query: string): string | null {
  return sql(query)[0]?.[0] ?? null;
}

/** Quote a literal for interpolation into test SQL (values come from the test itself). */
export const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
