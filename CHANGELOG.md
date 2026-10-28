# Agent Selfhost MCP Changelog

## 16.9.10-mcp.0

- Name this developer-operated product Agent Selfhost MCP, distinct from the new Hosted MCP.

- Authenticate operator HTTP calls before wallet creation; bind locally by default.
- Isolate stateless request transports and bound request/response sizes and deadlines.
- Redact launch configuration, dependency errors and unexpected private tool fields.
- Reject cross-origin API redirects; distinguish operator auth from outbound credentials.
- Test security behavior in the generated standalone export.

## 16.9.9-mcp.0

- publishes the Phase 3 MCP surface for Parly agent integrations
- adds `preflight_shielded_payment` and `send_shielded_payment` while keeping
  `execute_shielded_payment` as a compatibility alias
- adds same-chain batch private-send preflight and send tools
- adds MPP session preflight before proof generation or transaction submission
- adds optional public web API-backed tools for Privacy Links, cross-chain deposit routes, Verify,
  payer history, receipt downloads, and relayer flows
- adds redacted PoolV3 private-balance and deterministic send-preparation tools
- preserves PoolV2 history without exposing note or recovery internals
- supports stdio and HTTP `/mcp` transports
- keeps AGENT-only execution semantics
