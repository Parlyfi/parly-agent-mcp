import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/receiving-history-candidate.ts', import.meta.url), 'utf8')
const module = { exports: {} }
vm.runInNewContext(`(function(require,module,exports){${ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText}\n})`, { crypto: webcrypto, URL, AbortSignal, fetch, structuredClone, Uint8Array, BigInt })(require, module, module.exports)
const { scanIndexedHistory, sdkPrefixReader, scanReceivingHistoryV4, receivingHistoryPrefixV4 } = module.exports
test('history transport compiles with Node-only fetch types', () => {
  const program = ts.createProgram([fileURLToPath(new URL('../src/receiving-history-candidate.ts', import.meta.url))], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts'], types: ['node'], strict: true, skipLibCheck: true, noEmit: true
  })
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [])
})
const { buildBabyjub, buildPoseidon } = require('circomlibjs')
const { encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, keccak256, parseAbi, toHex } = require('viem')
const jub = await buildBabyjub(), poseidon = await buildPoseidon()
const H = (...values) => BigInt(poseidon.F.toString(poseidon(values)))
const address = n => `0x${n.toString(16).padStart(40, '0')}`
const hash = n => `0x${n.toString(16).padStart(64, '0')}`
const pool = address(1), code = '0x1234', token = 'a'.repeat(64)
const domain = { chainId: '31337', pool, assetId: 1, circuitVersion: 99, settlementDomain: '99' }
const anchor = { block: '10', timestamp: '1791720000', hash: hash(10) }
const query = { domain, anchor, pageSize: 2, after: null, token: null }
const abi = parseAbi([
  'function circuitVersion() view returns (uint8)',
  'function assetId() view returns (uint256)', 'function settlementDomain() view returns (uint256)',
  ...['underlyingToken', 'receiver', 'master', 'registry', 'verifier', 'hasher', 'spendVerifier'].map(n => `function ${n}() view returns (address)`),
  'function nextLeafIndex() view returns (uint64)', 'function currentRoot() view returns (uint256)',
  'function nullifiers(uint256) view returns (bool)',
  'event LeafInserted(uint256 commitment, uint32 index, uint8 kind)',
  'event NoteAdmitted(uint256 commitment, uint256 ex, uint256 ey, uint128 principal)',
  'event Spent(uint256[60] signals, bytes changeEnvelope)'
])
const point = scalar => jub.mulPointEscalar(jub.Base8, scalar).map(x => BigInt(jub.F.toString(x)))
const grant = { A: point(11n), V: point(12n), viewScalar: 12n, domain: H(953n, 99n, 31337n, BigInt(pool), 1n, 99n) }

