# Agent Selfhost MCP

Parly supports USDC, USDT and OpenUSD (OUSD). Token availability varies by network.
This package's security release does not add V4/V7 execution or OpenUSD support.
Its versioned agent engine remains separate from the web app's active routes.

Agent Selfhost MCP is the developer-operated product for Parly agent integrations. It is not the new
Parly-operated, keyless OAuth Hosted MCP. HTTP hosting does not change this product's identity.

## What this project is

This project packages Agent Selfhost MCP and the SDK modules needed to expose Parly private payment
tools to agent stacks.

## Who this project is for

Use this project when an agent needs controlled access to Parly private-send tooling. The MCP server
uses AGENT authority only. It is not a relayer runtime and must not be configured with relayer keys.

## Install

```bash
cp .env.example .env
pnpm install
pnpm start
```

By default the server runs over trusted local stdio. The local process can control the configured
agent wallet; do not connect untrusted clients to it.

HTTP is an optional single-operator interface. Set `PORT` and a separate `MCP_HTTP_AUTH_TOKEN`
generated from at least 32 random bytes (base64url, 43-128 characters). Every `/mcp` POST requires
`Authorization: Bearer <operator token>`. Tokens in URLs are rejected. Binding defaults to
`127.0.0.1`; `/health` reports liveness only. HTTP is stateless: each authenticated POST has its own
transport; GET/SSE sessions are not supported.
Up to four requests can remain active. Disconnecting does not undo a wallet operation or free its
slot before it finishes; check transaction activity before retrying. A stuck operation needs an
operator investigation, not repeated client retries.

Remote access additionally requires `MCP_HTTP_HOST=0.0.0.0` (or `::`) and
`MCP_HTTP_PUBLIC_ORIGIN=https://your-operator-host`. You must terminate TLS at an operator-controlled
reverse proxy and prevent direct access to the plain-HTTP listener. The setting does not create TLS.
Preserve the configured Host and do not allow other origins. The operator token authorizes wallet
operations, including sends; it is not an individual customer's login. Never expose this service as
a shared consumer endpoint. Rotate the HTTP token by changing it and restarting the process; do not
reuse the wallet key or the separate outbound API token.

## Configuration

- `AGENT_PRIVATE_KEY`
- `MCP_TEMPO_PROFILE=phase3-tempo4217`
- `TEMPO_RPC_URL`
- `TEMPO_CHAIN_ID=4217`
- `SETTLEMENT_DOMAIN_ID=4217`
- `PONDER_GRAPHQL_URL`
- `PARLY_SDK_ASSETS_PATH`
- optional MPP adapter flags
- optional app API bridge: `PARLY_WEB_API_BASE_URL`
- optional app API auth: `PARLY_MCP_WEB_API_BEARER_TOKEN`

Public exports intentionally omit proving keys. Configure `PARLY_SDK_ASSETS_PATH` if your proof
assets live outside the package tree.

## Supported tools

Private balance tools:

- `recover_largest_note`
- `get_private_balance`
- `prepare_private_send`
- `preflight_shielded_payment`
- `send_shielded_payment`
- `preflight_batch_shielded_payment`
- `send_batch_shielded_payment`
- `execute_shielded_payment`

MPP tools:

- `mpp_create_session`
- `mpp_preflight_session_payment`
- `mpp_settle_session_payment`

App API tools, when `PARLY_WEB_API_BASE_URL` is configured:

- Privacy Links status, public read, owner list, claim, publish, visibility, reports, and social status
- cross-chain deposit route creation or quote, payment status, payer history, payout status, refund
  claim, short-lived receipt download URLs, and invoice receipt verification
- public relayer list and relayer registration helpers

`execute_shielded_payment` is a compatibility alias. New integrations should use
`send_shielded_payment`.

`get_private_balance` returns six-decimal PoolV3 base-unit totals, note count, immediately
spendable balance, and whether consolidation is required. `prepare_private_send` uses deterministic
note selection and returns a redacted plan. Historical PoolV2 reads remain available, but PoolV2
notes are never mixed into a PoolV3 plan.

Deposit and Privacy Link routes use the active pool version returned by Parly. PoolV3 activates only
after both supported asset routes are configured. An incomplete route stops before payment
authorization and never silently falls back to PoolV2. Connected-wallet deposits, one-time deposit
addresses, and Privacy Links shield the exact principal; existing PoolV2 records remain available
for recovery and review.

## Resources

- `parly://launch-context`
- `parly://security-notes`

## Security notes

- Version 16.9.10 removes private launch configuration from SDK/MCP resources and bounds HTTP/API
  inputs and outputs. Upgrade both packages. If an older service was reachable by untrusted users,
  treat its agent key and configured credentials as potentially exposed. Contain it and review key
  rotation and funded-note recovery before using it again; this patch does not revoke old keys.
- MCP uses AGENT key authority only.
- Relayer keys do not belong in this project.
- Privacy Links, Verify, payment routes, and relayer registration are public web/API product
  surfaces. MCP can call those APIs when configured, but it does not bypass wallet signatures,
  rate limits, 403 policy checks, or audit history.
- This package exposes user, payer, and relayer-facing payment flows. Operational controls stay in
  Parly's governed product surfaces.
- Batch private sends are currently available on the same chain. Cross-chain deposits use Parly
  payment routes. Cross-chain private sends become available through MCP when a supported public
  payout route is active.
- MPP session tools are available through both the SDK and MCP.
- Preflight tools do not generate proofs, request signatures, or submit transactions.
- MCP responses redact known private configuration, reject sensitive key fields and return generic
  dependency errors. This is not a sandbox for untrusted plugins or arbitrary third-party payloads.
- This security repair does not migrate the developer wallet engine to V4/V7 or add OpenUSD. Its
  legacy execution/planning support is separate from the current web application's active routes;
  qualify a route before funding it. Do not infer compatibility from the app API bridge.
