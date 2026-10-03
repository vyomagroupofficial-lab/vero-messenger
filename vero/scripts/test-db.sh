#!/usr/bin/env bash
# Applies the migrations to a scratch database on a local PostgreSQL (with
# stand-ins for Supabase's auth/realtime schemas) and runs every
# supabase/tests/*_test.sql file, each against its own fresh database.
#   PGHOST/PGPORT/PGUSER select the server (defaults: local socket, postgres).
set -euo pipefail
cd "$(dirname "$0")/.."
DB=""
trap '[ -n "$DB" ] && psql -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
i=0
for t in supabase/tests/*_test.sql; do
  i=$((i + 1))
  DB="vero_test_$$_$i"
  echo "== $t"
  psql -q -v ON_ERROR_STOP=1 -d postgres -c "create database $DB" >/dev/null
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/supabase_stubs.sql >/dev/null
  for f in supabase/migrations/*.sql; do
    PGOPTIONS="-c client_min_messages=warning" psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null
  done
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$t" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  //'
  psql -q -d postgres -c "drop database if exists $DB" >/dev/null
  DB=""
done
