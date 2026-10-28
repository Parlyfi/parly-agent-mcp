import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const source = readFileSync(new URL("../src/core.ts", import.meta.url), "utf8")
const ast = ts.createSourceFile("core.ts", source, ts.ScriptTarget.Latest, true)
const sdk = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ParlySDK")
const method = sdk.members.find(node => node.name?.getText(ast) === "getLaunchContext")
const read = new Function("PUBLIC_SURFACES", ts.transpile(`function read() ${method.body.getText(ast)}; return read`))([{ name: "synthetic-public-surface" }])

test("public launch context cannot expose signing keys or credentials embedded in endpoints", () => {
  const result = read.call({ config: { privateKeyHex: "synthetic-private-key", tempoRpcUrl: "https://rpc.invalid/synthetic-rpc-key",
    ponderGraphqlUrl: "https://indexer.invalid/synthetic-indexer-key", webApiBaseUrl: "https://api.invalid/synthetic-web-key",
    proofAssetsBasePath: "synthetic-private-path", futureCredential: { token: "synthetic-private-future-token" }, tempoChainId: 4217, tempoLzEid: 4217 } })
  assert.deepEqual(result, { tempoChainId: 4217, tempoLzEid: 4217, publicSurfaces: [{ name: "synthetic-public-surface" }] })
  assert.doesNotMatch(JSON.stringify(result), /privateKey|synthetic-(?:private|rpc|indexer|web)/u)
})
