# Sourced helper: run docker directly if the user can, otherwise through `sg docker`.
dockerx() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    sg docker -c "$(printf '%q ' docker "$@")"
  fi
}
FINPLAT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Named cache volumes are created root-owned; make them writable for uid 1000 (cheap, idempotent).
finplat_prepare_volumes() {
  local args=() v
  for v in "$@"; do args+=(-v "$v:/vol/$v"); done
  dockerx run --rm "${args[@]}" alpine:3 sh -c 'chown 1000:1000 /vol/*' >/dev/null
}
# Attach to the DEV stack network (never prod) when it is up, so tests can reach its postgres.
FINPLAT_DEV_NETWORK=finplat-dev_default
finplat_dev_up() { dockerx network inspect "$FINPLAT_DEV_NETWORK" >/dev/null 2>&1; }
finplat_network_args() { if finplat_dev_up; then echo "--network $FINPLAT_DEV_NETWORK"; fi; }
