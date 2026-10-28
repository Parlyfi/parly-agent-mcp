import { buildIndexedMerklePath } from "@parly/crypto-utils"
import { assertReceivingProfileV4, receivingProfileJsonV4, type ReceivingProfileV4 } from "@parly/crypto-utils/receiving-profile-v4"
import { RELAY_EXECUTION_FEE_SCHEDULE_V2_DOMAIN, RELAY_EXECUTION_FEE_SCHEDULE_V2_TYPES, type CanonicalRelayExecutionPayloadV4, type RelayerRegistryEntry, type SignedRelayExecutionFeeScheduleV2 } from "@parly/shared-types"
import { decodeAbiParameters, decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, getAddress, hashTypedData, isAddress, keccak256, parseAbi, sha256, toHex, verifyTypedData, type Abi, type AbiParameter, type Address, type Hex } from "viem"
import { browserRecipientKeysV4, receivingPoolV4BrowserAbi, type ReceivingBrowserRpcV4, type ReceivingRecoveryModeV4, type RecoveredAssetStateV4, type RecoveredNoteV4 } from "./current-recovery-v4.js"
import type { ReceivingProverV4 } from "./current-prover-v4.js"
import type { PoolV4Runtime } from "./current-runtime.js"

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const LIMIT = 1n << 128n
const proofParameters = [{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }] as const
const verifierAbi = parseAbi(["function verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[60]) view returns(bool)"])
export type PoolV4BrowserOutput = { destination: Address; amount: bigint; settlementDomain?: bigint }
export type PoolV4BrowserExecutionArgs = ReceivingRecoveryModeV4 & {
  runtime: PoolV4Runtime;
  ownerAddress: Address; recoveryPrivateKeyB64: string; assetId: 1 | 2 | 3; sourceNotes: RecoveredNoteV4[]
  state: RecoveredAssetStateV4; outputs: PoolV4BrowserOutput[]; executionKind?: "send" | "consolidation"
  relayMode: "self" | "private"; rpc: ReceivingBrowserRpcV4; isCurrent(): boolean
  selectedRelayer?: RelayerRegistryEntry | null; proofExecutor?: Address; relayExecutionFeeOverride?: bigint
  onProgress?: (stage: "generating_proof" | "broadcasting") => void
}
export type PoolV4BrowserPreview = {
  amount: bigint; recipientCount: number; protocolFee: bigint; relayExecutionFee: bigint
  totalNeededFromNotes: bigint; totalPrivateBalanceUsed: bigint; changeAfterExecution: bigint; inputCount: number
  selectedRelayer: RelayerRegistryEntry | null
}
function check(ok: unknown, message = "Private balance execution is unavailable. Refresh and try again."): asserts ok { if (!ok) throw Error(message) }
const random = (length: number) => {
  const bytes = crypto.getRandomValues(new Uint8Array(length)), value = BigInt(toHex(bytes))
  bytes.fill(0); check(value > 0n); return value
}
function validate(args: PoolV4BrowserExecutionArgs) {
  check(args.isCurrent())
  check(args.relayMode === "self" || args.relayMode === "private")
  check(!args.proofExecutor || args.relayMode === "private" && isAddress(args.proofExecutor) && BigInt(args.proofExecutor) !== 0n)
  check(args.relayExecutionFeeOverride === undefined || args.proofExecutor && typeof args.relayExecutionFeeOverride === "bigint" && args.relayExecutionFeeOverride >= 0n)
  if (args.relayMode === "private") check(args.selectedRelayer && isAddress(args.selectedRelayer.executionAddress) && BigInt(args.selectedRelayer.executionAddress) !== 0n, "No verified private relayer is currently available.")
  assertReceivingProfileV4(args.profile)
  check(args.profile.origin === args.runtime.origin && isAddress(args.ownerAddress) && BigInt(args.ownerAddress) !== 0n)
  const asset = args.profile.assets.find(a => a.assetId === args.assetId)
  check(asset && args.state.version === 4 && args.state.assetId === args.assetId)
  check(args.sourceNotes.length > 0 && args.sourceNotes.length <= 4)
  const commitments = new Set<string>(), nullifiers = new Set<string>()
  for (const note of args.sourceNotes) {
    const p = note.payload
    check(note.status === "live" && p.version === 4 && p.chainId === args.profile.chainId && p.assetId === String(args.assetId) && p.poolAddress.toLowerCase() === asset.pool.toLowerCase())
    check(typeof note.amount === "bigint" && note.amount > 0n && note.amount < LIMIT && p.amount === String(note.amount) && /^[0-9]+$/.test(p.rho) && BigInt(p.rho) < FIELD && [1, 2, 3].includes(p.category))
    check(/^0x[0-9a-f]{64}$/.test(note.commitment) && /^0x[0-9a-f]{64}$/.test(note.nullifierHash))
    check(!commitments.has(note.commitment) && !nullifiers.has(note.nullifierHash), "Selected notes must be unique.")
    commitments.add(note.commitment); nullifiers.add(note.nullifierHash)
    check(Number.isSafeInteger(note.leafIndex) && note.leafIndex >= 0 && args.state.history.leaves[note.leafIndex] === BigInt(note.commitment))
  }
  const consolidate = args.executionKind === "consolidation"
  check(consolidate ? args.sourceNotes.length >= 2 && args.outputs.length === 0 : args.outputs.length > 0 && args.outputs.length <= 10)
  for (const output of args.outputs) {
    check(isAddress(output.destination) && BigInt(output.destination) !== 0n && output.amount > 0n && output.amount < LIMIT)
    check(output.settlementDomain === undefined || output.settlementDomain === args.profile.settlementDomain, "Cross-chain sending is unavailable for these notes.")
  }
  return { asset, consolidate }
}
async function snapshot(profile: ReceivingProfileV4, rpc: ReceivingBrowserRpcV4) {
  check(await rpc({ method: "eth_chainId", params: [] }) === toHex(profile.chainId))
  const block = await rpc({ method: "eth_getBlockByNumber", params: ["latest", false] }) as { hash: Hex; number: Hex }
  check(block && /^0x[0-9a-f]{64}$/.test(block.hash) && /^0x[0-9a-f]+$/.test(block.number))
  const ref = { blockHash: block.hash, requireCanonical: true }
  for (const pin of profile.codePins) {
    const code = await rpc({ method: "eth_getCode", params: [pin.address, ref] })
    check(typeof code === "string" && /^0x(?:[0-9a-f]{2})+$/.test(code) && keccak256(code as Hex) === pin.codeHash)
  }
  async function read(to: Address, functionName: string, values: readonly unknown[] = [], abi: Abi = receivingPoolV4BrowserAbi) {
    const data = await rpc({ method: "eth_call", params: [{ to, data: encodeFunctionData({ abi, functionName, args: values }) }, ref] })
    check(typeof data === "string" && /^0x(?:[0-9a-f]{2})*$/.test(data))
    const result = decodeFunctionResult({ abi, functionName, data: data as Hex })
    check(encodeFunctionResult({ abi, functionName, result }) === data)
    return result
  }
  async function finish() {
    const canonical = await rpc({ method: "eth_getBlockByNumber", params: [block.number, false] }) as typeof block
    check(canonical?.hash === block.hash && canonical.number === block.number && await rpc({ method: "eth_chainId", params: [] }) === toHex(profile.chainId))
  }
  return { read, finish }
}
async function previewCore(args: PoolV4BrowserExecutionArgs) {
  const { asset, consolidate } = validate(args), s = await snapshot(args.profile, args.rpc)
  for (const [name, expected] of Object.entries({ circuitVersion: 4, assetId: args.assetId, settlementDomain: args.profile.settlementDomain, underlyingToken: asset.token, registry: args.profile.registry, receiver: args.profile.receiver, master: args.profile.master, verifier: args.profile.verifier, hasher: args.profile.hasher, spendVerifier: args.profile.proofs.spend })) check(String(await s.read(asset.pool, name)).toLowerCase() === String(expected).toLowerCase())
  const feeBps = await s.read(asset.pool, "globalFeeBps")
  check(typeof feeBps === "bigint" && feeBps >= 0n && feeBps <= 100n)
  for (const note of args.sourceNotes) check(await s.read(asset.pool, "nullifiers", [BigInt(note.nullifierHash)]) === false, "A selected note is already spent. Refresh your private balance.")
  check(await s.read(asset.pool, "knownRoots", [args.state.history.root]) === true, "Your private balance history must be refreshed.")
  const amount = args.outputs.reduce((sum, output) => sum + output.amount, 0n), totalInput = args.sourceNotes.reduce((sum, note) => sum + note.amount, 0n)
  const feeSchedule = args.relayMode === "private" && !args.proofExecutor ? await selectPoolV4FeeSchedule(args) : null
  const relayExecutionFee = feeSchedule ? BigInt(feeSchedule.schedule.executorFee) : args.relayExecutionFeeOverride ?? 0n
  check(relayExecutionFee < LIMIT && (consolidate || relayExecutionFee <= (args.outputs.length === 1 ? 5000n : 10000n)), "The private relay fee exceeds this pool's immutable limit.")
  const protocolFee = args.outputs.reduce((sum, output) => sum + output.amount * feeBps / 10000n, 0n), totalNeeded = amount + protocolFee + relayExecutionFee
  check(totalInput < LIMIT && amount < LIMIT && totalNeeded < LIMIT && totalInput >= totalNeeded, "Private balance is insufficient for payout and fees.")
  check(!consolidate || totalInput > 0n)
  await s.finish(); check(args.isCurrent())
  const preview: PoolV4BrowserPreview = { amount, recipientCount: args.outputs.length, protocolFee, relayExecutionFee, totalNeededFromNotes: totalNeeded, totalPrivateBalanceUsed: totalInput, changeAfterExecution: totalInput - totalNeeded, inputCount: args.sourceNotes.length, selectedRelayer: args.relayMode === "private" ? args.selectedRelayer! : null }
  return { asset, consolidate, s, preview, feeSchedule }
}

