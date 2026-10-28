# Agent Selfhost MCP Compatibility

- Agent Selfhost MCP release `16.9.10-mcp.0` expects `@parly/sdk@16.9.10`
- compatible with Parly core `16.9.9`
- AGENT key model only
- settlement domain: Tempo `4217`
- supported transports: trusted stdio, authenticated stateless HTTP `/mcp` with a separate operator token
- V4/V7 wallet execution and OpenUSD admission are not part of this security patch
- public app surfaces such as Privacy Links, cross-chain deposit payment routes, Verify, payer
  history, receipt downloads, and relayer registration require `PARLY_WEB_API_BASE_URL`
- batch private sends support 1 to 10 same-chain payout lanes
- operational controls are handled in Parly's governed product surfaces
- PoolV3 balance and preparation use deterministic selection with redacted public results
- PoolV2 history remains available in explicit read-only compatibility mode
