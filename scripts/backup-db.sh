#!/usr/bin/env bash
# Dump the finplat postgres database (custom format) to ./backups/. Usage: scripts/backup-db.sh [compose-file]
set -euo pipefail
source "$(dirname "$0")/_docker.sh"
compose_file="${1:-docker-compose.yml}"
mkdir -p "$FINPLAT_ROOT/backups"
out="$FINPLAT_ROOT/backups/finplat-$(date -u +%Y%m%dT%H%M%SZ).dump"
dockerx compose -p finplat -f "$FINPLAT_ROOT/$compose_file" exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' > "$out"
echo "backup written: $out ($(wc -c < "$out") bytes)"
