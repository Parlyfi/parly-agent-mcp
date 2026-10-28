import { buildBabyjub, buildPoseidon } from "circomlibjs"
import { assertReceivingProfileV4, type ReceivingProfileV4 } from "@parly/crypto-utils/receiving-profile-v4"
import { deriveRecipientKeys, type RecipientKeyContext } from "@parly/crypto-utils/recipient-keys"
import { scanReceivingHistoryV4, receivingHistoryPrefixV4 } from "./receiving-history-candidate.js"
import { parseAbi, toHex, type Abi, type Address, type Hex } from "viem"

export type ReceivingBrowserRpcV4 = (request: { method: string; params: unknown[] }) => Promise<unknown>
export function shareReceivingCodeReadsV4(rpc: ReceivingBrowserRpcV4): ReceivingBrowserRpcV4 {
  const pending = new Map<string, Promise<unknown>>()
  return async request => {
    const ref = request.params[1] as { blockHash?: unknown; requireCanonical?: unknown } | undefined
    if (request.method !== "eth_getCode" || !ref || typeof ref.blockHash !== "string" || ref.requireCanonical !== true) return rpc(request)
    const key = JSON.stringify(request)
    const read = pending.get(key) ?? rpc(request)
    pending.set(key, read)
    try { return await read }
    finally { if (pending.get(key) === read) pending.delete(key) }
  }
}
export type ReceivingDeploymentV4 = { fromBlock: string; fromBlockHash: Hex }
export type ReceivingRecoveryModeV4 = { profile: ReceivingProfileV4; keyEnvironment: RecipientKeyContext["environment"]; newDepositsEnabled?: boolean; deployments?: Partial<Record<1 | 2 | 3, ReceivingDeploymentV4>> }
export type ReceivingRecoveryContextV4 = ReceivingRecoveryModeV4 & {
  deployments: Partial<Record<1 | 2 | 3, ReceivingDeploymentV4>>
  ponderUrl: string
  rpc: ReceivingBrowserRpcV4
}
export type RecoveredNoteV4 = {
  payload: { version: 4; chainId: number; poolAddress: Address; assetId: string; amount: string; rho: string; category: 1 | 2 | 3 }
  envelope: Hex; commitment: Hex; nullifierHash: Hex; amount: bigint
  status: "live"; kind: "deposit" | "change"; leafIndex: number; txHash: string; timestamp: string
}
export type RecoveredAssetStateV4 = {
  version: 4; ownerAddress: Address; poolAddress: Address; assetId: 1 | 2 | 3; notes: RecoveredNoteV4[]; largest: RecoveredNoteV4 | null; total: bigint; source: "chain"
  history: { notes: HistoricalNoteV4[]; leaves: bigint[]; root: bigint; anchor: { block: string; timestamp: string; hash: Hex }; prefixToken: string; spends: { txHash: Hex; timestamp: string; nullifierHashes: Hex[]; signals: string[] }[] }
}
export type HistoricalNoteV4 = {
  commitment: Hex; nullifierHash: Hex; amount: bigint; category: 1 | 2 | 3; status: "live" | "spent";
  kind: "deposit" | "change"; leafIndex: number; txHash: string; timestamp: string; spentByTxHash?: string; consolidation: boolean
}

