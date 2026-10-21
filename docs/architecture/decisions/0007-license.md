# 0007 — License

Status: accepted (Phase 0)

## Decision
**AGPL-3.0-only** for the whole repository.

## Trade-offs
- AGPL: anyone running a modified server for others must publish their changes — fits a self-hosted,
  privacy-focused product and prevents closed SaaS forks. Downsides: some companies avoid AGPL
  contributions/dependencies; app-store distribution of mobile builds needs care (AGPL is generally
  compatible when source is offered).
- MIT/Apache-2.0: maximal adoption, permits closed forks. Rejected for the application.

Community importer templates (JSON data) are contributed under the same license. If third-party reuse of
`packages/importer-sdk` or `packages/mcp-contracts` becomes important, those packages can be relicensed
to Apache-2.0 by the copyright holders (requires contributor agreement — decide before accepting outside
contributions).
