# Parly Unhosted MCP

This is the developer-operated, agent-wallet MCP runtime exported to
`Parlyfi/parly-mcp`. It is **not** the new Parly-operated, keyless OAuth Hosted MCP.
Running Unhosted MCP on a server does not turn it into the Hosted MCP product.

Trusted local stdio and authenticated single-operator HTTP retain the operator's
agent-wallet authority. Never share that wallet/token as a multi-user service.
Remote HTTP requires an operator-controlled TLS proxy and restricted listener.
See `.env.example` for the optional HTTP settings.

The package ID `@parly/mcp-server`, protocol ID `parly-mcp`, export directory and
repository URL stay unchanged for existing integrations. Human-facing product
names and connection titles use **Unhosted MCP**.
