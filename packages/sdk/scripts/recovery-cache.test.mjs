import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const sdkRoot = new URL("../src/", import.meta.url).href
const packagesRoot = new URL("../../", import.meta.url).href
const indexerUrl = new URL("indexer.ts", sdkRoot).href
const indexerState = { scans: 0, envelopes: [], leaves: [], nullifiers: [], heads: {
  leafCursor: "0:fixture", envelopeCursor: "fixture", nullifierCursor: null
} }
globalThis.__parlySdkCacheTestIndexer = indexerState
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@parly/")) {
      return nextResolve(new URL(specifier.slice(7) + "/src/index.ts", packagesRoot).href, context)
    }
    if (context.parentURL?.startsWith(packagesRoot) && !context.parentURL.includes("/node_modules/") && specifier.startsWith(".") && specifier.endsWith(".js")) {
      return nextResolve(new URL(specifier.slice(0, -3) + ".ts", context.parentURL).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url !== indexerUrl) {
      if (url.startsWith(packagesRoot) && url.endsWith(".ts") && !url.includes("/node_modules/")) {
        return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
        }).outputText }
      }
      return nextLoad(url, context)
    }
    return { format: "module", shortCircuit: true, source: `
      const state = globalThis.__parlySdkCacheTestIndexer;
      export const fetchRecoveryHeads = async () => ({ ...state.heads });
      export const fetchEnvelopes = async () => { state.scans++; return state.envelopes; };
      export const fetchLeaves = async () => state.leaves;
      export const fetchNullifiers = async () => state.nullifiers;
    ` }
  }
})
const { ParlySDK } = await import("../src/core.ts")
const { createSealedNoteEnvelope, reconstructEnvelopeNote } = await import("../src/note-crypto.ts")

const pool = "0x1111111111111111111111111111111111111111"
const otherPool = "0x2222222222222222222222222222222222222222"
const config = {
  privateKeyHex: "0x" + "01".repeat(32), tempoRpcUrl: "https://example.invalid",
  tempoChainId: 42431, tempoLzEid: 40439, ponderGraphqlUrl: "https://example.invalid/graphql"
}
const env = {
  PARLY_ENV: "mainnet", PARLY_OFFICIAL_ORIGIN: "https://parly.fi",
  PARLY_CURRENT_ORIGIN: "https://parly.fi",
  GROTH16_VERIFIER_ADDRESS: "0x3333333333333333333333333333333333333333",
  PARLY_EXPECTED_TEMPO_CHAIN_ID: "42431", PARLY_EXPECTED_SETTLEMENT_DOMAIN_ID: "40439",
  PARLY_EXPECTED_POOL: pool,
  PARLY_EXPECTED_GROTH16_VERIFIER_ADDRESS: "0x3333333333333333333333333333333333333333"
}

async function fixture(t, assetId = 1) {
  const prefix = fileURLToPath(new URL("../../../.qa/sdk-recovery-cache-test-", import.meta.url))
  mkdirSync(dirname(prefix), { recursive: true })
  const dir = mkdtempSync(prefix)
  const file = join(dir, "cache.json")
  const previous = new Map(Object.keys({ ...env, SDK_RECOVERY_CACHE_FILE: file }).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env, { SDK_RECOVERY_CACHE_FILE: file })
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    assert.ok(dir.startsWith(prefix), "cleanup must stay within the generated QA directory")
    rmSync(dir, { recursive: true })
  })
  Object.assign(indexerState, { scans: 0, envelopes: [], leaves: [], nullifiers: [], heads: {
    leafCursor: "0:fixture", envelopeCursor: "fixture", nullifierCursor: null
  } })
  const a = new ParlySDK(config)
  const b = new ParlySDK({ ...config, privateKeyHex: "0x" + "02".repeat(32) })
  const kp = await b.getRecoveryKeypair({ assetId, poolAddress: pool })
  const payload = {
    version: 1, kind: "deposit", assetId, amount: "1000000", secret: "123", nullifier: "456",
    depositor: "789", ownerRecoveryPubKeyB64: kp.publicKeyB64, createdAt: 1
  }
  const note = await reconstructEnvelopeNote(payload)
  indexerState.envelopes = [{ ...note, kind: "deposit", envelope: await createSealedNoteEnvelope(kp.publicKeyB64, payload) }]
  indexerState.leaves = [{ commitment: note.commitment, leafIndex: 0 }]
  return { a, b, kp, note, file }
}

for (const assetId of [1, 2]) {
  test(`asset ${assetId}: another wallet's same-head empty cache must not hide a funded note`, async (t) => {
    const { a, b, note, file, kp } = await fixture(t, assetId)
    assert.equal((await a.recoverLargestNote(assetId, pool)).best, null)
    assert.equal((await a.recoverLargestNote(assetId, pool)).best, null)
    assert.equal((await new ParlySDK(config).recoverLargestNote(assetId, pool)).best, null)
    assert.equal(indexerState.scans, 1, "same identity may reuse its empty scan")
    const recovered = await b.recoverLargestNote(assetId, pool)
    assert.equal(recovered.best?.commitment, note.commitment)
    assert.equal(recovered.best?.amount, 1000000n)
    assert.equal(indexerState.scans, 2)
    const fresh = new ParlySDK({ ...config, privateKeyHex: "0x" + "02".repeat(32) })
    assert.equal((await fresh.recoverLargestNote(assetId, pool)).best?.commitment, note.commitment)
    assert.equal(indexerState.scans, 2, "same identity survives a new SDK instance")
    const contents = readFileSync(file, "utf8")
    assert.ok(!contents.includes(kp.privateKeyB64))
    assert.ok(!contents.includes(config.privateKeyHex))
    assert.ok(!contents.includes(b.config.privateKeyHex))
  })
}

