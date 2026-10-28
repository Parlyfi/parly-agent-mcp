# Agent Selfhost MCP

Developer-operated private payment tools, exported to
[`Parlyfi/parly-agent-mcp`](https://github.com/Parlyfi/parly-agent-mcp).
The current runtime uses V4 balances and V7 cross-chain payouts for USDC.e,
USDT0 and OpenUSD (OUSD).

Run locally over stdio or through an authenticated operator HTTP endpoint.
Use a dedicated agent wallet and an operator-controlled TLS proxy for remote
access. See `.env.example` for runtime and transport settings.

For connected account tools, use Parly Hosted MCP at `https://mcp.parly.fi/`,
or run Parly Selfhost MCP on infrastructure you control. The internal package
ID remains `@parly/mcp-server` for existing integrations.
