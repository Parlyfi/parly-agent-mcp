import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"

function client(fetcher, base = "https://parly.invalid") {
  const module = { exports: {} }, source = readFileSync(new URL("../src/web-api-client.ts", import.meta.url), "utf8")
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function("module", "exports", "fetch", "URL", "AbortSignal", "TextDecoder", code)(module, module.exports, fetcher, URL, AbortSignal, TextDecoder)
  return new module.exports.ParlyWebApiClient(base, { bearerToken: "synthetic-outbound-token" })
}

test("outbound bearer never leaves its configured HTTPS origin or follows a redirect", async () => {
  let calls = 0
  const c = client(async (_url, options) => {
    calls++; assert.equal(options.redirect, "error"); assert.ok(options.signal)
    assert.equal(options.headers.authorization, "Bearer synthetic-outbound-token")
    return new Response('{"ok":true}')
  })
  await assert.rejects(() => c.getJson("https://attacker.invalid/api"))
  await assert.rejects(() => c.getJson("//attacker.invalid/api"))
  assert.equal(calls, 0)
  assert.deepEqual(await c.getJson("/api/allowed"), { ok: true }); assert.equal(calls, 1)
  assert.throws(() => client(async () => {}, "https://user:secret@parly.invalid"))
})

test("upstream errors and oversized responses cannot expose arbitrary payload or exhaust memory", async () => {
  const c = client(async () => new Response('{"error":"synthetic-private-error"}', { status: 500 }))
  await assert.rejects(() => c.getJson("/api/status"), error => !error.message.includes("synthetic-private-error"))
  const big = client(async () => new Response(" ".repeat(1048577)))
  await assert.rejects(() => big.getJson("/api/status"))
})