export async function selectPoolV4FeeSchedule(args: PoolV4BrowserExecutionArgs): Promise<SignedRelayExecutionFeeScheduleV2> {
  const relayer = args.selectedRelayer, pool = args.profile.assets.find(a => a.assetId === args.assetId)?.pool, now = Math.floor(Date.now() / 1000)
  check(relayer && pool, "No verified private relayer is currently available.")
  const candidates = (relayer.feeSchedules ?? []).filter(({ schedule: s }) => s.chainId === args.profile.chainId && s.pool.toLowerCase() === pool.toLowerCase() && s.relayer.toLowerCase() === relayer.executionAddress.toLowerCase() && s.executionMode === (args.executionKind === "consolidation" ? 1 : 0) && s.inputCount === args.sourceNotes.length && s.outputCount === args.outputs.length && s.validAfter <= now && s.expiry > now)
  check(candidates.length === 1, "An exact active private relay fee schedule is unavailable. Refresh and try again.")
  const selected = structuredClone(candidates[0]!), s = selected.schedule
  check(/^[1-9][0-9]{0,38}$/.test(s.executorFee) && /^[1-9][0-9]{0,77}$/.test(s.maximumGasPrice) && /^0x[a-fA-F0-9]{64}$/.test(s.scheduleNonce) && BigInt(s.scheduleNonce) !== 0n && Number.isSafeInteger(s.validAfter) && s.validAfter > 0 && Number.isSafeInteger(s.expiry) && s.expiry - s.validAfter <= 900)
  const typed = { domain: { ...RELAY_EXECUTION_FEE_SCHEDULE_V2_DOMAIN, chainId: args.profile.chainId }, types: RELAY_EXECUTION_FEE_SCHEDULE_V2_TYPES, primaryType: "RelayExecutionFeeScheduleV2" as const, message: { ...s, chainId: BigInt(s.chainId), pool: getAddress(s.pool), relayer: getAddress(s.relayer), executorFee: BigInt(s.executorFee), maximumGasPrice: BigInt(s.maximumGasPrice), validAfter: BigInt(s.validAfter), expiry: BigInt(s.expiry) } }
  check(hashTypedData(typed).toLowerCase() === selected.scheduleHash.toLowerCase() && await verifyTypedData({ ...typed, address: getAddress(relayer.executionAddress), signature: selected.signature }), "The private relay fee schedule signature is invalid.")
  const { readRelayRewardPolicyV4, relayRewardPolicyTargetV4 } = await import("@parly/protocol-abis/relay-reward-policy-v4")
  const policy = await readRelayRewardPolicyV4({
    getChainId: async () => Number(BigInt(await args.rpc({ method: "eth_chainId", params: [] }) as string)),
    getBlock: async ref => { const b = await args.rpc({ method: "eth_getBlockByNumber", params: ["blockNumber" in ref ? toHex(ref.blockNumber) : ref.blockTag, false] }) as { number: Hex; hash: Hex }; return { number: BigInt(b.number), hash: b.hash } },
    getCode: async q => await args.rpc({ method: "eth_getCode", params: [q.address, toHex(q.blockNumber)] }) as Hex,
    readContract: async q => decodeFunctionResult({ abi: q.abi, functionName: q.functionName, data: await args.rpc({ method: "eth_call", params: [{ to: q.address, data: encodeFunctionData({ abi: q.abi, functionName: q.functionName }) }, toHex(q.blockNumber)] }) as Hex })
  }, relayRewardPolicyTargetV4(args.runtime.relayRewardPolicyEnv, args.profile.chainId, "NEXT_PUBLIC_"))
  check(BigInt(s.executorFee) <= (s.outputCount === 1 ? policy.singleSourceMaximum : policy.batchSourceMaximum), "The private relay fee exceeds the current quote policy.")
  check(BigInt(await args.rpc({ method: "eth_gasPrice", params: [] }) as string) <= BigInt(s.maximumGasPrice), "The private relay fee schedule is outside its gas-price limit.")
  return selected
}
export async function previewPoolV4BrowserExecution(args: PoolV4BrowserExecutionArgs): Promise<PoolV4BrowserPreview> { return (await previewCore(args)).preview }