export const receivingPoolV4BrowserAbi: Abi = parseAbi([
  ...["underlyingToken", "receiver", "master", "registry", "verifier", "hasher", "spendVerifier"].map(n => `function ${n}() view returns(address)`),
  "function circuitVersion() view returns(uint8)", "function assetId() view returns(uint256)", "function settlementDomain() view returns(uint256)",
  "function nextLeafIndex() view returns(uint64)", "function currentRoot() view returns(uint256)", "function nullifiers(uint256) view returns(bool)",
  "function knownRoots(uint256) view returns(bool)", "function globalFeeBps() view returns(uint256)",
  "function spend(bytes,uint256[60],bytes)",
  "event LeafInserted(uint256 indexed commitment,uint32 indexed index,uint8 kind)",
  "event NoteAdmitted(uint256 indexed commitment,uint256 ex,uint256 ey,uint256 principal)",
  "event Spent(uint256[60] signals,bytes changeEnvelope)"
])
function check(ok: unknown): asserts ok { if (!ok) throw Error("UNAVAILABLE: V4 private balance recovery") }
let primitives: Promise<{ jub: Awaited<ReturnType<typeof buildBabyjub>>; poseidon: Awaited<ReturnType<typeof buildPoseidon>> }> | undefined
export async function browserRecipientKeysV4(privateKeyB64: string, context: RecipientKeyContext) {
  check(typeof privateKeyB64 === "string" && /^[A-Za-z0-9+/]{43}=$/.test(privateKeyB64))
  const root = Uint8Array.from(atob(privateKeyB64), c => c.charCodeAt(0))
  try {
    check(root.length === 32 && btoa(String.fromCharCode(...root)) === privateKeyB64)
    const keys = await deriveRecipientKeys(root, context)
    keys.sodiumSeed.fill(0)
    primitives ??= Promise.all([buildBabyjub(), buildPoseidon()]).then(([jub, poseidon]) => ({ jub, poseidon }))
    const { jub, poseidon } = await primitives
    const H = (...values: bigint[]) => BigInt(poseidon.F.toString(poseidon(values)))
    const coords = (point: Uint8Array[]) => point.map(n => BigInt(jub.F.toString(n))) as [bigint, bigint]
    const point = (scalar: bigint) => coords(jub.mulPointEscalar(jub.Base8, scalar))
    const multiply = (p: bigint[], scalar: bigint) => coords(jub.mulPointEscalar(p.map(n => jub.F.e(n)), scalar))
    return { jub, H, point, multiply, A: point(keys.spendScalar), V: point(keys.viewScalar), spendScalar: keys.spendScalar, viewScalar: keys.viewScalar }
  } finally { root.fill(0) }
}

