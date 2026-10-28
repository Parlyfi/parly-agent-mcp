# Agent Selfhost MCP

Payment tools for developer-operated AI agents, using Parly's V4 private balances
and V7 cross-chain payouts. Supported Tempo assets are USDC.e, USDT0 and
OpenUSD (OUSD); destination assets depend on the active route.

Agent Selfhost MCP runs with your configured agent wallet. For wallet-connected
account tools, choose Parly Hosted MCP at `https://mcp.parly.fi/mcp`, or run
Parly Selfhost MCP on infrastructure you control.

## What this project is

This project packages Agent Selfhost MCP and the SDK modules needed to expose Parly private payment
tools to agent stacks.

## Who this project is for

Use this project for agents that recover private balances, prepare payments and
execute them through a dedicated agent wallet.

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
- `PARLY_CURRENT_SDK_CONFIG_JSON`
- `PARLY_CURRENT_STORAGE_PATH`
- optional MPP adapter flags
- optional app API bridge: `PARLY_WEB_API_BASE_URL`
- optional app API auth: `PARLY_MCP_WEB_API_BEARER_TOKEN`

Configure the current client's verified profile, deployment blocks and pinned
proof assets as described in [COMPATIBILITY.md](./COMPATIBILITY.md).

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

MPP retains its versioned PoolV2 session interface for USDC.e and USDT0. The
current V4/V7 payment tools above use the separate current SDK configuration.

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

`get_private_balance` returns the recovered V4 balance and note count.
`prepare_private_send` selects inputs and returns the amount, fees and change
without exposing note secrets. Single and batch Send use the same current SDK
execution path. V7 routes provide cross-chain quotes, delivery tracking and
eligible refund recovery.

Privacy Link and deposit tools use Parly's admitted payment routes. Existing
versioned recovery remains available for earlier funded notes.

## Resources

- `parly://launch-context`
- `parly://security-notes`

## Operation

Use a dedicated agent wallet and store its credentials on your server. The local
operator controls that wallet; the HTTP operator token authorizes its tools.
Preflight checks prepare a review without submitting a payment. Retain pending
payment records and check their outcome before retrying an interrupted request.

Public API tools use the wallet authorization and permissions required by each
Parly action. Private configuration and note secrets are excluded from tool
responses. See [CHANGELOG.md](./CHANGELOG.md) for version-specific security updates.