export async function readPoolV4ProtocolFee(args: Pick<PoolV4BrowserExecutionArgs, "profile" | "rpc" | "assetId" | "outputs">) {
  assertReceivingProfileV4(args.profile)
  const asset = args.profile.assets.find(a => a.assetId === args.assetId)
  check(asset)
  const s = await snapshot(args.profile, args.rpc), feeBps = await s.read(asset.pool, "globalFeeBps")
  check(typeof feeBps === "bigint" && feeBps >= 0n && feeBps <= 100n)
  await s.finish()
  return args.outputs.reduce((sum, output) => sum + output.amount * feeBps / 10000n, 0n)
}

export async function preparePoolV4BrowserExecution(input: PoolV4BrowserExecutionArgs) {
  // Snapshot reviewed amounts and note witnesses before the first asynchronous operation.
  const args = { ...input, selectedRelayer: input.selectedRelayer ? structuredClone(input.selectedRelayer) : null, profile: structuredClone(input.profile), sourceNotes: structuredClone(input.sourceNotes), state: structuredClone(input.state), outputs: structuredClone(input.outputs) }
  const { asset, consolidate, s, preview, feeSchedule } = await previewCore(args)
  const { H, point, multiply, A, V, spendScalar, viewScalar } = await browserRecipientKeysV4(args.recoveryPrivateKeyB64, { version: 1, walletAddress: args.ownerAddress, environment: args.keyEnvironment, origin: args.profile.origin })
  const D = H(953n, 4n, BigInt(args.profile.chainId), BigInt(asset.pool), BigInt(asset.assetId), args.profile.settlementDomain), readKey = H(19701n, D, viewScalar)
  for (const note of args.sourceNotes) {
    const C = H(956n, H(955n, D, ...A, ...V, BigInt(note.payload.rho), BigInt(note.payload.category)), note.amount)
    check(C === BigInt(note.commitment) && H(19702n, D, readKey, C) === BigInt(note.nullifierHash), "The selected note does not match this unlocked wallet.")
  }
  const zeros = [0n]; for (let i = 0; i < 32; i++) zeros.push(H(zeros[i], zeros[i]))
  const paths = args.sourceNotes.map(note => buildIndexedMerklePath({ levels: 32, leaves: args.state.history.leaves.map((value, index) => ({ index, value })), leafIndex: note.leafIndex, zeros, hash: (a, b) => H(a, b) }))
  check(paths.every(path => path.root === args.state.history.root))
  const amounts = [...args.outputs.map(o => o.amount), ...Array<bigint>(10 - args.outputs.length).fill(0n)]
  const recipients = [...args.outputs.map(o => BigInt(o.destination)), ...Array<bigint>(10 - args.outputs.length).fill(0n)]
  const domains = Array<bigint>(10).fill(args.profile.settlementDomain), nfs = [...args.sourceNotes.map(n => BigInt(n.nullifierHash)), ...Array<bigint>(4 - args.sourceNotes.length).fill(0n)]
  const changeAmount = preview.changeAfterExecution, changeScalar = changeAmount > 0n ? random(31) : 0n
  const E = changeAmount > 0n ? point(changeScalar) : [0n, 0n]
  const category = args.sourceNotes.reduce((mask, note) => mask | BigInt(note.payload.category), 0n)
  const changeC = changeAmount > 0n ? H(956n, H(955n, D, ...A, ...V, H(954n, D, ...multiply(V, changeScalar)), category), changeAmount) : 0n
  const changeEnvelope = (changeAmount > 0n ? "0x505204" + E.map(n => n.toString(16).padStart(64, "0")).join("") : "0x") as Hex
  const mode = (consolidate ? 1n : 0n) + (args.relayMode === "self" ? 2n : 0n), nonce = random(8)
  const executor = BigInt(args.proofExecutor ?? (args.relayMode === "private" ? args.selectedRelayer!.executionAddress : args.ownerAddress))
  const context = [BigInt(args.profile.chainId), BigInt(asset.pool), BigInt(args.assetId), args.profile.settlementDomain, args.state.history.root, ...nfs, BigInt(args.sourceNotes.length), ...amounts, ...recipients, ...domains, preview.protocolFee, preview.relayExecutionFee, executor, mode, nonce]
  const bodyParameters: AbiParameter[] = [{ type: "uint256[45]" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }]
  const digest = BigInt(sha256(encodeAbiParameters(bodyParameters, [context, changeC, E[0], E[1], changeEnvelope])))
  const lo = digest & (LIMIT - 1n), hi = digest >> 128n
  const inputDigest = H(962n, BigInt(args.sourceNotes.length), ...nfs)
  let outputDigest = H(964n, 10n)
  for (let i = 0; i < 10; i++) outputDigest = H(963n, outputDigest, recipients[i], amounts[i], domains[i])
  const tx = H(960n, D, spendScalar, inputDigest, outputDigest, preview.protocolFee, preview.relayExecutionFee, executor, mode, nonce, changeC, ...E, lo, hi)
  const expected = [...amounts.map((amount, i) => amount === 0n ? 0n : H(961n, tx, recipients[i], amount, domains[i], BigInt(i))), ...context, lo, hi, changeC, ...E]
  const pad = (values: string[]) => [...values, ...Array<string>(4 - values.length).fill("0")]
  const padPaths = (values: (string | number)[][]) => [...values, ...Array.from({ length: 4 - values.length }, () => Array<string>(32).fill("0"))]
  check(args.isCurrent())
  const proved = await args.runtime.prove("spend", {
    chainId: String(args.profile.chainId), poolAddress: String(BigInt(asset.pool)), assetId: String(args.assetId), settlementDomain: String(args.profile.settlementDomain), root: String(args.state.history.root),
    nullifiers: nfs.map(String), inputCount: String(args.sourceNotes.length), amounts: amounts.map(String), recipients: recipients.map(String), destinationDomains: domains.map(String),
    protocolFee: String(preview.protocolFee), executorFee: String(preview.relayExecutionFee), executor: String(executor), executionMode: String(mode), executionNonce: String(nonce), bodyLo: String(lo), bodyHi: String(hi), changeCommitment: String(changeC), changeEphemeral: E.map(String),
    spendScalar: String(spendScalar), viewScalar: String(viewScalar), spendPoint: A.map(String), viewPoint: V.map(String),
    active: [...Array<number>(args.sourceNotes.length).fill(1), ...Array<number>(4 - args.sourceNotes.length).fill(0)], rhos: pad(args.sourceNotes.map(n => n.payload.rho)), categories: pad(args.sourceNotes.map(n => String(n.payload.category))), inputAmounts: pad(args.sourceNotes.map(n => String(n.amount))),
    pathElements: padPaths(paths.map(p => p.pathElements.map(String))), pathIndices: padPaths(paths.map(p => p.pathIndices)), changeScalar: String(changeScalar)
  })
  check(args.isCurrent())
  check(proved.publicSignals.length === 60 && proved.publicSignals.every((n, i) => /^(0|[1-9][0-9]*)$/.test(n) && BigInt(n) < FIELD && BigInt(n) === expected[i]), "The payment proof does not match the reviewed execution.")
  check(/^0x[a-fA-F0-9]{512}$/.test(proved.proof), "The payment proof is malformed.")
  const decoded = decodeAbiParameters(proofParameters, proved.proof)
  check(await s.read(args.profile.proofs.spend, "verifyProof", [...decoded, expected], verifierAbi) === true, "The payment proof verification failed.")
  await s.finish(); check(args.isCurrent())
  const payload: CanonicalRelayExecutionPayloadV4 | null = feeSchedule ? { version: 4, poolVersion: 4, profileDigest: sha256(toHex(receivingProfileJsonV4(args.profile))).slice(2), proof: proved.proof, publicSignals: expected.map(String), changeEnvelope, feeSchedule } : null
  return { preview, publicSignals: expected, proof: proved.proof, changeEnvelope, payload, nullifierHashes: args.sourceNotes.map(n => n.nullifierHash), transaction: { to: asset.pool, data: encodeFunctionData({ abi: receivingPoolV4BrowserAbi, functionName: "spend", args: [proved.proof, expected, changeEnvelope] }), value: 0n } }
}

