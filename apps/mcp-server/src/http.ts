import { createHash, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"

type HttpConfig = { port: number; host: string; token: string; publicOrigin?: string }
const loopback = new Set(["127.0.0.1", "localhost", "::1"])

export function readOperatorHttpConfig(env: NodeJS.ProcessEnv): HttpConfig | null {
  if (!env.PORT) return null
  if (!/^[1-9][0-9]{0,4}$/.test(env.PORT) || Number(env.PORT) > 65535) throw Error("Invalid Agent Selfhost MCP HTTP port.")
  const token = env.MCP_HTTP_AUTH_TOKEN || "", host = env.MCP_HTTP_HOST || "127.0.0.1"
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token) || [env.AGENT_PRIVATE_KEY, env.PARLY_MCP_WEB_API_BEARER_TOKEN].some(v => v && v.replace(/^0x/, "") === token.replace(/^0x/, ""))) throw Error("Developer HTTP requires a distinct strong MCP_HTTP_AUTH_TOKEN.")
  if (![...loopback, "0.0.0.0", "::"].includes(host)) throw Error("Invalid Agent Selfhost MCP HTTP bind address.")
  let publicOrigin: string | undefined
  if (env.MCP_HTTP_PUBLIC_ORIGIN) {
    const u = new URL(env.MCP_HTTP_PUBLIC_ORIGIN)
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw Error("Agent Selfhost MCP public origin must be HTTPS behind an operator-controlled TLS proxy.")
    publicOrigin = u.origin
  }
  if (!loopback.has(host) && !publicOrigin) throw Error("Non-loopback Agent Selfhost MCP requires a public HTTPS origin and TLS proxy.")
  return { port: Number(env.PORT), host, token, publicOrigin }
}

function json(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...(status === 401 ? { "www-authenticate": 'Bearer realm="parly-operator"' } : {}), connection: "close" })
  res.end(JSON.stringify(status === 200 ? { status: "ok" } : { error }))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers["content-length"]) > 262144) { req.resume(); throw 413 }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0
    const finish = (error?: number) => {
      clearTimeout(timer); req.off("data", data); req.off("end", end); req.off("error", failed); req.off("aborted", failed)
      if (error) { req.resume(); reject(error); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))) } catch { reject(400) }
    }
    const data = (value: Buffer) => { bytes += value.length; if (bytes > 262144) finish(413); else chunks.push(value) }
    const end = () => finish(), failed = () => finish(400)
    const timer = setTimeout(() => finish(408), 5000)
    req.on("data", data); req.once("end", end); req.once("error", failed); req.once("aborted", failed)
  })
}

export function createOperatorHttpServer(config: HttpConfig, createRuntime: () => McpServer) {
  const expected = createHash("sha256").update(config.token).digest()
  const hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`, ...(config.publicOrigin ? [new URL(config.publicOrigin).host] : [])])
  const origins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, `http://[::1]:${config.port}`, ...(config.publicOrigin ? [config.publicOrigin] : [])])
  let active = 0
  const server = createServer(async (req, res) => {
    if (!hosts.has(req.headers.host || "") || req.headers.origin !== undefined && !origins.has(req.headers.origin) || req.headers["sec-fetch-site"] === "cross-site") return json(res, 403, "forbidden")
    if (req.url === "/health" && req.method === "GET") return json(res, 200, "")
    if (req.url !== "/mcp") return json(res, req.url?.startsWith("/mcp?") ? 403 : 404, "not_found")
    const auth = req.headers.authorization || ""
    const count = req.rawHeaders.filter((_v, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === "authorization").length
    if (count !== 1 || auth.length > 256 || !auth.startsWith("Bearer ") || !timingSafeEqual(expected, createHash("sha256").update(auth.slice(7)).digest())) return json(res, 401, "unauthorized")
    if (req.method !== "POST") return json(res, 405, "method_not_allowed")
    if (req.headers["content-type"]?.split(";")[0] !== "application/json") return json(res, 415, "json_required")
    if (active >= 4) return json(res, 429, "busy")
    active++
    let runtime: McpServer | undefined
    try {
      const body = await readBody(req)
      if (req.aborted || res.destroyed) return
      // A stateless transport and its server belong to one authenticated request.
      runtime = createRuntime()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await runtime.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (error) {
      if (!res.destroyed && !res.headersSent) json(res, typeof error === "number" ? error : 500, typeof error === "number" ? "invalid_request" : "operation_failed")
      else res.end()
    } finally {
      // A disconnected client does not cancel an already-started wallet operation.
      active--
      void runtime?.close().catch(() => undefined)
      if (!req.complete) req.resume()
    }
  })
  server.headersTimeout = 10000
  server.requestTimeout = 15000
  server.keepAliveTimeout = 5000
  server.maxHeadersCount = 32
  return server
}