async function fixture({ category = 1n, spend = false, assetId = 1, version = 99 } = {}) {
  const chainId = version === 4 ? 4217n : 31337n, settlementDomain = version === 4 ? 7n : 99n
  const domain = { chainId: String(chainId), pool, assetId, circuitVersion: version, settlementDomain: String(settlementDomain) }
  const grant = { A: point(11n), V: point(12n), viewScalar: 12n, domain: H(953n, BigInt(version), chainId, BigInt(pool), BigInt(assetId), settlementDomain) }
  const E = point(13n), r = H(954n, grant.domain, ...point(13n * grant.viewScalar))
  const principal = 1000000n, C = H(956n, H(955n, grant.domain, ...grant.A, ...grant.V, r, category), principal)
  const zeros = [0n]; for (let i = 0; i < 32; i++) zeros.push(H(zeros[i], zeros[i]))
  let root = C; for (let i = 0; i < 32; i++) root = H(root, zeros[i])
  const logs = [], rows = [], txHash = hash(11), events = [
    ['LeafInserted', { commitment: C, index: 0, kind: 0 }, 'leaf'],
    ['NoteAdmitted', { commitment: C, ex: E[0], ey: E[1], principal }, 'incoming']
  ]
  if (spend) {
    const s = Array(60).fill(0n)
    s[10] = chainId; s[11] = BigInt(pool); s[12] = BigInt(assetId); s[13] = settlementDomain; s[14] = root
    s[15] = H(19702n, grant.domain, H(19701n, grant.domain, grant.viewScalar), C); s[19] = 1n
    s[20] = principal - 100n; s[50] = 100n
    const body = encodeAbiParameters([{ type: 'uint256[45]' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }], [s.slice(10, 55), 0n, 0n, 0n, '0x'])
    const digest = BigInt(`0x${Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(body.slice(2), 'hex'))).toString('hex')}`)
    s[55] = digest & ((1n << 128n) - 1n); s[56] = digest >> 128n
    events.push(['Spent', { signals: s, changeEnvelope: '0x' }, 'spend'])
  }
  const wire = x => typeof x === 'bigint' ? String(x) : Array.isArray(x) ? x.map(wire) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, wire(v)])) : x
  for (const [name, args, kind] of events) {
    const i = logs.length, eventAbi = abi.find(x => x.type === 'event' && x.name === name)
    const log = { address: pool, blockNumber: '0xa', blockHash: anchor.hash, transactionHash: txHash, transactionIndex: '0x0', logIndex: toHex(i), removed: false,
      topics: encodeEventTopics({ abi, eventName: name, args }), data: encodeAbiParameters(eventAbi.inputs.filter(x => !x.indexed), Object.values(args)) }
    logs.push(log)
    const id = [anchor.timestamp, domain.chainId, anchor.block, '0', '5', String(i)].map((x, j) => x.padStart([10, 16, 16, 16, 1, 16][j], '0')).join('')
    rows.push({ id, pool, assetId, txHash, timestamp: anchor.timestamp, kind, payload: wire(args) })
  }
  const authority = { domain, anchor, fromBlock: '10', fromBlockHash: anchor.hash, runtimeCodeHash: keccak256(code), spendVerifier: address(8),
    dependencies: Array.from({ length: 8 }, (_, i) => ({ address: address(i + 1), codeHash: keccak256(code) })) }
  const calls = []
  const rpc = async q => {
    calls.push(q)
    if (q.method === 'eth_chainId') return toHex(chainId)
    if (q.method === 'eth_getCode') return code
    if (q.method === 'eth_getBlockByNumber') return { number: '0xa', hash: anchor.hash, timestamp: toHex(BigInt(anchor.timestamp)), transactions: [txHash] }
    if (q.method === 'eth_getLogs') return structuredClone(logs)
    if (q.method === 'eth_getTransactionReceipt') return { status: '0x1', transactionHash: txHash, blockHash: anchor.hash, blockNumber: '0xa', transactionIndex: '0x0', logs: structuredClone(logs) }
    if (q.method === 'eth_call') {
      const name = abi.find(x => x.type === 'function' && encodeFunctionData({ abi, functionName: x.name, args: x.name === 'nullifiers' ? [0n] : [] }).slice(0, 10) === q.params[0].data.slice(0, 10)).name
      const slots = { underlyingToken: 2, receiver: 3, master: 4, registry: 5, verifier: 6, hasher: 7, spendVerifier: 8 }
      const result = name === 'circuitVersion' ? version : name === 'assetId' ? BigInt(assetId) : name === 'settlementDomain' ? settlementDomain : name === 'nextLeafIndex' ? 1n : name === 'currentRoot' ? root : name === 'nullifiers' ? spend : address(slots[name])
      return encodeFunctionResult({ abi, functionName: name, result })
    }
    throw Error('Unexpected RPC method')
  }
  const readPage = async q => {
    const start = q.after ? rows.findIndex(x => x.id === q.after) + 1 : 0, items = rows.slice(start, start + q.pageSize)
    return structuredClone({ status: 'PINNED_VIEW_PREFIX', domain, anchor, token, head: { count: rows.length, terminalId: rows.at(-1).id }, items,
      pageInfo: { hasNextPage: start + items.length < rows.length, endCursor: items.at(-1)?.id ?? null } })
  }
  return { args: { authority, grant, rpc, readPage, abi, H, jub, pageSize: 2 }, rows, logs, calls }
}