export async function executePoolV4SelfRelay(args: PoolV4BrowserExecutionArgs & {
  reviewedPreview?: PoolV4BrowserPreview
  onPrepared?: (prepared: Awaited<ReturnType<typeof preparePoolV4BrowserExecution>>) => void | Promise<void>
  wallet?: { request(request: { method: string; params?: unknown[] }): Promise<unknown>; sendTransaction(transaction: { account: Address; to: Address; data: Hex; value: bigint }): Promise<Hex> }
}) {
  check(args.relayMode === "self")
  args.onProgress?.("generating_proof")
  const prepared = await preparePoolV4BrowserExecution(args)
  if (args.reviewedPreview) for (const key of ["amount", "protocolFee", "totalNeededFromNotes", "totalPrivateBalanceUsed", "changeAfterExecution", "inputCount", "recipientCount"] as const) check(prepared.preview[key] === args.reviewedPreview[key], "The fees or selected notes changed. Review the updated payment before sending.")
  await args.onPrepared?.(prepared)
  const wallet = args.wallet ?? args.runtime.wallet
  check(wallet && args.isCurrent())
  check(await wallet.request({ method: "eth_chainId" }) === toHex(args.profile.chainId), "Switch the connected wallet to the funded note's Tempo network.")
  const accounts = await wallet.request({ method: "eth_accounts" })
  check(args.isCurrent() && Array.isArray(accounts) && getAddress(accounts[0]) === getAddress(args.ownerAddress), "Wallet changed. Try again.")
  args.onProgress?.("broadcasting")
  check(args.isCurrent())
  let hash: Hex
  try { hash = await wallet.sendTransaction({ account: args.ownerAddress, ...prepared.transaction }) }
  catch (error) {
    let cause: unknown = error
    const seen = new Set<object>()
    for (let depth = 0; depth < 8 && cause && typeof cause === "object" && !seen.has(cause); depth++) {
      seen.add(cause)
      const rejected = cause as { code?: number; name?: string; cause?: unknown }
      if (rejected.code === 4001 || rejected.name === "UserRejectedRequestError") throw error
      cause = rejected.cause
    }
    throw Object.assign(Error("Wallet submission status is unknown. Keep this send pending while its original transaction is checked."), { submissionUncertain: true })
  }
  // A returned hash is submitted, not confirmed; receipt timeouts must not invite a second spend.
  return { hash, preview: prepared.preview, nullifierHashes: prepared.nullifierHashes }
}

