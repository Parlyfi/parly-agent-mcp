import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { registerHooks } from "node:module"
import test from "node:test"
import ts from "typescript"

const sourceUrl = new URL("../src/indexer.ts", import.meta.url)
const build = new URL("../../../.qa/indexer-pagination-20261012/", import.meta.url)
const source = readFileSync(sourceUrl, "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
}).outputText
mkdirSync(build, { recursive: true })
writeFileSync(new URL("indexer.mjs", build), compiled)
writeFileSync(new URL("source-hashes.json", build), JSON.stringify({
  "packages/sdk/src/indexer.ts": createHash("sha256").update(source).digest("hex")
}, null, 2) + "\n")
const hooks = registerHooks({
  load(url, context, next) {
    return url === sourceUrl.href
      ? { format: "module", shortCircuit: true, source: compiled }
      : next(url, context)
  }
})
const sdk = await import(sourceUrl.href)
hooks.deregister()

const options = { ponderUrl: "https://synthetic.invalid/graphql" }
const callers = [
  ["fetchLeaves", "leafInsertedEvents"],
  ["fetchDeposits", "depositEvents"],
  ["fetchIngressSettlements", "ingressSettlementEvents"],
  ["fetchSpokeShieldDispatches", "spokeShieldDispatchEvents"],
  ["fetchEnvelopes", "noteEnvelopeEvents"],
  ["fetchWithdrawals", "batchWithdrawalEvents"],
  ["fetchNullifiers", "batchWithdrawalEvents"]
]
const first = { commitment: "synthetic-first", leafIndex: 0 }
const second = { commitment: "synthetic-second", leafIndex: 1 }
const page = (items, hasNextPage, endCursor) => ({ items, pageInfo: { hasNextPage, endCursor } })

// Only the external fetch boundary is replaced; actual SDK exports execute unchanged.
function fixture(t, responses) {
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), options.ponderUrl, "No live network requests")
    assert.equal(init.method, "POST")
    const request = JSON.parse(init.body)
    requests.push(request)
    assert.ok(requests.length <= responses.length, "Unexpected extra page request")
    const response = responses[requests.length - 1]
    return { ok: true, status: 200, json: async () => response }
  }
  t.after(() => { globalThis.fetch = original })
  return requests
}

const malformed = [
  ["missing data", {}],
  ["null data", { data: null }],
  ["missing root", { data: {} }],
  ["null root", { data: { leafInsertedEvents: null } }],
  ["array root", { data: { leafInsertedEvents: [] } }],
  ["string root", { data: { leafInsertedEvents: "invalid" } }],
  ...[
    ["missing items", { pageInfo: { hasNextPage: false, endCursor: null } }],
    ["null items", page(null, false, null)],
    ["object items", page({}, false, null)],
    ["string items", page("invalid", false, null)],
    ["missing pageInfo", { items: [first] }],
    ["null pageInfo", { items: [first], pageInfo: null }],
    ["array pageInfo", { items: [first], pageInfo: [] }],
    ["string pageInfo", { items: [first], pageInfo: "invalid" }],
    ["missing continuation", { items: [first], pageInfo: { endCursor: null } }],
    ["null continuation", page([first], null, null)],
    ["zero continuation", page([first], 0, null)],
    ["string continuation", page([first], "false", "cursor")],
    ["missing terminal cursor", { items: [first], pageInfo: { hasNextPage: false } }],
    ["numeric terminal cursor", page([first], false, 1)],
    ["object terminal cursor", page([first], false, {})],
    ["blank terminal cursor", page([first], false, " ")],
    ["missing continuation cursor", { items: [first], pageInfo: { hasNextPage: true } }],
    ["null continuation cursor", page([first], true, null)],
    ["numeric continuation cursor", page([first], true, 1)],
    ["object continuation cursor", page([first], true, {})],
    ["empty continuation cursor", page([first], true, "")],
    ["whitespace continuation cursor", page([first], true, " \t\n")],
    ["empty continuing page", page([], true, "cursor")]
  ].map(([name, value]) => [name, { data: { leafInsertedEvents: value } }])
]

