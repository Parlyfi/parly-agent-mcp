import {
  decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeEventTopics,
  encodeFunctionData, encodeFunctionResult, hexToBytes, keccak256, toHex,
  type Abi, type AbiParameter, type Hex
} from "viem"

// Shared accounting; exported entry points select a fixed version, never a payer-supplied fallback.
type Domain = { chainId: string; pool: Hex; assetId: number; circuitVersion: 4 | 99; settlementDomain: string }
type Anchor = { block: string; timestamp: string; hash: Hex }
type Point = [bigint, bigint]
type NativePoint = [Uint8Array, Uint8Array]
type Grant = { A: Point; V: Point; viewScalar: bigint; domain: bigint }
type Authority = {
  domain: Domain; anchor: Anchor; fromBlock: string; fromBlockHash: Hex; runtimeCodeHash: Hex
  spendVerifier: Hex; dependencies: { address: Hex; codeHash: Hex }[]
}
type Jubjub = {
  F: { e(n: bigint): Uint8Array; toString(n: Uint8Array): string }
  subOrder: bigint; Base8: NativePoint
  inCurve(p: NativePoint): boolean; inSubgroup(p: NativePoint): boolean
  mulPointEscalar(p: NativePoint, n: bigint): NativePoint
}
type Hash = (...values: bigint[]) => bigint
type Rpc = (request: { method: string; params: unknown[] }) => Promise<unknown>
type PrefixRequest = { domain: Domain; anchor: Anchor; pageSize: number; after: string | null; token: string | null }
type Row = { id: string; pool: Hex; assetId: number; txHash: Hex; timestamp: string; kind: string; payload: unknown }
type Head = { count: number; terminalId: string | null }
type Page = { status: string; domain: Domain; anchor: Anchor; token: string; head: Head; items: Row[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
type Record = { type: "incoming"; C: bigint; E: Point; principal: bigint } | { type: "spend"; signals: bigint[] }
type Note = { C: bigint; amount: bigint; category: bigint; spent: boolean }

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const spendBodyParameters: AbiParameter[] = [{ type: "uint256[45]" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }]
class HistoryUnavailable extends Error {}
function fail(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new HistoryUnavailable("UNAVAILABLE: " + reason)
}
function object(v: unknown): v is { [key: string]: unknown } { return !!v && typeof v === "object" && !Array.isArray(v) }
function shape<T extends object>(v: unknown, keys: string[], reason: string): asserts v is T {
  fail(object(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(","), reason)
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]))
  return object(a) && object(b) && same(Object.keys(a).sort(), Object.keys(b).sort()) && Object.keys(a).every(k => same(a[k], b[k]))
}
function eq(a: unknown, b: unknown, reason: string) { fail(same(a, b), reason) }
const hash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v)
const address = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v) && !/^0x0{40}$/.test(v)
const decimal = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,15})$/.test(v)
const integer = (n: unknown, max: bigint): n is bigint => typeof n === "bigint" && n >= 0n && n < max
function rpcNumber(v: unknown) { fail(typeof v === "string" && /^0x[0-9a-f]{1,64}$/.test(v), "RPC integer"); return BigInt(v) }
function wire(v: unknown): unknown {
  return typeof v === "bigint" ? String(v) : Array.isArray(v) ? v.map(wire) : object(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)])) : v
}
function checkpoint(id: unknown, chainId: string) {
  fail(typeof id === "string" && /^[0-9]{75}$/.test(id), "noncanonical Ponder ID")
  let offset = 0
  const widths = [10, 16, 16, 16, 1, 16], parts = widths.map(width => BigInt(id.slice(offset, offset += width)))
  fail(parts.map((n, i) => String(n).padStart(widths[i], "0")).join("") === id && String(parts[1]) === chainId && parts[4] === 5n, "checkpoint chain/log type")
  return { timestamp: parts[0], block: parts[2] }
}
function prefixRequest(q: unknown, version: 4 | 99 = 99): asserts q is PrefixRequest {
  shape<PrefixRequest>(q, ["domain", "anchor", "pageSize", "after", "token"], "SDK prefix request")
  shape<Domain>(q.domain, ["chainId", "pool", "assetId", "circuitVersion", "settlementDomain"], "SDK domain")
  shape<Anchor>(q.anchor, ["block", "timestamp", "hash"], "SDK anchor")
  fail(address(q.domain.pool) && [1, 2, 3].includes(q.domain.assetId) && q.domain.circuitVersion === version &&
    (version === 99 ? q.domain.chainId === "31337" && q.domain.settlementDomain === "99" :
      ["4217", "42431"].includes(q.domain.chainId) && typeof q.domain.settlementDomain === "string" && /^[1-9][0-9]{0,19}$/.test(q.domain.settlementDomain) && BigInt(q.domain.settlementDomain) < 1n << 64n), "unsupported domain/version")
  fail(decimal(q.anchor.block) && decimal(q.anchor.timestamp) && hash(q.anchor.hash) && Number.isSafeInteger(q.pageSize) && q.pageSize > 0 && q.pageSize <= 1000, "SDK boundary/limit")
  fail(q.after === null || typeof q.after === "string" && /^[0-9]{75}$/.test(q.after), "SDK cursor")
  fail(q.token === null || typeof q.token === "string" && /^[a-f0-9]{64}$/.test(q.token), "SDK prefix token")
}

