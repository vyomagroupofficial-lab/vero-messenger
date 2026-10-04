/**
 * E2E configuration (environment only, so the suite can point at any project).
 *
 *   SUPABASE_URL                 required  e.g. http://127.0.0.1:54321 or https://<ref>.supabase.co
 *   SUPABASE_ANON_KEY            required  anon / publishable key
 *   SUPABASE_SERVICE_ROLE_KEY    optional  creates confirmed users without e-mail, deletes them
 *                                          afterwards, runs service-only RPCs (cleanup jobs)
 *   DATABASE_URL                 optional  direct Postgres (psql) for time travel (backdating rows
 *                                          to test 48 h / 24 h windows) and pg_net evidence
 *   MAILPIT_URL                  optional  local Mailpit, for the e-mail confirmation path
 *   E2E_EMAIL_DOMAIN             optional  default "example.com"
 *   E2E_KEEP=1                   optional  keep the created users
 *
 * Without the optional values the dependent steps are SKIPPED (reported as
 * such), never faked. Load them for the local stack with
 *   eval "$(tests/e2e/local-env.sh)"
 */

function opt(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

export const env = {
  url: opt('SUPABASE_URL') ?? opt('EXPO_PUBLIC_SUPABASE_URL') ?? '',
  anonKey: opt('SUPABASE_ANON_KEY') ?? opt('EXPO_PUBLIC_SUPABASE_ANON_KEY') ?? '',
  serviceKey: opt('SUPABASE_SERVICE_ROLE_KEY'),
  databaseUrl: opt('DATABASE_URL'),
  mailpitUrl: opt('MAILPIT_URL'),
  emailDomain: opt('E2E_EMAIL_DOMAIN') ?? 'example.com',
  keep: opt('E2E_KEEP') === '1',
};

if (!env.url || !env.anonKey) {
  throw new Error('Set SUPABASE_URL and SUPABASE_ANON_KEY (see tests/e2e/README.md).');
}

export const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(env.url);

/** Short id that keeps usernames (<= 30 chars) and handles unique per run. */
export const RUN_ID = Math.random().toString(36).slice(2, 8);
