# Security policy

## Reporting
Please report vulnerabilities privately to **abdulah@shopcircle.co** (subject "finance-platform security").
Do not open public issues for security problems. Expect an acknowledgement within 7 days.

## Scope and design
- Passwords: Argon2id. Sessions: random tokens stored as SHA-256 hashes; HttpOnly, SameSite=Lax, Secure
  cookies behind TLS; CSRF token required on cookie-authenticated mutations.
- Object-level authorization on every financial resource (`authz.RequireProfile` + `profile_id` filters).
- Parameterized SQL only; no arbitrary SQL via MCP; declarative import templates are never executed as code.
- Uploads: size/type/content validation, no path traversal, decompression and parser limits.
- Secrets only from the environment; logs redact passwords, tokens, auth headers, cookies.
- MCP disabled by default, read-only by default, approvals enforced server-side, full audit log.
- E2EE design: [ADR 0005](docs/architecture/decisions/0005-e2e-encryption.md). Server-readable mode is
  **not** end-to-end encrypted and is labelled as such.
- Containers run as non-root; PostgreSQL is not published; only the gateway port is bound (localhost).