export function sdkPrefixReader(base: string, fetcher: typeof fetch = fetch) { return prefixReader(base, fetcher, 99) }
export function receivingHistoryPrefixV4(base: string, fetcher: typeof fetch = fetch) { return prefixReader(base, fetcher, 4) }
function prefixReader(base: string, fetcher: typeof fetch, version: 4 | 99) {
  let root: URL
  try { root = new URL(base) } catch { throw new HistoryUnavailable("UNAVAILABLE: invalid SDK endpoint") }
  fail((version === 4 ? root.protocol === "https:" : root.protocol === "http:" && root.hostname === "127.0.0.1" && root.port) && root.pathname === "/" && !root.username && !root.password && !root.hash && !root.search, "invalid SDK endpoint")
  return async (q: PrefixRequest): Promise<unknown> => {
    prefixRequest(q, version)
    const url = new URL(version === 4 ? "/receiving/v4/prefix" : "/prefix", root)
    // First-page rechecks compare the returned token below; the API pairs token with a continuation cursor.
    for (const [k, v] of Object.entries({ pool: q.domain.pool, ...q.anchor, limit: q.pageSize, ...(q.after ? { after: q.after } : {}), ...(q.after && q.token ? { token: q.token } : {}) })) url.searchParams.set(k, String(v))
    let value: unknown
    try {
      const init = { signal: AbortSignal.timeout(10000), redirect: "error", cache: "no-store" } as const
      const response = await fetcher(url, init)
      fail(response.ok, "indexed history is not ready")
      value = await response.json()
    } catch { throw new HistoryUnavailable("UNAVAILABLE: indexed history request failed") }
    if (q.token) fail(object(value) && value.token === q.token, "prefix drift")
    return value
  }
}