for (const [name, response] of malformed) {
  test(`fetchLeaves rejects ${name}`, async (t) => {
    fixture(t, [response])
    await assert.rejects(sdk.fetchLeaves(1, options), /Invalid indexer page/u)
  })
}

for (const [name, root] of callers) {
  test(`${name} preserves valid empty terminal-null pages`, async (t) => {
    const requests = fixture(t, [{ data: { [root]: page([], false, null) } }])
    assert.deepEqual(await sdk[name](2, options), [])
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].variables, { assetId: 2, limit: requests[0].variables.limit, after: null })
    assert.ok(Number.isInteger(requests[0].variables.limit) && requests[0].variables.limit > 0)
  })

  test(`${name} follows exact opaque cursors and preserves ordered rows`, async (t) => {
    const requests = fixture(t, [
      { data: { [root]: page([first], true, " opaque cursor ") } },
      { data: { [root]: page([second], false, null) } }
    ])
    assert.deepEqual(await sdk[name](1, options), [first, second])
    assert.deepEqual(requests.map((request) => request.variables.after), [null, " opaque cursor "])
    assert.equal(requests[0].query, requests[1].query)
  })

  test(`${name} rejects later malformed pages instead of returning partial history`, async (t) => {
    const requests = fixture(t, [
      { data: { [root]: page([first], true, "cursor-a") } },
      { data: { [root]: { items: [second] } } }
    ])
    await assert.rejects(sdk[name](1, options), /Invalid indexer page/u)
    assert.equal(requests.length, 2)
  })

  test(`${name} rejects missing roots`, async (t) => {
    fixture(t, [{ data: {} }])
    await assert.rejects(sdk[name](1, options), /Invalid indexer page/u)
  })
}

for (const [name, cursors, terminal] of [
  ["immediate repeat", ["cursor-a", "cursor-a"], false],
  ["longer cycle", ["cursor-a", "cursor-b", "cursor-a"], false],
  ["terminal repeat", ["cursor-a", "cursor-a"], true]
]) {
  test(`fetchLeaves rejects ${name} without another request or partial result`, async (t) => {
    const requests = fixture(t, cursors.map((cursor, index) => ({
      data: { leafInsertedEvents: page([first], !(terminal && index === cursors.length - 1), cursor) }
    })))
    await assert.rejects(sdk.fetchLeaves(1, options), /Invalid indexer page/u)
    assert.equal(requests.length, cursors.length)
  })
}

test("fetchLeaves preserves a nonempty terminal string cursor", async (t) => {
  fixture(t, [{ data: { leafInsertedEvents: page([first], false, "terminal-cursor") } }])
  assert.deepEqual(await sdk.fetchLeaves(1, options), [first])
})

test("fetchLeaves preserves a later empty terminal-null page", async (t) => {
  fixture(t, [
    { data: { leafInsertedEvents: page([first], true, "cursor-a") } },
    { data: { leafInsertedEvents: page([], false, null) } }
  ])
  assert.deepEqual(await sdk.fetchLeaves(1, options), [first])
})

test("fetchLeaves preserves a three-page sequence with distinct terminal cursor", async (t) => {
  const third = { commitment: "synthetic-third", leafIndex: 2 }
  fixture(t, [
    { data: { leafInsertedEvents: page([first], true, "cursor-a") } },
    { data: { leafInsertedEvents: page([second], true, "cursor-b") } },
    { data: { leafInsertedEvents: page([third], false, "cursor-c") } }
  ])
  assert.deepEqual(await sdk.fetchLeaves(1, options), [first, second, third])
})

test("fetchLeaves preserves HTTP failure rejection", async (t) => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503 })
  t.after(() => { globalThis.fetch = original })
  await assert.rejects(sdk.fetchLeaves(1, options), /HTTP 503/u)
})

test("fetchLeaves rejects a later GraphQL error without partial data", async (t) => {
  fixture(t, [
    { data: { leafInsertedEvents: page([first], true, "cursor-a") } },
    { errors: [{ message: "synthetic unavailable" }] }
  ])
  await assert.rejects(sdk.fetchLeaves(1, options), /synthetic unavailable/u)
})
