# @parly/sdk

TypeScript SDK for Parly private stablecoin payments on Tempo.

The SDK helps agent and server integrations recover private notes, prepare proofs, and send from a
Parly private balance. It supports the two Phase 3 asset lanes:

- `assetId: 1` - Tempo USDC.e
- `assetId: 2` - Tempo USDT0

## Core APIs

- `ParlySDK.fromEnv()` creates an SDK client from server-side environment variables.
- `getPrivateBalance(params)` returns six-decimal PoolV3 base-unit totals, note count, and the
  consolidation requirement.
- `preparePrivateSend(params)` automatically selects the deterministic PoolV3 input set and returns
  one redacted spend or consolidation summary.
- `recoverLargestNote(assetId, poolAddress)` remains available for historical PoolV2 recovery.
- `sendShieldedPayment(params)` sends from a recovered private note.
- `sendShieldedBatchPayment(params)` sends up to 10 same-chain private payout lanes from one note.
- `executeShieldedPayment(params)` remains as a compatibility alias for older integrations.
- `ParlyMppAdapter` adds MPP session creation, preflight, and settlement helpers at the SDK boundary.

## MPP support

MPP support is intentionally narrow. It does not change pool semantics or give an agent relayer
authority. Use:

- `createSession()` to create a bounded payment session.
- `preflightSessionPayment()` to validate session ID, counterparty, amount, asset, destination, and
  spend limit before proof work.
- `settleFromSession()` to execute the payment through the same SDK path as `sendShieldedPayment()`.
- `preflightPoolV3SessionPayment()` to add a redacted PoolV3 balance plan without returning note
  identifiers or proof material.

PoolV3 preparation never returns note secrets, commitments, nullifiers, Merkle paths, or recovery
keys. PoolV2 history remains readable for recovery, but it is not mixed into PoolV3 selection.

## Environment

Use server-only variables for SDK execution:

- `AGENT_PRIVATE_KEY`
- `TEMPO_RPC_URL`
- `TEMPO_CHAIN_ID=4217`
- `SETTLEMENT_DOMAIN_ID=4217`
- `PONDER_GRAPHQL_URL`
- `PARLY_SDK_ASSETS_PATH`

Provider credentials, Relay keys, and private keys must stay server-side. Do not expose them through
`NEXT_PUBLIC_*` variables.

Cross-chain deposits are served by the Parly payment-route APIs. Cross-chain private sends are not
enabled in this SDK path until the dedicated payout route is exposed through the public API.

## Proof assets

Public package exports intentionally omit proving keys. Point `PARLY_SDK_ASSETS_PATH` at a trusted
local proof-assets directory containing:

- `joinsplit.wasm`
- `joinsplit_final.zkey`
