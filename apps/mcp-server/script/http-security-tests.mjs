import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { request } from "node:http"
import test from "node:test"
import ts from "typescript"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

const require = createRequire(import.meta.url)
const source = new URL("../src/http.ts", import.meta.url)
assert.ok(existsSync(source), "Developer HTTP must authenticate before runtime/transport creation")
const module = { exports: {} }
new Function("require", "module", "exports", ts.transpileModule(readFileSync(source, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText)(require, module, module.exports)
const { readOperatorHttpConfig, createOperatorHttpServer } = module.exports
const token = "synthetic-operator-token-" + "a".repeat(43)
const env = { PORT: "8181", MCP_HTTP_AUTH_TOKEN: token }
const rpc = (method, id = 1, params) => JSON.stringify({ jsonrpc: "2.0", method, id, ...(params ? { params } : {}) })
const initialize = rpc("initialize", 1, { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "security-test", version: "1" } })

async function fixture(t, overrides = {}, fail = false, work = async () => {}) {
  let runtimes = 0, sends = 0
  const config = readOperatorHttpConfig({ ...env, ...overrides })
  const server = createOperatorHttpServer(config, () => {
    runtimes++
    if (fail) throw Error("synthetic-private-key-must-not-escape")
    const mcp = new McpServer({ name: "synthetic-operator", version: "1" })
    mcp.registerTool("send_shielded_payment", { inputSchema: {} }, async () => {
      sends++
      await work()
      return { content: [{ type: "text", text: "synthetic operator send" }] }
    })
    return mcp
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const call = (body = initialize, headers = {}, method = "POST", path = "/mcp") => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: server.address().port, method, path,
      headers: { host: "127.0.0.1:8181", accept: "application/json, text/event-stream", "content-type": "application/json", authorization: "Bearer " + token, ...headers } }, res => {
      let text = ""; res.on("data", b => { text += b }); res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers }))
    })
    req.on("error", reject); req.end(body)
  })
  return { call, server, get runtimes() { return runtimes }, get sends() { return sends } }
}

test("stdio remains the default; HTTP missing/weak/reused auth and unsafe remote config fail closed", () => {
  assert.equal(readOperatorHttpConfig({}), null)
  for (const input of [{ PORT: "8181" }, { ...env, PORT: "bad" }, { ...env, MCP_HTTP_AUTH_TOKEN: "short" },
    { ...env, PARLY_MCP_WEB_API_BEARER_TOKEN: token }, { ...env, AGENT_PRIVATE_KEY: token },
    { ...env, MCP_HTTP_HOST: "0.0.0.0" }, { ...env, MCP_HTTP_HOST: "0.0.0.0", MCP_HTTP_PUBLIC_ORIGIN: "http://mcp.example" },
    { ...env, MCP_HTTP_PUBLIC_ORIGIN: "https://user:secret@mcp.example" }]) assert.throws(() => readOperatorHttpConfig(input))
  assert.equal(readOperatorHttpConfig(env).host, "127.0.0.1")
  assert.equal(readOperatorHttpConfig({ ...env, MCP_HTTP_HOST: "0.0.0.0", MCP_HTTP_PUBLIC_ORIGIN: "https://mcp.example" }).host, "0.0.0.0")
})

test("every MCP request authenticates before runtime creation, including reads, sends and invalid JSON", async t => {
  const x = await fixture(t)
  for (const body of [initialize, rpc("resources/list"), rpc("tools/list"), rpc("tools/call", 2, { name: "send_shielded_payment", arguments: {} }), "not-json"]) {
    assert.equal((await x.call(body, { authorization: "" })).status, 401)
    assert.equal((await x.call(body, { authorization: "Bearer wrong" })).status, 401)
  }
  assert.equal((await x.call("", { authorization: "" }, "GET")).status, 401)
  assert.equal((await x.call("", { authorization: "" }, "DELETE")).status, 401)
  assert.equal(x.runtimes, 0); assert.equal(x.sends, 0)
})

