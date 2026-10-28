# Compatibility

- Package source version: `@parly/sdk@16.9.10`
- Current API: `CurrentParlySDK` from `@parly/sdk/current`
- Current protocol: V4 receiving/private payments and V7 cross-chain payouts
- V4 proof model: Spend60, up to four inputs and ten padded outputs
- Agent interface: Agent Selfhost MCP using the current SDK configuration
- settlement domain: Tempo `4217`
- Current Tempo assets: USDC.e (`1`), USDT0 (`2`) and OpenUSD (OUSD, `3`)
- V7 destination routes explicitly configure token decimals and verified route pins
- MPP sessions retain their versioned PoolV2 interface for assets 1 and 2, with counterparty and spend-limit checks
- batch send supports 1 to 10 same-chain payout lanes
- The versioned `ParlySDK` API retains its earlier funded-note recovery and execution interfaces
- Current execution uses one active writer per wallet; coordinate shared-wallet processes through a process-shared lock
- public balance, preparation, MCP, and MPP responses omit note and recovery internals
