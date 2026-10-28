import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import ts from "typescript"
import { z } from "zod"

const runtimeSource = readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8")
const syntheticConfig = {
  agentPrivateKey: `0x${"11".repeat(32)}`,
  tempoRpcUrl: "https://rpc.invalid/synthetic-rpc-secret",
  tempoChainId: 4217,
  settlementDomainId: 4217,
  tempoProfile: "phase3-tempo4217",
  ponderGraphqlUrl: "https://indexer.invalid/synthetic-indexer-secret",
  proofAssetsBasePath: "synthetic-private-assets-path",
  enableMppAdapter: true,
  mppServiceName: "test-service",
  mppServiceVersion: "1",
  webApiBaseUrl: "https://web.invalid/synthetic-web-secret",
  webApiBearerToken: "synthetic-outbound-bearer-secret",
  currentSdkConfig: { profile: { chainId: 4217, settlementDomain: "4217" } }, currentStoragePath: "C:/synthetic-pending.json"
}

function isolatedRuntime(options = {}) {
  let serverInfo
  const resources = new Map()
  const tools = new Map()
  const success = { kind: "success", hash: `0x${"22".repeat(32)}` }
  // Replace dependencies before evaluation so dotenv, wallets, and network clients never load.
  class SyntheticSdk {
    constructor(config) { this.config = config }
    getLaunchContext() {
      return { ...this.config, nestedConfig: { key: syntheticConfig.agentPrivateKey } }
    }
    async recoverLargestNote() { return { best: { amount: 1_000_000n, noteSecret: syntheticConfig.agentPrivateKey } } }
    async getPrivateBalance() { if (options.error) throw Error(options.error); return options.payload ?? { totalAmount: "1000000", noteCount: 1 } }
    async preparePrivateSend() { return { status: "ready", totalRequired: "1000000" } }
    async preparePrivateBatchSend() { return { status: "ready", totalRequired: "1000000" } }
    async sendShieldedPayment() { return options.outcome ?? success }
    async sendShieldedBatchPayment() { return success }
    async sendCrossChainShieldedPayment() {
      return { kind: "relayer_submitted", payoutId: "synthetic-payout", supportReference: "synthetic-support",
        statusAccessToken: "synthetic-status-token", recovery: { key: syntheticConfig.agentPrivateKey } }
    }
    async getCrossChainPayoutStatus() { return { authorized: true, children: [] } }
    async claimPayoutV7Refund() { return [] }
  }
  class SyntheticMpp {
    async createSession(args) { return { ...args, version: 1, status: "created" } }
    async settleFromSession() { return success }
    preflightSessionPayment() { return { ok: true } }
    async preflightPoolV3SessionPayment() { return { ok: true } }
  }
  class ResourceCaptureServer {
    constructor(info) { serverInfo = info }
    registerTool(name, metadata, handler) { tools.set(name, { metadata, handler }) }
    registerResource(_name, uri, _metadata, handler) { resources.set(uri, handler) }
  }
  const dependencies = {
    "@modelcontextprotocol/sdk/server/mcp.js": { McpServer: ResourceCaptureServer },
    "@parly/sdk": { ParlySDK: SyntheticSdk, ParlyMppAdapter: SyntheticMpp },
    "@parly/sdk/current": { parseReceivingProfileV4: raw => { const p = JSON.parse(raw); return { ...p, settlementDomain: BigInt(p.settlementDomain) } }, CurrentParlySDK: class extends SyntheticSdk {
      async getPrivateBalance(args) { options.calls?.push(["balance", args]); return super.getPrivateBalance(args) }
      async preparePrivateSend(args) { options.calls?.push(["prepare", args]); return super.preparePrivateSend(args) }
      async sendShieldedPayment(args) { options.calls?.push(["single", args]); return super.sendShieldedPayment(args) }
      async sendShieldedBatchPayment(args) { options.calls?.push(["batch", args]); return super.sendShieldedBatchPayment(args) }
      async sendCrossChainShieldedPayment(args) { options.calls?.push(["v7", args]); return { kind: "relayer_submitted", manifestHash: "synthetic-manifest", children: [] } }
    } },
    "./current-storage.js": { createCurrentStorage: () => ({ withExclusiveExecution: operation => operation() }) },
    zod: { z },
    "./smoke-config.js": { assertMcpConfig: () => ({ ...syntheticConfig, ...(options.noCurrent ? { currentSdkConfig: undefined } : {}), ...(options.profile ? { currentSdkConfig: { profile: options.profile } } : {}) }) },
    "./web-api-client.js": { ParlyWebApiClient: class {
      async getJson() { return options.webPayload ?? { ok: true } }
      async postJson() { return options.webPayload ?? { ok: true } }
    } }
  }
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(runtimeSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    module,
    exports: module.exports,
    process: { env: {} },
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
      return dependencies[name]
    }
  }, { filename: "isolated-mcp-runtime.cjs" })
  module.exports.buildParlyMcpRuntime({})
  return { resources, tools, serverInfo }
}