test("Host, Origin, query tokens and cross-site requests cannot bypass operator auth", async t => {
  const x = await fixture(t)
  for (const headers of [{ host: "evil.example" }, { origin: "https://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await x.call(initialize, headers)).status, 403)
  }
  assert.equal((await x.call(initialize, {}, "POST", "/mcp?access_token=" + token)).status, 403)
  assert.equal(x.runtimes, 0)
})

test("authenticated repeated/concurrent calls use fresh transports; operator sends still reach their handler", async t => {
  const x = await fixture(t)
  for (let i = 0; i < 2; i++) assert.equal((await x.call()).status, 200)
  const a = x.call(rpc("tools/list")), b = x.call(rpc("tools/list", 2))
  assert.equal((await a).status, 200); assert.equal((await b).status, 200)
  const result = await x.call(rpc("tools/call", 3, { name: "send_shielded_payment", arguments: {} }))
  assert.equal(result.status, 200); assert.match(result.text, /synthetic operator send/)
  assert.equal(x.sends, 1)
  assert.equal((await x.call(initialize, { authorization: "" })).status, 401)
  assert.equal((await x.call("", {}, "GET")).status, 405)
})

test("a replaced operator token invalidates the old token; outbound web token is not inbound auth", async t => {
  const changed = token + "b", x = await fixture(t, { MCP_HTTP_AUTH_TOKEN: changed, PARLY_MCP_WEB_API_BEARER_TOKEN: "different-synthetic-outbound" })
  assert.equal((await x.call()).status, 401)
  assert.equal((await x.call(initialize, { authorization: "Bearer different-synthetic-outbound" })).status, 401)
  assert.equal((await x.call(initialize, { authorization: "Bearer " + changed })).status, 200)
})

test("large/malformed bodies and runtime errors return bounded generic errors with no secret echo", async t => {
  const x = await fixture(t)
  assert.equal((await x.call(" ".repeat(262145))).status, 413)
  assert.equal((await x.call("not-json")).status, 400)
  assert.equal(x.runtimes, 0)
  const broken = await fixture(t, {}, true), result = await broken.call()
  assert.equal(result.status, 500); assert.doesNotMatch(result.text, /synthetic-private-key/)
  assert.equal((await x.call("", { authorization: "" }, "GET", "/health")).status, 200)
})

test("unfinished authenticated bodies time out before any wallet/runtime is created", async t => {
  const x = await fixture(t)
  const status = await new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: x.server.address().port, method: "POST", path: "/mcp",
      headers: { host: "127.0.0.1:8181", authorization: "Bearer " + token, "content-type": "application/json" } }, res => {
      res.resume(); res.once("end", () => { resolve(res.statusCode); req.destroy() })
    })
    req.once("error", reject); req.flushHeaders(); req.write("{")
  })
  assert.equal(status, 408); assert.equal(x.runtimes, 0)
})

test("disconnected wallet operations retain admission slots until the handlers settle", async t => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const x = await fixture(t, {}, false, () => pending)
  const requests = []
  t.after(() => { release(); requests.forEach(r => r.destroy()) })
  for (let i = 0; i < 4; i++) {
    const req = request({ hostname: "127.0.0.1", port: x.server.address().port, method: "POST", path: "/mcp",
      headers: { host: "127.0.0.1:8181", accept: "application/json, text/event-stream", "content-type": "application/json", authorization: "Bearer " + token } })
    req.on("error", () => {})
    req.end(rpc("tools/call", i + 1, { name: "send_shielded_payment", arguments: {} }))
    requests.push(req)
  }
  const deadline = Date.now() + 3000
  while (x.sends < 4 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(x.sends, 4)
  requests.forEach(r => r.destroy())
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await x.call()).status, 429)
  assert.equal(x.sends, 4)
  release()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await x.call()).status, 200)
})