async function account(records: Record[], grant: Grant, H: Hash, jub: Jubjub, readAnchor: () => Promise<void>, version: 4 | 99) {
  function point(p: Point, label: string): NativePoint {
    fail(Array.isArray(p) && p.length === 2 && p.every(n => integer(n, FIELD)), label)
    const native = p.map(n => jub.F.e(n)) as NativePoint
    fail(jub.inCurve(native) && jub.inSubgroup(native) && !(p[0] === 0n && p[1] === 1n), label)
    return native
  }
  point(grant.A, "spend-public authority"); point(grant.V, "view-public authority")
  fail(integer(grant.viewScalar, jub.subOrder) && grant.viewScalar > 0n, "view key")
  const coords = (p: NativePoint) => p.map(n => BigInt(jub.F.toString(n))) as Point
  eq(coords(jub.mulPointEscalar(jub.Base8, grant.viewScalar)), grant.V, "view key does not match public authority")
  const D = grant.domain, readKey = H(19701n, D, grant.viewScalar)
  const nf = (C: bigint) => H(19702n, D, readKey, C)
  const rho = (E: Point) => H(954n, D, ...coords(jub.mulPointEscalar(point(E, "note point"), grant.viewScalar)))
  const commitment = (r: bigint, amount: bigint, category: bigint) => H(956n, H(955n, D, ...grant.A, ...grant.V, r, category), amount)
  const owned = new Map<string, Note>(), commitments = new Set<string>(), nullifiers = new Set<string>()
  const insert = (C: bigint) => { fail(integer(C, FIELD) && C !== 0n && !commitments.has(String(C)), "duplicate commitment"); commitments.add(String(C)) }
  const own = (C: bigint, amount: bigint, category: bigint) => {
    const key = String(nf(C)); fail(!owned.has(key), "duplicate owned nullifier"); owned.set(key, { C, amount, category, spent: false })
  }
  let received = 0, spends = 0, changes = 0
  await readAnchor()
  for (const row of records) {
    if (row.type === "incoming") {
      insert(row.C); fail(integer(row.principal, 1n << 128n) && row.principal > 0n, "incoming amount")
      const r = rho(row.E), matches = [1n, 2n].filter(c => commitment(r, row.principal, c) === row.C)
      fail(matches.length <= 1, "ambiguous incoming class")
      if (matches.length) { own(row.C, row.principal, matches[0]); received++ }
      continue
    }
    const s = row.signals
    fail(s.length === 60 && s.every(n => integer(n, FIELD)) && H(953n, BigInt(version), s[10], s[11], s[12], s[13]) === D, "spend framing/domain")
    const nfs = s.slice(15, 19).filter(n => n !== 0n)
    fail(nfs.length > 0 && BigInt(nfs.length) === s[19] && new Set(nfs.map(String)).size === nfs.length, "spend inputs")
    for (const n of nfs) { fail(!nullifiers.has(String(n)), "repeated spend"); nullifiers.add(String(n)) }
    if (s[57] !== 0n) insert(s[57])
    const parents = nfs.map(n => owned.get(String(n)))
    if (!parents.some(Boolean)) continue
    fail(parents.every((n): n is Note => !!n && !n.spent), "missing or spent owned parent")
    const amount = parents.reduce((n, p) => n + p.amount, 0n) - s.slice(20, 30).reduce((n, a) => n + a, 0n) - s[50] - s[51]
    const category = parents.reduce((n, p) => n | p.category, 0n)
    fail(integer(amount, 1n << 128n), "change conservation")
    if (amount === 0n) fail(s[57] === 0n && s[58] === 0n && s[59] === 0n, "zero change")
    else { fail(commitment(rho(s.slice(58, 60) as Point), amount, category) === s[57], "change amount/class/commitment"); own(s[57], amount, category); changes++ }
    for (const p of parents) p.spent = true
    spends++
  }
  await readAnchor()
  const notes = [...owned.values()].filter(n => !n.spent).map(n => ({ commitment: String(n.C), amount: String(n.amount), category: Number(n.category) })).sort((a, b) => a.commitment.localeCompare(b.commitment))
  return { owned, notes, balance: String(notes.reduce((n, x) => n + BigInt(x.amount), 0n)), received, spends, changes }
}

