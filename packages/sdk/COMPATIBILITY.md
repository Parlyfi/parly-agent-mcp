# Compatibility

- `@parly/sdk@16.9.9` targets Parly core `16.9.9`
- proof model: `joinsplit-10-output-v16.9.9`
- agent-surface compatibility: `16.9.9-mcp.0`
- settlement domain: Tempo `4217`
- asset lanes: USDC.e (`assetId: 1`) and USDT0 (`assetId: 2`)
- MPP sessions are counterparty-locked and spend-limit checked before settlement
- batch send supports 1 to 10 same-chain payout lanes
- PoolV3 balance and preparation use deterministic selection across up to four notes
- PoolV2 history remains available in explicit read-only compatibility mode
- public balance, preparation, MCP, and MPP responses omit note and recovery internals