export async function recoverNotesForAssetV4(args: ReceivingRecoveryModeV4 & {
  origin: string; ownerAddress: Address; privateKeyB64: string; assetId: 1 | 2 | 3; deployment: ReceivingDeploymentV4
  ponderUrl: string; rpc: ReceivingBrowserRpcV4; fetcher?: typeof fetch; isCurrent(): boolean
}): Promise<RecoveredAssetStateV4> {
  check(args.isCurrent())
  const profile = structuredClone(args.profile), deployment = structuredClone(args.deployment)
  assertReceivingProfileV4(profile)
  check(profile.origin === args.origin && deployment && /^(0|[1-9][0-9]{0,15})$/.test(deployment.fromBlock) && /^0x[a-f0-9]{64}$/.test(deployment.fromBlockHash))
  const asset = profile.assets.find(a => a.assetId === args.assetId)
  check(asset)
  const { jub, H, multiply, A, V, viewScalar } = await browserRecipientKeysV4(args.privateKeyB64, { version: 1, walletAddress: args.ownerAddress, environment: args.keyEnvironment, origin: profile.origin })
  check(args.isCurrent())
  const header = await args.rpc({ method: "eth_getBlockByNumber", params: ["finalized", false] }) as { number: Hex; timestamp: Hex; hash: Hex }
  check(header && /^0x[0-9a-f]+$/.test(header.number) && /^0x[0-9a-f]+$/.test(header.timestamp) && /^0x[a-f0-9]{64}$/.test(header.hash))
  const anchor = { block: String(BigInt(header.number)), timestamp: String(BigInt(header.timestamp)), hash: header.hash }
  const domain = { chainId: String(profile.chainId), pool: asset.pool.toLowerCase() as Hex, assetId: args.assetId, circuitVersion: 4 as const, settlementDomain: String(profile.settlementDomain) }
  const D = H(953n, 4n, BigInt(profile.chainId), BigInt(asset.pool), BigInt(asset.assetId), profile.settlementDomain)
  const readPage = receivingHistoryPrefixV4(args.ponderUrl, args.fetcher)
  type Row = { id: string; txHash: string; timestamp: string; kind: string; payload: Record<string, unknown> }
  const rows = new Map<string, Row>()
  const result = await scanReceivingHistoryV4({ authority: { domain, anchor, ...deployment,
    runtimeCodeHash: profile.codePins.find(p => p.address.toLowerCase() === domain.pool)?.codeHash,
    spendVerifier: profile.proofs.spend.toLowerCase(), dependencies: profile.codePins.map(p => ({ address: p.address.toLowerCase(), codeHash: p.codeHash })) },
    grant: { A, V, viewScalar, domain: D }, H, jub, rpc: args.rpc, abi: receivingPoolV4BrowserAbi, pageSize: 1000,
    readPage: async q => {
      check(args.isCurrent())
      const page = structuredClone(await readPage(q)) as { items?: Row[] }
      if (Array.isArray(page?.items)) for (const row of page.items) rows.set(row.id, structuredClone(row))
      return page
    }
  })
  check(args.isCurrent() && result.historyStatus === "PINNED_V4_ACCOUNTING_VALIDATED")
  const canonical = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)), leaves: bigint[] = []
  const spends: RecoveredAssetStateV4["history"]["spends"] = []
  const origins = new Map<string, { E: bigint[]; row: Row; envelope: Hex; kind: "deposit" | "change" }>()
  for (const row of canonical) {
    const p = row.payload
    if (row.kind === "leaf") leaves.push(BigInt(p.commitment as string))
    if (row.kind === "incoming") origins.set(String(p.commitment), { E: [BigInt(p.ex as string), BigInt(p.ey as string)], row, envelope: "0x", kind: "deposit" })
    if (row.kind === "spend") {
      const s = (p.signals as string[]).map(BigInt)
      spends.push({ txHash: row.txHash as Hex, timestamp: row.timestamp, signals: s.map(String), nullifierHashes: s.slice(15, 19).filter(n => n !== 0n).map(n => toHex(n, { size: 32 })) })
      if (s[57] !== 0n) origins.set(String(s[57]), { E: s.slice(58, 60), row, envelope: p.changeEnvelope as Hex, kind: "change" })
    }
  }
  const readKey = H(19701n, D, viewScalar)
  const notes = result.notes.map(note => {
    const origin = origins.get(note.commitment), C = BigInt(note.commitment), amount = BigInt(note.amount), category = note.category as 1 | 2 | 3
    check(origin && [1, 2, 3].includes(category))
    const rho = H(954n, D, ...multiply(origin.E, viewScalar)), leafIndex = leaves.indexOf(C)
    check(leafIndex >= 0 && H(956n, H(955n, D, ...A, ...V, rho, BigInt(category)), amount) === C)
    return { payload: { version: 4 as const, chainId: profile.chainId, poolAddress: asset.pool, assetId: String(asset.assetId), amount: String(amount), rho: String(rho), category }, envelope: origin.envelope,
      commitment: toHex(C, { size: 32 }), nullifierHash: toHex(H(19702n, D, readKey, C), { size: 32 }), amount, status: "live" as const, kind: origin.kind, leafIndex, txHash: origin.row.txHash, timestamp: origin.row.timestamp }
  }).sort((a, b) => a.amount === b.amount ? b.leafIndex - a.leafIndex : a.amount > b.amount ? -1 : 1)
  const total = notes.reduce((sum, note) => sum + note.amount, 0n)
  check(total === BigInt(result.balance))
  const historicalNotes: HistoricalNoteV4[] = result.historicalNotes.map(note => {
    const origin = origins.get(note.commitment), C = BigInt(note.commitment), leafIndex = leaves.indexOf(C)
    const nullifierHash = toHex(BigInt(note.nullifierHash), { size: 32 }), spend = spends.find(s => s.nullifierHashes.includes(nullifierHash))
    check(origin && leafIndex >= 0 && Boolean(spend) === note.spent)
    return { commitment: toHex(C, { size: 32 }), nullifierHash, amount: BigInt(note.amount), category: note.category as 1 | 2 | 3,
      status: note.spent ? "spent" : "live", kind: origin.kind, leafIndex, txHash: origin.row.txHash, timestamp: origin.row.timestamp,
      spentByTxHash: spend?.txHash, consolidation: origin.kind === "change" && [1n, 3n].includes(BigInt((origin.row.payload.signals as string[])[53])) }
  })
  let level = leaves
  let zero = 0n
  for (let i = 0; i < 32; i++) {
    const next: bigint[] = []
    for (let j = 0; j < level.length; j += 2) next.push(H(level[j], level[j + 1] ?? zero))
    level = next; zero = H(zero, zero)
  }
  return { version: 4, ownerAddress: args.ownerAddress, poolAddress: asset.pool, assetId: args.assetId, notes, largest: notes[0] ?? null, total, source: "chain", history: { notes: historicalNotes, leaves, root: level[0] ?? zero, anchor, prefixToken: result.prefixToken, spends } }
}