// Authority/runtime pins and readers are supplied independently by the trusted host, never by SQL.
type ScanOptions = {
  authority: unknown; grant: unknown; H: Hash; jub: Jubjub; rpc: Rpc
  readPage(q: PrefixRequest): Promise<unknown>; abi: Abi; pageSize: number
}
export function scanIndexedHistory(args: ScanOptions) { return scanHistory(args, 99) }
export function scanReceivingHistoryV4(args: ScanOptions) { return scanHistory(args, 4) }
async function scanHistory(args: ScanOptions, version: 4 | 99) {
  try {
    const { authority, grant } = structuredClone({ authority: args.authority, grant: args.grant })
    shape<Authority>(authority, ["domain", "anchor", "fromBlock", "fromBlockHash", "runtimeCodeHash", "spendVerifier", "dependencies"], "authority")
    const { domain, anchor } = authority, { H, jub, rpc, readPage, abi, pageSize } = args
    prefixRequest({ domain, anchor, pageSize, after: null, token: null }, version)
    fail(typeof anchor.timestamp === "string" && /^(0|[1-9][0-9]{0,9})$/.test(anchor.timestamp) && decimal(authority.fromBlock) && BigInt(authority.fromBlock) <= BigInt(anchor.block) && hash(authority.fromBlockHash) && hash(authority.runtimeCodeHash), "anchor/range")
    shape<Grant>(grant, ["A", "V", "viewScalar", "domain"], "view-only grant")
    fail(integer(grant.domain, FIELD) && typeof grant.viewScalar === "bigint" && Array.isArray(grant.A) && Array.isArray(grant.V), "view-only grant types")
    fail(typeof H === "function" && jub && typeof rpc === "function" && typeof readPage === "function", "trusted readers")
    fail(grant.domain === H(953n, BigInt(version), BigInt(domain.chainId), BigInt(domain.pool), BigInt(domain.assetId), BigInt(domain.settlementDomain)), "view domain")
    const codePins = new Map<Hex, Hex>()
    fail(Array.isArray(authority.dependencies) && authority.dependencies.length > 0 && authority.dependencies.length <= 32, "dependency manifest")
    for (const dependency of authority.dependencies) {
      shape<{ address: Hex; codeHash: Hex }>(dependency, ["address", "codeHash"], "dependency")
      fail(address(dependency.address) && hash(dependency.codeHash) && !codePins.has(dependency.address), "dependency identity")
      codePins.set(dependency.address, dependency.codeHash)
    }
    fail(codePins.get(domain.pool) === authority.runtimeCodeHash && codePins.has(authority.spendVerifier), "pool/verifier manifest binding")
    type Header = { hash: Hex; transactions: unknown[]; number: string; timestamp: string }
    const headers = new Map<string, Header>(), receipts = new Map<Hex, { [key: string]: unknown }>()
    async function header(number: bigint, requiredHash?: Hex) {
      const b = await rpc({ method: "eth_getBlockByNumber", params: [toHex(number), false] })
      fail(object(b) && hash(b.hash) && rpcNumber(b.number) === number && Array.isArray(b.transactions) && (!requiredHash || b.hash === requiredHash), "canonical header drift")
      const value = b as Header, previous = headers.get(String(number))
      fail(!previous || previous.hash === value.hash, "canonical header drift"); headers.set(String(number), value); return value
    }
    fail(rpcNumber(await rpc({ method: "eth_chainId", params: [] })) === BigInt(domain.chainId), "canonical chain")
    await header(BigInt(authority.fromBlock), authority.fromBlockHash)
    const b = await header(BigInt(anchor.block), anchor.hash)
    fail(rpcNumber(b.timestamp) === BigInt(anchor.timestamp), "canonical anchor timestamp")
    const blockRef = { blockHash: anchor.hash, requireCanonical: true }
    const dependencies = [...codePins]
    for (let offset = 0; offset < dependencies.length; offset += 4) {
      await Promise.all(dependencies.slice(offset, offset + 4).map(async ([address, codeHash]) => {
        const bytes = await rpc({ method: "eth_getCode", params: [address, blockRef] })
        fail(typeof bytes === "string" && /^0x(?:[0-9a-f]{2})+$/.test(bytes) && keccak256(bytes as Hex) === codeHash, "canonical dependency code")
      }))
    }
    async function read(functionName: string, values: readonly unknown[] = []) {
      const data = await rpc({ method: "eth_call", params: [{ to: domain.pool, data: encodeFunctionData({ abi, functionName, args: values }) }, blockRef] })
      fail(typeof data === "string" && /^0x(?:[0-9a-f]{2})*$/.test(data), "canonical state bytes")
      const value = decodeFunctionResult({ abi, functionName, data: data as Hex })
      fail(encodeFunctionResult({ abi, functionName, result: value }) === data, "noncanonical state bytes"); return value
    }
    fail(await read("assetId") === BigInt(domain.assetId) && await read("settlementDomain") === BigInt(domain.settlementDomain), "canonical contract domain")
    if (version === 4) fail(await read("circuitVersion") === 4, "canonical circuit version")
    const slots = ["underlyingToken", "receiver", "master", "registry", "verifier", "hasher", "spendVerifier"]
    for (let offset = 0; offset < slots.length; offset += 4) {
      await Promise.all(slots.slice(offset, offset + 4).map(async slot => {
        const value = await read(slot); fail(typeof value === "string" && codePins.has(value.toLowerCase() as Hex), "missing canonical dependency binding")
      }))
    }
    const verifier = await read("spendVerifier")
    fail(typeof verifier === "string" && verifier.toLowerCase() === authority.spendVerifier, "canonical spend verifier")
    let identity: { token: string; head: Head } | undefined, after: string | null = null, previous = "", pages = 0
    const rows: Row[] = []
    async function page(cursor: string | null) {
      fail(++pages <= 10000, "page budget")
      const p = structuredClone(await readPage({ domain: structuredClone(domain), anchor: structuredClone(anchor), pageSize, after: cursor, token: identity?.token ?? null }))
      shape<Page>(p, ["status", "domain", "anchor", "token", "head", "items", "pageInfo"], "page")
      eq(p.domain, domain, "page domain"); eq(p.anchor, anchor, "page anchor")
      fail(p.status === "PINNED_VIEW_PREFIX" && typeof p.token === "string" && /^[a-f0-9]{64}$/.test(p.token), "page identity")
      shape<Head>(p.head, ["count", "terminalId"], "head")
      fail(Number.isSafeInteger(p.head.count) && p.head.count >= 0 && p.head.count <= 10000 && (p.head.count === 0 ? p.head.terminalId === null : typeof p.head.terminalId === "string" && /^[0-9]{75}$/.test(p.head.terminalId)), "head budget/key")
      const current = { token: p.token, head: p.head }
      if (identity) eq(current, identity, "prefix drift"); else identity = current
      shape<Page["pageInfo"]>(p.pageInfo, ["hasNextPage", "endCursor"], "pageInfo")
      fail(Array.isArray(p.items) && p.items.length <= pageSize && typeof p.pageInfo.hasNextPage === "boolean" && (!p.pageInfo.hasNextPage || p.items.length > 0), "page length")
      return p
    }
    while (true) {
      const p = await page(after); fail(identity, "prefix identity")
      for (const row of p.items) {
        shape<Row>(row, ["id", "pool", "assetId", "txHash", "timestamp", "kind", "payload"], "row")
        const cp = checkpoint(row.id, domain.chainId)
        fail(row.pool === domain.pool && row.assetId === domain.assetId && hash(row.txHash) && row.timestamp === String(cp.timestamp) && row.id > previous && cp.block >= BigInt(authority.fromBlock) && cp.block <= BigInt(anchor.block) && ["leaf", "incoming", "spend"].includes(row.kind), "row scope/order")
        fail(rows.length < identity.head.count && rows.length < 10000, "row budget"); rows.push(row); previous = row.id
      }
      eq(p.pageInfo.endCursor, p.items.at(-1)?.id ?? null, "cursor")
      if (!p.pageInfo.hasNextPage) { fail(rows.length === identity.head.count, "terminal count"); eq(rows.at(-1)?.id ?? null, identity.head.terminalId, "terminal key"); break }
      fail(rows.length < identity.head.count && p.pageInfo.endCursor !== after, "continuation"); after = p.pageInfo.endCursor
    }
    const topics = ["LeafInserted", "NoteAdmitted", "Spent"].map(eventName => encodeEventTopics({ abi, eventName })[0])
    const logs: { [key: string]: unknown }[] = []
    // The public Tempo RPC limits each log query to 100,000 blocks; every range still needs complete evidence.
    for (let from = BigInt(authority.fromBlock); from <= BigInt(anchor.block); from += 100000n) {
      const through = from + 99999n < BigInt(anchor.block) ? from + 99999n : BigInt(anchor.block)
      const chunk = await rpc({ method: "eth_getLogs", params: [{ address: domain.pool, fromBlock: toHex(from), toBlock: toHex(through), topics: [topics] }] })
      fail(Array.isArray(chunk) && chunk.every(object) && logs.length + chunk.length <= 10000, "canonical event coverage")
      for (const log of chunk) fail(rpcNumber(log.blockNumber) >= from && rpcNumber(log.blockNumber) <= through, "canonical log range")
      logs.push(...chunk)
    }
    fail(logs.length === rows.length, "canonical event coverage")
    logs.sort((a, b) => rpcNumber(a.blockNumber) === rpcNumber(b.blockNumber) ? Number(rpcNumber(a.logIndex) - rpcNumber(b.logIndex)) : Number(rpcNumber(a.blockNumber) - rpcNumber(b.blockNumber)))
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i], block = await header(rpcNumber(log.blockNumber))
      fail(typeof log.address === "string" && log.address.toLowerCase() === domain.pool && log.removed !== true && log.blockHash === block.hash && hash(log.transactionHash), "canonical log")
      let receipt = receipts.get(log.transactionHash)
      if (!receipt) {
        const value = await rpc({ method: "eth_getTransactionReceipt", params: [log.transactionHash] })
        fail(object(value), "canonical receipt"); receipt = value; receipts.set(log.transactionHash, value)
      }
      fail(receipt.status === "0x1" && receipt.transactionHash === log.transactionHash && receipt.blockHash === block.hash && rpcNumber(receipt.blockNumber) === rpcNumber(log.blockNumber) && rpcNumber(receipt.transactionIndex) === rpcNumber(log.transactionIndex) && block.transactions[Number(rpcNumber(log.transactionIndex))] === log.transactionHash && Array.isArray(receipt.logs), "canonical receipt")
      const matches = receipt.logs.filter(x => object(x) && rpcNumber(x.logIndex) === rpcNumber(log.logIndex))
      fail(matches.length === 1 && matches[0].address === log.address && matches[0].data === log.data && same(matches[0].topics, log.topics), "canonical receipt log")
      fail(Array.isArray(log.topics) && log.topics.length > 0 && log.topics.every(hash) && typeof log.data === "string" && /^0x(?:[0-9a-f]{2})*$/.test(log.data), "canonical log bytes")
      const event = decodeEventLog({ abi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true })
      fail(event.eventName === "LeafInserted" || event.eventName === "NoteAdmitted" || event.eventName === "Spent", "unexpected event")
      const eventAbi = abi.find(x => x.type === "event" && x.name === event.eventName)
      fail(eventAbi?.type === "event" && object(event.args), "canonical event ABI")
      const eventArgs = event.args, dataInputs = eventAbi.inputs.filter(x => !x.indexed)
      eq(encodeEventTopics({ abi, eventName: event.eventName, args: eventArgs }), log.topics, "canonical topics")
      fail(encodeAbiParameters(dataInputs, dataInputs.map(x => eventArgs[x.name!])) === log.data, "canonical event bytes")
      const id = [rpcNumber(block.timestamp), BigInt(domain.chainId), rpcNumber(log.blockNumber), rpcNumber(log.transactionIndex), 5n, rpcNumber(log.logIndex)].map((n, j) => String(n).padStart([10, 16, 16, 16, 1, 16][j], "0")).join("")
      eq(rows[i], { id, pool: domain.pool, assetId: domain.assetId, txHash: log.transactionHash, timestamp: String(rpcNumber(block.timestamp)), kind: { LeafInserted: "leaf", NoteAdmitted: "incoming", Spent: "spend" }[event.eventName], payload: wire(event.args) }, "canonical row payload")
    }
    const zeros = [0n]; for (let i = 0; i < 32; i++) zeros.push(H(zeros[i], zeros[i]))
    const commitments: bigint[] = [], leaves = new Map<string, Row>(), usedLeaves = new Set<string>(), records: Record[] = [], knownRoots = new Set([String(zeros[32])])
    function root() {
      let nodes = new Map(commitments.map((v, i) => [i, v]))
      for (let level = 0; level < 32; level++) {
        const next = new Map<number, bigint>()
        for (const i of nodes.keys()) { const p = Math.floor(i / 2); if (!next.has(p)) next.set(p, H(nodes.get(p * 2) ?? zeros[level], nodes.get(p * 2 + 1) ?? zeros[level])) }
        nodes = next
      }
      return nodes.get(0) ?? zeros[32]
    }
    function associate(row: Row, C: bigint, kind: number) {
      const leaf = leaves.get(String(C))
      fail(leaf && object(leaf.payload) && leaf.payload.kind === kind && leaf.txHash === row.txHash && leaf.id < row.id && !usedLeaves.has(String(C)), "missing/duplicate root or change lineage"); usedLeaves.add(String(C))
    }
    for (const row of rows) {
      const p = row.payload
      if (row.kind === "leaf") {
        shape<{ commitment: string; index: number; kind: number }>(p, ["commitment", "index", "kind"], "leaf payload")
        fail(typeof p.commitment === "string" && /^[1-9][0-9]{0,76}$/.test(p.commitment) && BigInt(p.commitment) < FIELD && p.index === commitments.length && [0, 1].includes(p.kind) && !leaves.has(p.commitment), "leaf gap/identity")
        commitments.push(BigInt(p.commitment)); leaves.set(p.commitment, row); knownRoots.add(String(root()))
      } else if (row.kind === "incoming") {
        shape<{ commitment: string; ex: string; ey: string; principal: string }>(p, ["commitment", "ex", "ey", "principal"], "incoming payload")
        for (const k of Object.values(p)) fail(typeof k === "string" && /^(0|[1-9][0-9]{0,77})$/.test(k), "incoming integer")
        const C = BigInt(p.commitment); associate(row, C, 0); records.push({ type: "incoming", C, E: [BigInt(p.ex), BigInt(p.ey)], principal: BigInt(p.principal) })
      } else {
        shape<{ signals: string[]; changeEnvelope: Hex }>(p, ["signals", "changeEnvelope"], "spend payload")
        fail(Array.isArray(p.signals) && p.signals.length === 60 && p.signals.every(n => typeof n === "string" && /^(0|[1-9][0-9]{0,77})$/.test(n) && BigInt(n) < FIELD), "spend fields")
        const s = p.signals.map(BigInt)
        fail(s[10] === BigInt(domain.chainId) && s[11] === BigInt(domain.pool) && s[12] === BigInt(domain.assetId) && s[13] === BigInt(domain.settlementDomain) && knownRoots.has(String(s[14])), "spend domain/root")
        fail(typeof p.changeEnvelope === "string" && /^0x(?:[0-9a-f]{2}){0,4096}$/.test(p.changeEnvelope), "change bytes")
        const body = encodeAbiParameters(spendBodyParameters, [s.slice(10, 55), s[57], s[58], s[59], p.changeEnvelope])
        const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(hexToBytes(body))))
        let digest = 0n; for (const byte of digestBytes) digest = (digest << 8n) + BigInt(byte)
        fail(s[55] === (digest & ((1n << 128n) - 1n)) && s[56] === digest >> 128n, "spend body")
        if (s[57] !== 0n) { associate(row, s[57], 1); fail(p.changeEnvelope.startsWith(version === 4 ? "0x505204" : "0x505263") && p.changeEnvelope.length >= 136 && BigInt("0x" + p.changeEnvelope.slice(8, 72)) === s[58] && BigInt("0x" + p.changeEnvelope.slice(72, 136)) === s[59], "change point bytes") }
        else fail(p.changeEnvelope === "0x", "zero change bytes")
        records.push({ type: "spend", signals: s })
      }
    }
    fail(usedLeaves.size === leaves.size, "unassociated leaf lineage")
    fail(await read("nextLeafIndex") === BigInt(commitments.length) && await read("currentRoot") === root(), "canonical tree root/count")
    const readAnchor = async () => { await header(BigInt(anchor.block), anchor.hash); await page(null) }
    const result = await account(records, grant, H, jub, readAnchor, version)
    for (const [nullifier, note] of result.owned) fail(await read("nullifiers", [BigInt(nullifier)]) === note.spent, "canonical owned spent state")
    for (const [number, block] of [...headers]) await header(BigInt(number), block.hash)
    await readAnchor(); fail(rpcNumber(await rpc({ method: "eth_chainId", params: [] })) === BigInt(domain.chainId), "canonical chain drift")
    fail(identity, "prefix identity")
    const { owned, ...accounting } = result
    if (version === 4) return { ...accounting,
      historicalNotes: [...owned].map(([nullifierHash, n]) => ({ commitment: String(n.C), nullifierHash, amount: String(n.amount), category: Number(n.category), spent: n.spent })),
      historyStatus: "PINNED_V4_ACCOUNTING_VALIDATED" as const, accountingStatus: "verified" as const, proofEnforcement: "PINNED_CONTRACT_AND_VERIFIER" as const, prefixToken: identity.token }
    return { ...accounting, historyStatus: "INDEXED_QA_ACCOUNTING_VALIDATED" as const, productionHistoryStatus: "UNAVAILABLE" as const, groth16Verified: false as const, guardedCandidate: true as const, proofEnforcement: "PINNED_LOCAL_CONTRACT_AND_VERIFIER" as const, prefixToken: identity.token,
      openGates: ["PROVIDER_AND_PRODUCTION_COVERAGE_UNQUALIFIED", "ACTIVE_SDK_EXPORTS_AND_ROUTES_NOT_ENABLED", "PRODUCTION_CEREMONY_AND_VERSION_CUTOVER"] }
  } catch (error) {
    if (error instanceof HistoryUnavailable) throw error
    throw new HistoryUnavailable("UNAVAILABLE: indexed history acquisition, decoding or accounting failed")
  }
}