test("same public key on a different chain must not reuse cached empty results", async (t) => {
  const { a, file } = await fixture(t)
  const fixed = await a.getRecoveryKeypair({ assetId: 1, poolAddress: pool })
  a.getRecoveryKeypair = async () => fixed
  assert.equal((await a.recoverLargestNote(1, pool)).best, null)
  const otherChain = new ParlySDK({ ...config, tempoChainId: 42432 })
  otherChain.getRecoveryKeypair = async () => fixed
  assert.equal((await otherChain.recoverLargestNote(1, pool)).best, null)
  assert.equal(indexerState.scans, 2)
  assert.equal(Object.keys(JSON.parse(readFileSync(file, "utf8")).assets).length, 2)
})

test("asset and pool identities still isolate empty caches", async (t) => {
  const { a } = await fixture(t)
  const fixed = await a.getRecoveryKeypair({ assetId: 1, poolAddress: pool })
  a.getRecoveryKeypair = async () => fixed
  await a.recoverLargestNote(1, pool)
  await a.recoverLargestNote(2, pool)
  await a.recoverLargestNote(1, otherPool)
  assert.equal(indexerState.scans, 3)
})

test("unowned legacy cache is ignored without destroying its entry", async (t) => {
  const { b, note, file } = await fixture(t)
  const legacy = { version: 3, assetId: 1, poolAddress: pool, heads: indexerState.heads, leaves: [], best: null }
  writeFileSync(file, JSON.stringify({ version: 3, assets: { [`1:${pool}`]: legacy } }))
  assert.equal((await b.recoverLargestNote(1, pool)).best?.commitment, note.commitment)
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).assets[`1:${pool}`], legacy)
})

test("changed heads refresh a previously cached live note into spent state", async (t) => {
  const { b, note } = await fixture(t)
  assert.equal((await b.recoverLargestNote(1, pool)).best?.commitment, note.commitment)
  indexerState.nullifiers = [{ nullifierHash: note.nullifierHash }]
  indexerState.heads.nullifierCursor = "spent"
  assert.equal((await b.recoverLargestNote(1, pool)).best, null)
  assert.equal(indexerState.scans, 2)
})

test("cached envelope corruption only clears that identity and preserves other caches", async (t) => {
  const { a, b, file, note } = await fixture(t)
  await a.recoverLargestNote(1, pool)
  await b.recoverLargestNote(1, pool)
  const parsed = JSON.parse(readFileSync(file, "utf8"))
  const entry = Object.values(parsed.assets).find((value) => value.best)
  entry.best.envelope = "0x00"
  writeFileSync(file, JSON.stringify(parsed))
  assert.equal((await b.recoverLargestNote(1, pool)).best?.commitment, note.commitment)
  const scans = indexerState.scans
  assert.equal((await a.recoverLargestNote(1, pool)).best, null)
  assert.equal(indexerState.scans, scans, "clearing B must not invalidate A's cached scan")
})

test("a changed recovery context cannot replace a funded historical context's cached note", async (t) => {
  const { b, note } = await fixture(t)
  assert.equal((await b.recoverLargestNote(1, pool)).best?.commitment, note.commitment)
  process.env.GROTH16_VERIFIER_ADDRESS = "0x4444444444444444444444444444444444444444"
  process.env.PARLY_EXPECTED_GROTH16_VERIFIER_ADDRESS = process.env.GROTH16_VERIFIER_ADDRESS
  assert.equal((await b.recoverLargestNote(1, pool)).best, null)
  assert.equal(indexerState.scans, 2)
  process.env.GROTH16_VERIFIER_ADDRESS = env.GROTH16_VERIFIER_ADDRESS
  process.env.PARLY_EXPECTED_GROTH16_VERIFIER_ADDRESS = env.PARLY_EXPECTED_GROTH16_VERIFIER_ADDRESS
  assert.equal((await b.recoverLargestNote(1, pool)).best?.commitment, note.commitment)
  assert.equal(indexerState.scans, 2, "the exact original key must still have its cache")
})

test("cache metadata must match the current chain and recovery key even at the correct lookup key", async (t) => {
  const { b, note, file } = await fixture(t)
  for (const field of ["chainId", "recoveryPublicKeyB64"]) {
    await b.recoverLargestNote(1, pool)
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    const entry = Object.values(parsed.assets).find((value) => value.best)
    entry[field] = field === "chainId" ? 42432 : "wrong-key"
    writeFileSync(file, JSON.stringify(parsed))
    const scans = indexerState.scans
    assert.equal((await b.recoverLargestNote(1, pool)).best?.commitment, note.commitment)
    assert.equal(indexerState.scans, scans + 1)
  }
})

test("malformed optional cache must not stop recovery of a funded note", async (t) => {
  const { b, note, file } = await fixture(t)
  for (const malformed of ["null", '{"version":4,"assets":null}', '{"version":4,"assets":[]}', '{"version":4,"assets":7}', "{broken JSON"]) {
    writeFileSync(file, malformed)
    assert.equal((await b.recoverLargestNote(1, pool)).best?.commitment, note.commitment)
  }
})
