import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { buildParlyMcpRuntime } from "./runtime.js"
import { readOperatorHttpConfig, createOperatorHttpServer } from "./http.js"

async function main() {
  const config = readOperatorHttpConfig(process.env)
  if (config) {
    const server = createOperatorHttpServer(config, () => buildParlyMcpRuntime().server)
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(Error("Agent Selfhost MCP listener failed.")))
      server.listen(config.port, config.host, resolve)
    })
    console.error("Agent Selfhost MCP HTTP listener started with operator authentication.")
    return
  }

  const runtime = buildParlyMcpRuntime()
  await runtime.server.connect(new StdioServerTransport())
  console.error(`Agent Selfhost MCP stdio server ${runtime.adapter ? "started with MPP adapter enabled" : "started"}.`)
}

main().catch(() => {
  console.error("Agent Selfhost MCP startup failed. Check the operator configuration.")
  process.exitCode = 1
})
