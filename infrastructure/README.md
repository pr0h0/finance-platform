# Infrastructure

- `docker/` — Dockerfiles and nginx configs (api, web, gateway).
- Migrations live in **`apps/api/migrations/`** (single location, embedded into the API binary).
- Compose files are at the repo root (`docker-compose.yml`, `docker-compose.dev.yml`).
