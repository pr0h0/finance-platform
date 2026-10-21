# Known issues and limitations

- **Phase 0 only**: all API modules are registered but have no routes yet (they return the JSON 404
  `route_not_found`). `auth.Middleware` does not populate a principal yet, so authenticated endpoints will
  return 401 until the auth module lands.
- Raiffeisen Bank BiH importer: BLOCKED_EXTERNAL (no statement sample).
- Mobile (Phase 3) and desktop/Tauri (Phase 4) not started: DEFERRED_TO_PHASE.
- `docs/api/openapi.yaml` is hand-maintained; TS types in `packages/domain` are not generated from it, so
  drift is possible until a CI check is added.
- OpenAPI lint warnings: operations use a `default` error response instead of explicit 4xx entries; tags lack
  descriptions.
- CI workflow has not yet been executed on GitHub.
- Dev compose `down -v` also removes the shared `finplat_gomod/gobuild/bun` cache volumes (harmless, just
  slower next run). Use `down` without `-v`; reset the dev DB with `docker volume rm finplat-dev_pgdata`.
- `middleware.RealIP` trusts `X-Forwarded-For`; safe only because the API container is reachable solely
  through the gateway (no published port in prod). Do not publish the API port in prod.