test("operator runtime identifies itself as Agent Selfhost MCP, not Parly Hosted MCP", () => {
  const { serverInfo } = isolatedRuntime()
  assert.equal(serverInfo.title, "Agent Selfhost MCP")
  assert.equal(serverInfo.name, "parly-mcp", "Preserve the existing protocol identifier")
})

test("current balance, preparation, single, batch and V7 route all admitted assets through the current SDK", async () => {
  const calls = [], { tools } = isolatedRuntime({ calls }), address = `0x${"33".repeat(20)}`
  for (const assetId of [1, 2, 3]) {
    const balance = { assetId, poolAddress: address, poolVersion: 4 }
    for (const [name, args] of [
      ["get_private_balance", balance], ["prepare_private_send", { ...balance, amount: "1" }],
      ["send_shielded_payment", { ...balance, destination: address, destinationEid: 4217, amount: "1" }],
      ["send_batch_shielded_payment", { ...balance, outputs: [{ destination: address, destinationEid: 4217, amount: "1" }] }],
      ["send_cross_chain_shielded_payment", { ...balance, destinationChainId: 10, destinationToken: address, destinationRecipient: address, amount: "1" }]
    ]) {
      assert.equal(tools.get(name).metadata.inputSchema.safeParse(args).success, true, name)
      assert.notEqual((await tools.get(name).handler(args)).isError, true, name)
    }
  }
  assert.deepEqual(calls.map(([name]) => name), Array.from({ length: 3 }, () => ["balance", "prepare", "single", "batch", "v7"]).flat())
})

test("current routes never fall back when the current SDK profile is unavailable", async () => {
  const { tools } = isolatedRuntime({ noCurrent: true }), address = `0x${"33".repeat(20)}`
  const result = await tools.get("send_shielded_payment").handler({ assetId: 3, poolVersion: 4, poolAddress: address, destination: address, destinationEid: 4217, amount: "1" })
  assert.equal(result.isError, true)
})

test("incompatible current profile fails before tool registration and OpenUSD cannot enter historical execution", async () => {
  assert.throws(() => isolatedRuntime({ profile: { chainId: 42431, settlementDomain: "40439" } }), /native domain/)
  const { tools } = isolatedRuntime(), address = `0x${"33".repeat(20)}`
  assert.equal(tools.get("send_shielded_payment").metadata.inputSchema.parse({ assetId: 1, poolAddress: address, destination: address, amount: "1", destinationEid: 4217 }).poolVersion, 4)
  const legacy = await tools.get("send_shielded_payment").handler({ assetId: 3, poolVersion: 2, poolAddress: address, destination: address, amount: "1", destinationEid: 4217 })
  assert.equal(legacy.isError, true)
  const csv = await tools.get("parse_batch_csv").handler({ csv: `${address},1.25,OUSD` })
  assert.notEqual(csv.isError, true)
})

test("all public MCP resources exclude synthetic runtime credentials and private configuration", async () => {
  const { resources } = isolatedRuntime()
  assert.equal(resources.size, 2)
  for (const [uri, read] of resources) {
    const response = await read()
    const serialized = JSON.stringify(response)
    for (const secret of [
      syntheticConfig.agentPrivateKey,
      syntheticConfig.tempoRpcUrl,
      syntheticConfig.ponderGraphqlUrl,
      syntheticConfig.proofAssetsBasePath,
      syntheticConfig.webApiBaseUrl,
      syntheticConfig.webApiBearerToken
    ]) {
      assert.equal(serialized.includes(secret), false, `${uri} exposed synthetic private configuration`)
    }
    if (uri === "parly://launch-context") {
      const context = JSON.parse(response.contents[0].text)
      assert.equal(context.tempoChainId, 4217)
      assert.equal(context.tempoLzEid, 4217)
      assert.equal(context.mppAdapterEnabled, true)
      assert.equal(context.webApiEnabled, true)
      assert.ok(context.supportedTools.includes("send_shielded_payment"))
      assert.ok(context.webApiTools.includes("create_profile_link"))
    }
  }
})

