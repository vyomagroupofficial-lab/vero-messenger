#!/usr/bin/env bash
# Prints export lines for the E2E suite against the local Supabase stack:
#   eval "$(tests/e2e/local-env.sh)" && npm run test:e2e
# Also makes sure the local stack is wired like production for push:
# the Vault secret project_url points at Kong inside the Docker network.
set -euo pipefail
cd "$(dirname "$0")/../.."
status=$(supabase status -o env 2>/dev/null)
get() { printf '%s\n' "$status" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p"; }
api=$(get API_URL); anon=$(get ANON_KEY); service=$(get SERVICE_ROLE_KEY); db=$(get DB_URL); mail=$(get MAILPIT_URL)
project_id=$(sed -n 's/^project_id *= *"\(.*\)"/\1/p' supabase/config.toml)

psql "$db" -X -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.create_secret('http://supabase_kong_${project_id}:8000', 'project_url');
  end if;
end \$\$;
SQL

cat <<EOF
export SUPABASE_URL='$api'
export SUPABASE_ANON_KEY='$anon'
export SUPABASE_SERVICE_ROLE_KEY='$service'
export DATABASE_URL='$db'
export MAILPIT_URL='$mail'
EOF
