# @parly/sdk

TypeScript SDK for private stablecoin payments with V4 balances and V7 cross-chain payouts.

Current Tempo assets:

- `assetId: 1` - Tempo USDC.e
- `assetId: 2` - Tempo USDT0
- `assetId: 3` - OpenUSD (OUSD)

## Current API

Import `CurrentParlySDK` from `@parly/sdk/current` for current integrations.

- `getPrivateBalance()` recovers the V4 balance from verified canonical history.
- `preparePrivateSend()` selects inputs and returns the amount, fees and change.
- `sendShieldedPayment()` sends to one same-chain recipient.
- `sendShieldedBatchPayment()` sends to up to ten same-chain recipients.
- `sendCrossChainShieldedPayment()` uses a V7 cross-chain payout route.
- V7 quote, authorization, status and refund helpers expose the payout lifecycle.

Configure the client with its execution wallet, RPC, verified V4 profile, deployment
blocks, history endpoint, proof assets and V7 pins. The recovery context preserves
the existing wallet-derived keys. Retain pending records using the storage
interface so interrupted submissions can be reconciled.

Use one active writer per execution wallet. Coordinate writes with a process-shared
lock if several processes share that wallet. Agent Selfhost MCP supplies this
coordination for its HTTP runtime.

## Versioned integrations

The existing `ParlySDK` API remains available for earlier pool integrations.
Its `ParlyMppAdapter` provides session creation, preflight and settlement with
counterparty and spend-limit checks:

- `createSession()` to create a bounded payment session.
- `preflightSessionPayment()` to validate session ID, counterparty, amount, asset, destination, and
  spend limit before proof work.
- `settleFromSession()` to execute the payment through the same SDK path as `sendShieldedPayment()`.
- `preflightPoolV3SessionPayment()` to add a redacted PoolV3 balance plan without returning note
  identifiers or proof material.

Use the current client for V4 notes and the explicit versioned API for earlier
funded notes. Public balance and preparation summaries omit note secrets.

## Server configuration

Use server-only variables for SDK execution:

- `AGENT_PRIVATE_KEY`
- `TEMPO_RPC_URL`
- `TEMPO_CHAIN_ID=4217`
- `SETTLEMENT_DOMAIN_ID=4217`
- `PONDER_GRAPHQL_URL`
- `PARLY_SDK_ASSETS_PATH`

Store signing and provider credentials in server-side secret settings. Cross-chain
destination support follows the admitted V7 route; token availability varies by
network.

## Proof assets

The current client uses the pinned V4 proof artifacts. The versioned client uses
its configured `joinsplit.wasm` and `joinsplit_final.zkey`. Select proof assets for
the client and circuit version you are using.

After building, run `pnpm run sync:proof-assets` in this package to verify the
current files in `assets/`. Use `--source <verified-directory>` for a local copy,
or explicitly pass `--download` to fetch the pinned files from Parly. Point
`proofAssetsBasePath` at this package's assets directory.