test("registered tool metadata and synthetic successful tool outputs do not serialize the agent key", async () => {
  const { tools } = isolatedRuntime()
  const address = `0x${"33".repeat(20)}`
  const balance = { assetId: 1, poolAddress: address }
  const payment = { ...balance, amount: "1", destination: address, destinationEid: 4217 }
  const batch = { ...balance, outputs: [{ destination: address, amount: "1", destinationEid: 4217 }] }
  const session = { ...balance, sessionId: "synthetic-session", counterparty: address,
    spendLimit: "2", destinationEid: 4217, version: 1, protocol: "parly",
    settlementMode: "parly-private-immediate", serviceName: "test-service", serviceVersion: "1", status: "created" }
  const inputs = {
    recover_largest_note: { assetId: 1 },
    get_private_balance: balance,
    prepare_private_send: { ...balance, amount: "1" },
    preflight_shielded_payment: { ...payment, poolVersion: 3 },
    send_shielded_payment: payment,
    preflight_batch_shielded_payment: batch,
    send_batch_shielded_payment: batch,
    send_cross_chain_shielded_payment: { ...balance, destinationChainId: 10,
      destinationToken: address, destinationRecipient: address, amount: "1" },
    execute_shielded_payment: payment,
    get_cross_chain_payout_status: { manifestHash: `0x${"55".repeat(32)}` },
    claim_cross_chain_payout_refund: { manifestHash: `0x${"55".repeat(32)}` },
    mpp_create_session: session,
    mpp_preflight_session_payment: { session, destination: address, amount: "1", poolVersion: 3 },
    mpp_settle_session_payment: { session, destination: address, amount: "1" },
    parse_batch_csv: { csv: `${address},1,USDC` }
  }
  assert.equal(tools.size, 46)
  for (const [name, { metadata, handler }] of tools) {
    const input = inputs[name] ?? { body: {}, query: {} }
    const response = await handler(input)
    assert.notEqual(response.isError, true, `${name} did not exercise its successful response`)
    assert.equal(JSON.stringify({ metadata, response }).includes(syntheticConfig.agentPrivateKey), false,
      `${name} exposed the synthetic configured agent key`)
  }
})

test("dependency errors never echo configured credentials or credential-bearing endpoints", async () => {
  const { tools } = isolatedRuntime({ error: syntheticConfig.agentPrivateKey + " " + syntheticConfig.tempoRpcUrl })
  const result = await tools.get("get_private_balance").handler({ assetId: 1, poolAddress: `0x${"33".repeat(20)}` })
  assert.equal(result.isError, true)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-rpc-secret|111111111111111111111111/)
})

test("unexpected private fields and configured secrets fail closed in SDK and upstream web responses", async () => {
  for (const payload of [{ privateKeyHex: "synthetic-unrelated-secret" }, { nested: { viewScalar: "123456" } }, { data: syntheticConfig.webApiBearerToken },
    { recoveryPrivateKeyB64: "synthetic-unrelated-secret" }, { privateKeyB64: "synthetic-unrelated-secret" }, { nested: { rho: "123456" } }, { refundSalts: ["synthetic-unrelated-secret"] }]) {
    const { tools } = isolatedRuntime({ payload, webPayload: payload })
    for (const [name, input] of [["get_private_balance", { assetId: 1, poolAddress: `0x${"33".repeat(20)}` }], ["privacy_link_status", { query: {} }]]) {
      const result = await tools.get(name).handler(input)
      assert.equal(result.isError, true, name + " must reject secret-bearing output")
      assert.doesNotMatch(JSON.stringify(result), /synthetic-unrelated-secret|123456|synthetic-outbound-bearer-secret/)
    }
  }
})

test("payment outcomes expose only safe status/hash fields, never future fields or private persistence paths", async () => {
  const { tools } = isolatedRuntime({ outcome: { kind: "pending_confirmation", hash: `0x${"22".repeat(32)}`, message: "private upstream error", persistedTo: "synthetic-private-assets-path", futureCredential: "unexpected-output" } })
  const result = await tools.get("send_shielded_payment").handler({ assetId: 1, poolAddress: `0x${"33".repeat(20)}`, destination: `0x${"44".repeat(20)}`, amount: "1", destinationEid: 4217 })
  assert.notEqual(result.isError, true)
  const payload = JSON.parse(result.content[0].text).outcome
  assert.equal(payload.kind, "pending_confirmation"); assert.equal(payload.persistedLocally, true)
  assert.doesNotMatch(JSON.stringify(result), /private upstream error|synthetic-private-assets-path|futureCredential|unexpected-output/)
})

function initializeRequest() {
  return new Request("http://mcp.invalid/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "isolated-test", version: "1" } }
    })
  })
}

async function minimalTransport(t) {
  const server = new McpServer({ name: "isolated-transport-test", version: "1" })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  t.after(() => server.close())
  return transport
}

test("installed SDK rejects reuse of the application's stateless transport topology", async (t) => {
  const transport = await minimalTransport(t)
  const response = await transport.handleRequest(initializeRequest())
  assert.equal(response.status, 200)
  assert.match(await response.text(), /"protocolVersion"/u)
  await assert.rejects(transport.handleRequest(initializeRequest()), /Stateless transport cannot be reused/u)
})

test("a GET without Accept consumes the shared stateless transport before initialization", async (t) => {
  const transport = await minimalTransport(t)
  const response = await transport.handleRequest(new Request("http://mcp.invalid/mcp"))
  assert.equal(response.status, 406)
  await response.text()
  await assert.rejects(transport.handleRequest(initializeRequest()), /Stateless transport cannot be reused/u)
})

test("independent stateless transports initialize independently without wallets or network access", async (t) => {
  for (let index = 0; index < 2; index++) {
    const transport = await minimalTransport(t)
    const response = await transport.handleRequest(initializeRequest())
    assert.equal(response.status, 200)
    assert.match(await response.text(), /"protocolVersion"/u)
  }
})
