#!/usr/bin/env bash
# Restore a dump produced by backup-db.sh. DESTRUCTIVE for the target DB. Usage: scripts/restore-db.sh <file> [compose-file]
set -euo pipefail
source "$(dirname "$0")/_docker.sh"
file="${1:?usage: restore-db.sh <dump-file> [compose-file]}"
compose_file="${2:-docker-compose.yml}"
read -r -p "This replaces all data in the finplat database. Type 'restore' to continue: " ok
[ "$ok" = "restore" ] || { echo aborted; exit 1; }
dockerx compose -p finplat -f "$FINPLAT_ROOT/$compose_file" exec -T postgres \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction' < "$file"
echo "restore complete; restart the api so migrations re-check: docker compose -p finplat restart api"