export async function sealPoolV4RelayPayload(publicKeyB64: string, payload: unknown, runtime: Pick<PoolV4Runtime, "sealRelay">): Promise<Hex> {
  return runtime.sealRelay(publicKeyB64, payload)
}
export type PoolV4ExecutionRecoveryCapsule = {
  version: 4; kind: "pool-v4-private-execution"; ownerAddress: Address; profileDigest: string; chainId: number
  poolAddress: Address; assetId: 1 | 2 | 3; bundleKey: string; statusAccessToken: string; nullifierHashes: Hex[]
  relayerAddress: Address; callData: Hex; callHash: Hex; amountLabel: string; executionKind: "send" | "consolidation"; createdAt: number
}
export async function executePoolV4PrivateRelay(args: PoolV4BrowserExecutionArgs & {
  recoveryPublicKeyB64: string; reviewedPreview?: PoolV4BrowserPreview
  onPrepared?(prepared: Awaited<ReturnType<typeof preparePoolV4BrowserExecution>>, capsule: PoolV4ExecutionRecoveryCapsule): void | Promise<void>
}) {
  check(args.relayMode === "private" && !args.proofExecutor)
  const relayer = args.selectedRelayer ? structuredClone(args.selectedRelayer) : null
  check(relayer)
  args.onProgress?.("generating_proof")
  const prepared = await preparePoolV4BrowserExecution({ ...args, selectedRelayer: relayer })
  check(prepared.payload)
  if (args.reviewedPreview) for (const key of ["amount", "protocolFee", "relayExecutionFee", "totalNeededFromNotes", "totalPrivateBalanceUsed", "changeAfterExecution", "inputCount", "recipientCount"] as const) check(prepared.preview[key] === args.reviewedPreview[key], "The fees or selected notes changed. Review the updated payment before sending.")
  check(!args.reviewedPreview || args.reviewedPreview.selectedRelayer?.executionAddress.toLowerCase() === relayer.executionAddress.toLowerCase(), "The selected private relayer changed. Review the payment again.")
  check(args.runtime.relay)
  const { buildBundleKey: buildBrowserBundleKey, createStatusToken: createBrowserRelayStatusAccessToken, publish: publishRelayBundle } = args.runtime.relay
  const createSealedRecoveryEnvelope = args.runtime.sealRecovery
  const ciphertext = await sealPoolV4RelayPayload(relayer.publicKeyB64, prepared.payload, args.runtime)
  const bundle = { version: 2 as const, launchScope: "phase3-mainnet" as const, relayerAddress: getAddress(relayer.executionAddress), ciphertext }
  const bundleKey = await buildBrowserBundleKey(bundle), statusAccessToken = createBrowserRelayStatusAccessToken()
  const capsule: PoolV4ExecutionRecoveryCapsule = { version: 4, kind: "pool-v4-private-execution", ownerAddress: getAddress(args.ownerAddress), profileDigest: prepared.payload.profileDigest, chainId: args.profile.chainId, poolAddress: prepared.transaction.to, assetId: args.assetId, bundleKey, statusAccessToken, nullifierHashes: prepared.nullifierHashes, relayerAddress: bundle.relayerAddress, callData: prepared.transaction.data, callHash: keccak256(prepared.transaction.data), amountLabel: String(prepared.preview.amount), executionKind: args.executionKind ?? "send", createdAt: Date.now() }
  const sealedPayload = await createSealedRecoveryEnvelope(args.recoveryPublicKeyB64, capsule), recoveryKeyHash = sha256(toHex(args.recoveryPublicKeyB64)).slice(2)
  check(args.isCurrent())
  await args.onPrepared?.(prepared, capsule)
  check(args.isCurrent())
  args.onProgress?.("broadcasting")
  try {
    const published = await publishRelayBundle(bundle, { requireInbox: true, recovery: { statusAccessToken, recoveryKeyHash, sealedPayload } })
    check(published.bundleKey === bundleKey && published.statusAccessToken === statusAccessToken, "The private relay handoff response did not match its retained recovery record.")
  } catch {
    throw Object.assign(Error("Private relay submission status is unknown. Keep this send pending while the original handoff is checked."), { submissionUncertain: true })
  }
  return { preview: prepared.preview, nullifierHashes: prepared.nullifierHashes, relayBundleKey: bundleKey, relayStatusAccessToken: statusAccessToken, relayerAddress: bundle.relayerAddress }
}
export async function loadPoolV4ExecutionRecoveryCapsules(args: {
  runtime: PoolV4Runtime; profile: ReceivingProfileV4; ownerAddress: Address; recoveryPublicKeyB64: string; recoveryPrivateKeyB64: string; ownedNullifierHashes: string[]
}) {
  assertReceivingProfileV4(args.profile)
  const profileDigest = sha256(toHex(receivingProfileJsonV4(args.profile))).slice(2), recoveryKeyHash = sha256(toHex(args.recoveryPublicKeyB64)).slice(2)
  const response = await args.runtime.fetcher(new URL(`/api/relay-bundles?recoveryKeyHash=${recoveryKeyHash}`, args.runtime.origin), { cache: "no-store", signal: AbortSignal.timeout(10000) })
  check(response.ok, "Private relay recovery is unavailable. Refresh and try again.")
  const body = await response.json() as { capsules?: unknown }
  check(Array.isArray(body?.capsules))
  const openSealedRecoveryEnvelope = args.runtime.openRecovery, owned = new Set(args.ownedNullifierHashes.map(n => n.toLowerCase())), result: PoolV4ExecutionRecoveryCapsule[] = []
  for (const encrypted of body.capsules) try {
    check(typeof encrypted === "string" && /^0x(?:[a-fA-F0-9]{2}){1,32768}$/.test(encrypted))
    const c = await openSealedRecoveryEnvelope<PoolV4ExecutionRecoveryCapsule>(args.recoveryPublicKeyB64, args.recoveryPrivateKeyB64, encrypted as Hex)
    check(c?.version === 4 && c.kind === "pool-v4-private-execution" && c.ownerAddress.toLowerCase() === args.ownerAddress.toLowerCase() && c.profileDigest === profileDigest && c.chainId === args.profile.chainId && args.profile.assets.some(a => a.assetId === c.assetId && a.pool.toLowerCase() === c.poolAddress.toLowerCase()))
    check(/^[a-f0-9]{64}$/.test(c.bundleKey) && /^[A-Za-z0-9_-]{43}$/.test(c.statusAccessToken) && isAddress(c.relayerAddress) && BigInt(c.relayerAddress) !== 0n && Array.isArray(c.nullifierHashes) && c.nullifierHashes.length > 0 && c.nullifierHashes.length <= 4 && c.nullifierHashes.every(n => /^0x[a-f0-9]{64}$/.test(n) && owned.has(n.toLowerCase())) && Number.isSafeInteger(c.createdAt) && c.createdAt > 0 && /^[0-9]{1,39}$/.test(c.amountLabel))
    check(/^0x(?:[a-fA-F0-9]{2}){1,32768}$/.test(c.callData) && keccak256(c.callData) === c.callHash)
    const d = decodeFunctionData({ abi: receivingPoolV4BrowserAbi, data: c.callData }), s = d.args?.[1] as bigint[] | undefined
    check(d.functionName === "spend" && d.args && encodeFunctionData({ abi: receivingPoolV4BrowserAbi, functionName: "spend", args: d.args }) === c.callData && s?.length === 60 && s[10] === BigInt(c.chainId) && s[11] === BigInt(c.poolAddress) && s[12] === BigInt(c.assetId) && s[13] === args.profile.settlementDomain && s[52] === BigInt(c.relayerAddress) && s[53] === (c.executionKind === "consolidation" ? 1n : 0n))
    check(s.slice(15, 19).filter(n => n !== 0n).map(n => toHex(n, { size: 32 })).join(",") === c.nullifierHashes.join(",") && s.slice(20, 30).reduce((n, v) => n + v, 0n) === BigInt(c.amountLabel))
    result.push(c)
  } catch { /* Anonymous sealed capsules are not trusted until wallet-owned nullifiers and the complete V4 call agree. */ }
  return result
}