test('source is browser-compatible and not an active SDK export', () => {
  assert.doesNotMatch(source, /node:|Buffer\b|\.qa[\\/]|test-only-key/)
  assert.doesNotMatch(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'), /receiving-history-candidate/)
})

test('V4 entry validates owner/watch-only history without accepting the QA domain', async () => {
  assert.equal(typeof scanReceivingHistoryV4, 'function')
  for (const assetId of [1, 2, 3]) for (const category of [1n, 2n]) for (const spend of [false, true]) {
    const f = await fixture({ version: 4, assetId, category, spend }), r = await scanReceivingHistoryV4(f.args)
    assert.equal(r.balance, spend ? '0' : '1000000')
    assert.equal(r.historyStatus, 'PINNED_V4_ACCOUNTING_VALIDATED')
    if (!spend) assert.equal(r.notes[0].category, Number(category))
    await assert.rejects(() => scanIndexedHistory(f.args), /UNAVAILABLE/)
    for (const key of ['viewScalar', 'spendScalar', 'grant', 'owned']) assert.equal(key in r, false)
  }
  const qa = await fixture()
  await assert.rejects(() => scanReceivingHistoryV4(qa.args), /UNAVAILABLE/)
  const f = await fixture({ version: 4, spend: true })
  await assert.rejects(() => scanReceivingHistoryV4({ ...f.args, rpc: async q => q.method === 'eth_getLogs' ? f.logs.slice(1) : f.args.rpc(q) }), /UNAVAILABLE/)
})

test('browser transport sends only public, bounded prefix queries', async () => {
  let request
  const read = sdkPrefixReader('http://127.0.0.1:12345/', async (url, init) => { request = { url: String(url), init }; return { ok: true, json: async () => ({ ok: true }) } })
  assert.equal((await read(query)).ok, true)
  assert.deepEqual([...new URL(request.url).searchParams.keys()].sort(), ['block', 'hash', 'limit', 'pool', 'timestamp'])
  assert.equal(request.init.redirect, 'error'); assert.equal(request.init.cache, 'no-store'); assert.equal(request.init.body, undefined)
  for (const bad of [{ ...query, grant }, { ...query, domain: { ...domain, spendScalar: 1n } }, { ...query, anchor: { ...anchor, key: 'secret' } }, { ...query, after: { private: 1 } }, { ...query, token: 'bad' }, { ...query, pageSize: 1001 }]) await assert.rejects(() => read(bad), /UNAVAILABLE/)
  for (const url of ['https://parly.fi/', 'http://user:secret@127.0.0.1:1/', 'http://127.0.0.1:1/?key=x', 'http://127.0.0.1:1/#x']) assert.throws(() => sdkPrefixReader(url), /UNAVAILABLE/)
  await assert.rejects(() => sdkPrefixReader('http://127.0.0.1:1/', async () => ({ ok: false, json: async () => ({}) }))(query), /UNAVAILABLE/)
})

test('V4 browser transport uses the mounted HTTPS prefix without sending view keys', async () => {
  assert.equal(typeof receivingHistoryPrefixV4, 'function')
  const f = await fixture({ version: 4 }), domain = f.args.authority.domain
  let seen
  const read = receivingHistoryPrefixV4('https://indexer.parly.fi/', async (url, init) => { seen = { url: String(url), init }; return { ok: true, json: async () => ({ status: 'test' }) } })
  assert.equal((await read({ ...query, domain })).status, 'test')
  assert.equal(new URL(seen.url).pathname, '/receiving/v4/prefix')
  assert.equal(seen.init.redirect, 'error'); assert.equal(seen.init.cache, 'no-store'); assert.equal(seen.init.body, undefined)
  assert.deepEqual([...new URL(seen.url).searchParams.keys()].sort(), ['block','hash','limit','pool','timestamp'])
  await assert.rejects(() => read({ ...query, domain, grant }), /UNAVAILABLE/)
  await assert.rejects(() => read(query), /UNAVAILABLE/)
  for (const url of ['http://indexer.parly.fi/', 'https://u:p@indexer.parly.fi/', 'https://indexer.parly.fi/?secret=x']) assert.throws(() => receivingHistoryPrefixV4(url), /UNAVAILABLE/)
})

test('real view-only accounting handles Shield, customer payments and terminal spends', async () => {
  for (const category of [1n, 2n]) for (const spend of [false, true]) {
    const f = await fixture({ category, spend }), result = await scanIndexedHistory(f.args)
    assert.equal(result.balance, spend ? '0' : '1000000')
    assert.equal(result.notes.length, spend ? 0 : 1)
    if (!spend) assert.equal(result.notes[0].category, Number(category))
    assert.equal(result.productionHistoryStatus, 'UNAVAILABLE'); assert.equal(result.groth16Verified, false)
    assert.equal(result.guardedCandidate, true)
    for (const key of ['owned', 'allOwned', 'grant', 'viewScalar', 'spendScalar']) assert.equal(key in result, false)
    assert.ok(f.calls.every(x => !/send|sign|estimate/i.test(x.method)))
  }
})

test('wrong keys, private-bearing grants, omitted rows and provider drift fail closed', async () => {
  const f = await fixture({ spend: true }), a = f.args
  for (const altered of [
    { grant: { ...grant, viewScalar: 13n } }, { grant: { ...grant, spendScalar: 1n } },
    { authority: { ...a.authority, domain: { ...domain, circuitVersion: 3 } } },
    { authority: { ...a.authority, dependencies: a.authority.dependencies.slice(0, -1) } },
    { readPage: async q => { const p = await a.readPage(q); p.items[0].payload.commitment = '1'; return p } },
    { rpc: async q => q.method === 'eth_getLogs' ? f.logs.slice(1) : a.rpc(q) },
    { rpc: async q => q.method === 'eth_getTransactionReceipt' ? { ...await a.rpc(q), status: '0x0' } : a.rpc(q) },
    { rpc: async q => q.method === 'eth_getCode' ? '0x4321' : a.rpc(q) }
  ]) await assert.rejects(() => scanIndexedHistory({ ...a, ...altered }), /UNAVAILABLE/)
  let pages = 0
  await assert.rejects(() => scanIndexedHistory({ ...a, readPage: async q => { const p = await a.readPage(q); if (++pages > 1) p.token = 'b'.repeat(64); return p } }), /UNAVAILABLE/)
  let anchors = 0
  await assert.rejects(() => scanIndexedHistory({ ...a, rpc: async q => { const r = await a.rpc(q); return q.method === 'eth_getBlockByNumber' && ++anchors > 3 ? { ...r, hash: hash(99) } : r } }), /UNAVAILABLE/)
})

test('OUSD accounting preserves both categories and rejects cross-asset rows or grants', async () => {
  for(const category of [1n,2n])for(const spend of [false,true]){
    const f=await fixture({assetId:3,category,spend}),result=await scanIndexedHistory(f.args)
    assert.equal(result.balance,spend?'0':'1000000')
    if(!spend)assert.equal(result.notes[0].category,Number(category))
    await assert.rejects(()=>scanIndexedHistory({...f.args,grant}),/UNAVAILABLE/)
    await assert.rejects(()=>scanIndexedHistory({...f.args,readPage:async q=>{const p=await f.args.readPage(q);p.items[0].assetId=1;return p}}),/UNAVAILABLE/)
  }
  for(const assetId of [0,4]){
    const f=await fixture({assetId})
    await assert.rejects(()=>scanIndexedHistory(f.args),/UNAVAILABLE/)
  }
})

test('missing history never becomes zero and provider exceptions never expose credentials', async () => {
  const { args } = await fixture()
  await assert.rejects(() => scanIndexedHistory({ ...args, readPage: async () => null }), /UNAVAILABLE/)
  await assert.rejects(() => scanIndexedHistory({ ...args, rpc: async () => { throw Error('UNAVAILABLE: provider-secret') } }), error => {
    assert.match(error.message, /UNAVAILABLE/); assert.doesNotMatch(error.message, /provider-secret/); return true
  })
  let calls = 0
  await assert.rejects(() => scanIndexedHistory({ ...args, grant: { ...grant, spendScalar: 11n }, rpc: async () => { calls++; return '0x0' } }), /UNAVAILABLE/)
  assert.equal(calls, 0)
})
