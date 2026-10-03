#!/usr/bin/env bash
# Applies the migrations to a scratch database on a local PostgreSQL (with
# stand-ins for Supabase's auth/realtime schemas) and runs the RLS tests.
#   PGHOST/PGPORT/PGUSER select the server (defaults: local socket, postgres).
set -euo pipefail
cd "$(dirname "$0")/.."
DB="vero_test_$$"
psql -q -v ON_ERROR_STOP=1 -d postgres -c "create database $DB" >/dev/null
trap 'psql -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/supabase_stubs.sql >/dev/null
for f in supabase/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null
done
# rls_test.sql first (it counts rows from a clean slate), then every other *_test.sql.
for t in supabase/tests/rls_test.sql $(ls supabase/tests/*_test.sql | grep -v '/rls_test.sql$'); do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$t" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  //'
done
