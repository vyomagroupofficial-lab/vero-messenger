#!/usr/bin/env bash
# Serves supabase/functions with the host's Deno behind the local stack's Kong
# (see host-functions.ts for why). Prefer `supabase functions serve` wherever
# the edge-runtime container can reach jsr.io with a trusted certificate.
#
#   tests/e2e/tools/serve-functions-host.sh [env-file]
set -euo pipefail
cd "$(dirname "$0")/../../.."

project_id=$(sed -n 's/^project_id *= *"\(.*\)"/\1/p' supabase/config.toml)
network="supabase_network_${project_id}"
container="supabase_edge_runtime_${project_id}"
gateway=$(docker network inspect "$network" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')

eval "$(supabase status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
export SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
if [[ -n "${1:-}" ]]; then set -a; . "$1"; set +a; fi

docker rm -f "$container" >/dev/null 2>&1 || true
docker run -d --name "$container" --network "$network" alpine/socat \
  tcp-listen:8081,fork,reuseaddr "tcp-connect:${gateway}:8081" >/dev/null

exec deno run -A --no-lock tests/e2e/tools/host-functions.ts
