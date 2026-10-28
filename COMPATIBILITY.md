# Agent Selfhost MCP Compatibility

- Agent Selfhost MCP release `16.9.10-mcp.0` expects `@parly/sdk@16.9.10`
- compatible with Parly core `16.9.9`
- AGENT key model only
- settlement domain: Tempo `4217`
- supported transports: trusted stdio, authenticated stateless HTTP `/mcp` with a separate operator token
- Current execution: V4 recovery and private payments, V7 cross-chain payouts
- Tempo assets: USDC.e (`1`), USDT0 (`2`) and OpenUSD (OUSD, `3`)
- `PARLY_CURRENT_SDK_CONFIG_JSON`: current profile, origin/environment, deployment blocks, wallet-recovery context, reward-policy/V7 pins, selected relayer and destination routes/decimals
- `PARLY_CURRENT_STORAGE_PATH`: absolute file path in an existing private directory; persist it across restarts and use the same file for each process sharing the wallet
- `PARLY_SDK_ASSETS_PATH`: directory containing the pinned current proof artifacts
- MPP retains its versioned PoolV2 interface for USDC.e and USDT0
- public app surfaces such as Privacy Links, cross-chain deposit payment routes, Verify, payer
  history, receipt downloads, and relayer registration require `PARLY_WEB_API_BASE_URL`
- batch private sends support 1 to 10 same-chain payout lanes
- operational controls are handled in Parly's governed product surfaces
- V4 balance and preparation use complete verified history and return redacted summaries
- Earlier funded notes retain their explicit versioned recovery path