export async function readPoolV4BrowserSettlement(args: {
  profile: ReceivingProfileV4; ownerAddress: Address; executorAddress?: Address; hash: Hex; poolAddress: Address; nullifierHashes: string[]; callHash?: Hex; rpc: ReceivingBrowserRpcV4
}): Promise<"pending" | "confirmed" | "reverted"> {
  try {
    assertReceivingProfileV4(args.profile)
    check(args.profile.assets.some(a => a.pool.toLowerCase() === args.poolAddress.toLowerCase()) && /^0x[a-f0-9]{64}$/.test(args.hash))
    const snapshotState = await snapshot(args.profile, args.rpc)
    type Tx = { hash: Hex; from: Address; to: Address; input: Hex; blockHash: Hex; blockNumber: Hex; transactionIndex: Hex }
    type Receipt = { transactionHash: Hex; from: Address; to: Address; blockHash: Hex; blockNumber: Hex; transactionIndex: Hex; status: string; logs: { address: Address; topics: [Hex, ...Hex[]]; data: Hex }[] }
    const tx = await args.rpc({ method: "eth_getTransactionByHash", params: [args.hash] }) as Tx | null
    const receipt = await args.rpc({ method: "eth_getTransactionReceipt", params: [args.hash] }) as Receipt | null
    if (!tx?.blockHash || !receipt?.blockHash) return "pending"
    const executor = getAddress(args.executorAddress ?? args.ownerAddress)
    check(tx.hash === args.hash && receipt.transactionHash === args.hash && tx.to.toLowerCase() === args.poolAddress.toLowerCase() && receipt.to.toLowerCase() === args.poolAddress.toLowerCase() && getAddress(tx.from) === executor && getAddress(receipt.from) === executor)
    check(!args.callHash || keccak256(tx.input) === args.callHash)
    check(tx.blockHash === receipt.blockHash && tx.blockNumber === receipt.blockNumber && tx.transactionIndex === receipt.transactionIndex)
    const block = await args.rpc({ method: "eth_getBlockByNumber", params: [receipt.blockNumber, false] }) as { hash: Hex; number: Hex; transactions: Hex[] }
    check(block?.hash === receipt.blockHash && block.number === receipt.blockNumber && block.transactions[Number(BigInt(receipt.transactionIndex))] === args.hash)
    const decoded = decodeFunctionData({ abi: receivingPoolV4BrowserAbi, data: tx.input })
    check(decoded.functionName === "spend" && decoded.args && encodeFunctionData({ abi: receivingPoolV4BrowserAbi, functionName: "spend", args: decoded.args }) === tx.input)
    const signals = decoded.args[1] as bigint[], envelope = decoded.args[2] as Hex
    check(signals.length === 60 && signals[10] === BigInt(args.profile.chainId) && signals[11] === BigInt(args.poolAddress) && signals[52] === BigInt(executor) && signals[53] === (args.executorAddress ? (signals[53] === 1n ? 1n : 0n) : (signals[53] === 3n ? 3n : 2n)))
    const nullifiers = signals.slice(15, 19).filter(n => n !== 0n).map(String)
    check(nullifiers.length === args.nullifierHashes.length && nullifiers.every((n, i) => BigInt(n) === BigInt(args.nullifierHashes[i])))
    const finalized = await args.rpc({ method: "eth_getBlockByNumber", params: ["finalized", false] }) as { hash: Hex; number: Hex }
    check(finalized && /^0x[0-9a-f]+$/.test(finalized.number) && /^0x[a-f0-9]{64}$/.test(finalized.hash) && BigInt(finalized.number) >= BigInt(receipt.blockNumber))
    const canonicalFinalized = await args.rpc({ method: "eth_getBlockByNumber", params: [finalized.number, false] }) as typeof finalized
    check(canonicalFinalized?.hash === finalized.hash && canonicalFinalized.number === finalized.number)
    await snapshotState.finish()
    if (receipt.status === "0x0") return "reverted"
    check(receipt.status === "0x1" && Array.isArray(receipt.logs))
    let matched = 0
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== args.poolAddress.toLowerCase()) continue
      try {
        const event = decodeEventLog({ abi: receivingPoolV4BrowserAbi, topics: log.topics, data: log.data, strict: true })
        const values = event.args as { signals?: bigint[]; changeEnvelope?: Hex }
        if (event.eventName === "Spent" && values.signals?.length === 60 && values.signals.every((n, i) => n === signals[i]) && values.changeEnvelope === envelope) matched++
      } catch { /* Other pool events cannot confirm a spend. */ }
    }
    return matched === 1 ? "confirmed" : "pending"
  } catch { return "pending" }
}
