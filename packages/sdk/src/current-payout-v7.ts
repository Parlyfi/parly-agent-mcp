import type { PayoutV7Runtime } from "./current-runtime.js"
import { allocatePayoutV7SourceFee, buildPayoutV7AuthorizationMessage, canonicalPayoutV7, hashPayoutV7Manifest, restorePayoutIntentV7, type PayoutV7Manifest } from "./payout-v7.js"
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, getAddress, hexToBytes, isAddress, keccak256, sha256, toHex, type Abi, type Address, type Hex } from "viem"
import { receivingProfileJsonV4, type ReceivingProfileV4 } from "@parly/crypto-utils/receiving-profile-v4"
import type { RelayerRegistryEntry } from "@parly/shared-types"
import { preparePoolV4BrowserExecution, sealPoolV4RelayPayload, type PoolV4BrowserExecutionArgs } from "./current-execution-v4.js"
import { parlyPayoutAdapterV7Abi, parlyPayoutWithdrawalExecutorV3Abi } from "@parly/protocol-abis/payout-v7"
import type { RecoveredAssetStateV4 } from "./current-recovery-v4.js"

const randomHash = () => toHex(crypto.getRandomValues(new Uint8Array(32)))
function check(ok: unknown): asserts ok { if (!ok) throw Error("The payout details changed. Review the send before continuing.") }
async function post(runtime: PayoutV7Runtime, action: string, body: unknown) {
  const response = await runtime.fetcher(new URL(`/api/phase3/payout-v7/${action}`, runtime.origin), { method: "POST", headers: { "content-type": "application/json" }, body: canonicalPayoutV7(body), signal: AbortSignal.timeout(120000) })
  const value = await response.json()
  check(response.ok && value?.ok === true)
  return value
}
export type PayoutV7BrowserQuote = {
  version: 7; quoteSessionId: Hex; profileDigest: Hex; adapter: Address; withdrawalExecutor: Address; sourcePool: Address
  sourceToken: Address; assetId: 1 | 2 | 3; inputCount: number; selectedRelayer: Address; relayerPublicKeyHash: Hex
  expires: number; reward: bigint; protocolFee: bigint; clientAuthorizationId: Hex
  children: { intent: ReturnType<typeof restorePayoutIntentV7>; providerData: Hex; destinationRecipient: Address; refundWallet: Address }[]
}
export type PayoutV7RecoveryCapsule = { version: 1; adapterVersion: "v7"; manifest: PayoutV7Manifest; manifestHash: Hex; statusAccessToken: string; refundSalts: Hex[]; sourceNullifierHashes: Hex[]; createdAt: number }
export async function assertPayoutV7BrowserRoute(args:Pick<PoolV4BrowserExecutionArgs,"profile"|"rpc"|"assetId"|"isCurrent">,q:PayoutV7BrowserQuote,runtime:PayoutV7Runtime) {
  const {adapter,executor,adapterHash,executorHash}=runtime.pins
  check(adapter && executor && isAddress(adapter) && isAddress(executor) && adapterHash && executorHash && /^0x[a-f0-9]{64}$/.test(adapterHash) && /^0x[a-f0-9]{64}$/.test(executorHash))
  check(getAddress(q.adapter)===getAddress(adapter) && getAddress(q.withdrawalExecutor)===getAddress(executor) && q.profileDigest===sha256(toHex(receivingProfileJsonV4(args.profile))))
  const asset=args.profile.assets.find(a=>a.assetId===args.assetId);check(asset && getAddress(q.sourcePool)===getAddress(asset.pool) && getAddress(q.sourceToken)===getAddress(asset.token))
  const block=await args.rpc({method:"eth_getBlockByNumber",params:["finalized",false]}) as {hash:Hex;number:Hex}
  check(block && /^0x[a-f0-9]{64}$/.test(block.hash) && /^0x[0-9a-f]+$/.test(block.number))
  const ref={blockHash:block.hash,requireCanonical:true}
  for(const [address,codeHash] of [[adapter,adapterHash],[executor,executorHash]] as [Address,Hex][]) check(keccak256(await args.rpc({method:"eth_getCode",params:[address,ref]}) as Hex)===codeHash)
  const read=async(address:Address,abi:Abi,functionName:string,params:unknown[]=[])=>{
    check(args.isCurrent())
    const data=await args.rpc({method:"eth_call",params:[{to:address,data:encodeFunctionData({abi,functionName,args:params})},ref]}) as Hex
    const result=decodeFunctionResult({abi,functionName,data});check(encodeFunctionResult({abi,functionName,result})===data);return result
  }
  check(String(await read(adapter,parlyPayoutAdapterV7Abi,"environment"))===args.profile.environment && BigInt(await read(adapter,parlyPayoutAdapterV7Abi,"settlementDomainId") as bigint)===args.profile.settlementDomain && getAddress(String(await read(adapter,parlyPayoutAdapterV7Abi,"sourceExecutor")))===getAddress(executor))
  check(getAddress(String(await read(executor,parlyPayoutWithdrawalExecutorV3Abi,"payoutAdapterV6")))===getAddress(adapter) && await read(adapter,parlyPayoutAdapterV7Abi,"approvedPools",[asset.pool])===true && await read(adapter,parlyPayoutAdapterV7Abi,"approvedTokens",[asset.token])===true)
  for(const child of q.children) {
    const i=child.intent
    check(i.environment===args.profile.environment && i.chainId===BigInt(args.profile.chainId) && i.settlementDomainId===args.profile.settlementDomain && getAddress(i.adapter)===getAddress(adapter) && getAddress(i.sourceExecutor)===getAddress(executor) && getAddress(i.sourcePool)===getAddress(asset.pool) && getAddress(i.token)===getAddress(asset.token) && i.assetId===BigInt(asset.assetId))
    check(getAddress(String(await read(adapter,parlyPayoutAdapterV7Abi,"predictEscrowAddress",[i.escrowSalt,asset.token,i.primaryRefundToken,i.secondaryRefundToken])))===getAddress(i.escrow) && await read(adapter,parlyPayoutAdapterV7Abi,"approvedProviderContracts",[i.providerContract])===true)
  }
  const canonical=await args.rpc({method:"eth_getBlockByNumber",params:[block.number,false]}) as {hash:Hex}
  check(canonical.hash===block.hash && await args.rpc({method:"eth_chainId",params:[]})===toHex(args.profile.chainId) && args.isCurrent())
}
export async function quotePayoutV7(args: {
  ownerAddress: Address; assetId: 1 | 2 | 3; sourcePool: Address; inputCount: number; selectedRelayer: RelayerRegistryEntry
  outputs: { destinationChainId: number; destinationToken: Address; destinationRecipient: Address; amountOut: bigint }[]
  escrowSalts?: Hex[]; clientAuthorizationId?: Hex
}, runtime: PayoutV7Runtime): Promise<PayoutV7BrowserQuote> {
  check(args.outputs.length >= 1 && args.outputs.length <= 10)
  const salts = args.escrowSalts ?? args.outputs.map(randomHash)
  const result = (await post(runtime, "quote", { assetId: args.assetId, sourcePool: args.sourcePool, inputCount: args.inputCount, selectedRelayer: args.selectedRelayer.executionAddress,
    children: args.outputs.map((o, index) => ({ ...o, amountOutBaseUnits: String(o.amountOut), escrowSalt: salts[index], refundWallet: args.ownerAddress })) })).quote
  check(result?.version === 7 && result.assetId === args.assetId && getAddress(result.sourcePool) === getAddress(args.sourcePool) && getAddress(result.selectedRelayer) === getAddress(args.selectedRelayer.executionAddress) && result.inputCount === args.inputCount && result.children.length === args.outputs.length && result.expires > Math.floor(Date.now() / 1000) + 330)
  const children = result.children.map((c: any, index: number) => {
    const intent = restorePayoutIntentV7(c.intent), output = args.outputs[index]!
    check(intent.destinationRecipientHash === keccak256(encodeAbiParameters([{type:"address"}],[output.destinationRecipient])))
    check(intent.destinationChainId === BigInt(output.destinationChainId) && getAddress(intent.destinationToken) === getAddress(output.destinationToken) && getAddress(c.destinationRecipient) === getAddress(output.destinationRecipient) && intent.sourceAmountOut === output.amountOut && intent.escrowSalt === salts[index] && getAddress(c.refundWallet) === getAddress(args.ownerAddress))
    return { ...c, intent }
  })
  return { ...result, reward: BigInt(result.reward), protocolFee: BigInt(result.protocolFee), children, clientAuthorizationId: args.clientAuthorizationId ?? randomHash() }
}
export async function authorizePayoutV7(args: Omit<PoolV4BrowserExecutionArgs, "outputs" | "proofExecutor" | "relayExecutionFeeOverride" | "relayMode"> & {
  quote: PayoutV7BrowserQuote; selectedRelayer: RelayerRegistryEntry; recoveryPublicKeyB64: string
  onPrepared?: (capsule: PayoutV7RecoveryCapsule) => Promise<void> | void
}, runtime: PayoutV7Runtime) {
  const q = args.quote
  check(args.isCurrent() && q.expires > Math.floor(Date.now() / 1000) + 330 && args.assetId === q.assetId && args.sourceNotes.length === q.inputCount)
  await assertPayoutV7BrowserRoute(args,q,runtime)
  check(q.relayerPublicKeyHash === keccak256(toHex(args.selectedRelayer.publicKeyB64)))
  const allocations = allocatePayoutV7SourceFee(q.reward, q.children.length)
  q.children.forEach((c, index) => check(c.intent.sourceExecutorFeeAllocation === allocations[index]))
  const prepared = await preparePoolV4BrowserExecution({ ...args, relayMode: "private", proofExecutor: q.withdrawalExecutor, relayExecutionFeeOverride: q.reward, outputs: q.children.map(c => ({ destination: c.intent.escrow, amount: c.intent.amountIn })) })
  check(args.isCurrent() && prepared.preview.protocolFee === q.protocolFee && prepared.preview.relayExecutionFee === q.reward)
  const sealedExecutionPayload = await sealPoolV4RelayPayload(args.selectedRelayer.publicKeyB64, { version: 7, poolVersion: 4, profileDigest: q.profileDigest, proof: prepared.proof, publicSignals60: prepared.publicSignals.map(String), changeEnvelope: prepared.changeEnvelope }, runtime)
  const sourceFingerprint = keccak256(encodeAbiParameters([{ type: "uint256[]" }], [args.sourceNotes.map(n => BigInt(n.payload.rho))]))
  const refundSalts = q.children.map(c => keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], ["parly:payout-v7-refund:v1", BigInt(args.profile.chainId), q.adapter, c.intent.escrowSalt, q.clientAuthorizationId, sourceFingerprint])))
  const commitments = refundSalts.map((salt, index) => keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }], [BigInt(args.profile.chainId), q.children[index]!.intent.escrowSalt, args.ownerAddress, salt])))
  const response = (await post(runtime, "preparation", { quoteSessionId: q.quoteSessionId, clientAuthorizationId: q.clientAuthorizationId, sourceCallHash: keccak256(prepared.transaction.data), sealedExecutionPayload, refundRecipientCommitments: commitments })).preparation
  const manifest = { ...response.manifest, children: response.manifest.children.map((c: any) => ({ ...c, intent: restorePayoutIntentV7(c.intent) })) } as PayoutV7Manifest
  check(manifest.version === 7 && hashPayoutV7Manifest(manifest) === response.manifestHash && manifest.adapter === q.adapter && manifest.withdrawalExecutor === q.withdrawalExecutor && manifest.sourceCallHash === keccak256(prepared.transaction.data) && manifest.sourcePool === q.sourcePool && manifest.sourceToken === q.sourceToken && manifest.profileDigest === q.profileDigest && manifest.sealedExecutionPayloadHash === keccak256(sealedExecutionPayload) && manifest.children.length === q.children.length && manifest.maximumTotalNoteDeductionBaseUnits === String(prepared.preview.totalNeededFromNotes))
  manifest.children.forEach((c, index) => {
    const expected = { ...q.children[index]!.intent, sourceCallHash: manifest.sourceCallHash, refundRecipientCommitment: commitments[index]! }
    check(canonicalPayoutV7(c.intent) === canonicalPayoutV7(expected) && c.providerData === q.children[index]!.providerData && getAddress(c.destinationRecipient) === getAddress(q.children[index]!.destinationRecipient))
  })
  check(args.isCurrent())
  const authorization = { wallet: args.ownerAddress, issuedAt: Math.floor(Date.now() / 1000), nonce: randomHash() }
  const message = buildPayoutV7AuthorizationMessage(manifest, authorization)
  const capsule: PayoutV7RecoveryCapsule = { version: 1, adapterVersion: "v7", manifest, manifestHash: response.manifestHash, statusAccessToken: response.statusAccessToken, refundSalts, sourceNullifierHashes: prepared.nullifierHashes, createdAt: Date.now() }
  // Bound the complete ten-child capsule, not V6's compact recovery record.
  const canonicalCapsule = canonicalPayoutV7(capsule)
  check(new TextEncoder().encode(canonicalCapsule).length <= 262144)
  const encrypted = await runtime.sealRecovery(args.recoveryPublicKeyB64, JSON.parse(canonicalCapsule)), storageKey = `parly:payout-v7:${args.ownerAddress.toLowerCase()}:${response.manifestHash}`
  let signature: Hex
  try {
    runtime.storage.setItem(storageKey, encrypted)
    check(runtime.storage.getItem(storageKey) === encrypted)
    const prefix=`parly:payout-v7:${args.ownerAddress.toLowerCase()}:`
    check(Array.from({length:runtime.storage.length},(_,i)=>runtime.storage.key(i)).filter(k=>k?.startsWith(prefix)).length<=128)
    const recoveryKeyHash = sha256(toHex(args.recoveryPublicKeyB64)).slice(2)
    const saved = await runtime.fetcher(new URL("/api/phase3/payout-v7/recovery", runtime.origin), { method: "POST", headers: { authorization: `Bearer ${capsule.statusAccessToken}`, "content-type": "application/json" }, body: JSON.stringify({ manifestHash: capsule.manifestHash, recoveryKeyHash, sealedPayload: encrypted }), signal: AbortSignal.timeout(10000) })
    const retained = await saved.json()
    check(saved.ok && retained?.ok === true && retained.manifestHash === capsule.manifestHash && retained.recoveryKeyHash === recoveryKeyHash && retained.sealedPayload === encrypted)
    // Exact durable remote readback precedes the only authorization permitting automatic funding.
    await args.onPrepared?.(capsule)
    check(args.isCurrent())
    signature = await runtime.signMessage({ account: args.ownerAddress, message })
    check(args.isCurrent())
  } catch (error) {
    // No authorization was handed off, so only this unsubmitted capsule may be removed.
    if (runtime.storage.getItem(storageKey) === encrypted) runtime.storage.removeItem(storageKey)
    throw error
  }
  let accepted
  try {
    accepted = (await post(runtime, "accept", { manifestHash: response.manifestHash, authorization: { ...authorization, signature } })).payout
    check(accepted.manifestHash === response.manifestHash && accepted.statusAccessToken === capsule.statusAccessToken)
  } catch (cause) { throw Object.assign(Error("The send authorization is being checked. Do not submit it again."), { cause, submissionUncertain: true }) }
  return { manifest, children: accepted.children, preview: prepared.preview, capsule }
}
export type PayoutV7BrowserStatus = { version:7; adapterVersion:"v7"; poolVersion:4; adapter:Address; sourcePool:Address; manifestHash:Hex; sourceCallHash:Hex; authorized:boolean;quoteExpiresAt:number;unfundedExpiryVerified?:true;
  children:{intentHash:Hex;escrow:Address;amountInBaseUnits:string;destinationChainId:number;destinationToken:Address;destinationAmountOutBaseUnits:string;status:number;escrowFundedAt:string;recoveryAvailableAt:string;refundRecipientCommitment:Hex;finalizedBlockNumber:string;finalizedBlockHash:Hex;finalizedTimestamp:string}[] }
export async function readPayoutV7Status(capsule: PayoutV7RecoveryCapsule, runtime: PayoutV7Runtime): Promise<PayoutV7BrowserStatus> {
  const s = (await post(runtime, "status", { statusAccessToken: capsule.statusAccessToken })).payout as PayoutV7BrowserStatus, m = capsule.manifest
  check(s.version === 7 && s.adapterVersion === "v7" && s.poolVersion === 4 && s.manifestHash === capsule.manifestHash && s.sourceCallHash === m.sourceCallHash && getAddress(s.adapter) === getAddress(m.adapter) && getAddress(s.sourcePool) === getAddress(m.sourcePool) && Array.isArray(s.children) && s.children.length === m.children.length)
  check(typeof s.authorized==="boolean" && (s.unfundedExpiryVerified===undefined || s.unfundedExpiryVerified===true) && s.quoteExpiresAt===m.quoteExpiresAt && s.children.every(c=>/^(0|[1-9][0-9]*)$/.test(c.finalizedBlockNumber) && /^(0|[1-9][0-9]*)$/.test(c.finalizedTimestamp) && /^0x[a-f0-9]{64}$/.test(c.finalizedBlockHash)))
  s.children.forEach((c,i)=>{ const expected=m.children[i]!.intent; check(c.intentHash===m.children[i]!.intentHash && getAddress(c.escrow)===getAddress(expected.escrow) && c.amountInBaseUnits===String(expected.amountIn) && c.destinationChainId===Number(expected.destinationChainId) && getAddress(c.destinationToken)===getAddress(expected.destinationToken) && c.destinationAmountOutBaseUnits===String(expected.destinationAmountOut) && c.refundRecipientCommitment===expected.refundRecipientCommitment && Number.isInteger(c.status) && c.status>=0 && c.status<=6 && /^(0|[1-9][0-9]*)$/.test(c.escrowFundedAt) && /^(0|[1-9][0-9]*)$/.test(c.recoveryAvailableAt)) })
  return s
}
export function payoutV7ExpiredWithoutSpend(capsule:PayoutV7RecoveryCapsule,status:PayoutV7BrowserStatus|null,state:RecoveredAssetStateV4|null|undefined,ownerAddress:Address) {
  return Boolean(status && (status.unfundedExpiryVerified===true || status.authorized===false && status.children.every(c=>c.status===0)) && status.children.every(c=>(c.status===0 || c.status===1) && BigInt(c.escrowFundedAt)===0n && BigInt(c.recoveryAvailableAt)===0n && BigInt(c.finalizedTimestamp)>BigInt(capsule.manifest.quoteExpiresAt)) && state?.ownerAddress.toLowerCase()===ownerAddress.toLowerCase() && state.poolAddress.toLowerCase()===capsule.manifest.sourcePool.toLowerCase() && state.assetId===capsule.manifest.assetId &&
    BigInt(state.history.anchor.timestamp)>BigInt(capsule.manifest.quoteExpiresAt) && capsule.sourceNullifierHashes.length===capsule.manifest.inputCount && new Set(capsule.sourceNullifierHashes).size===capsule.sourceNullifierHashes.length && capsule.sourceNullifierHashes.every(n=>state.notes.some(note=>note.nullifierHash.toLowerCase()===n.toLowerCase())))
}
export async function recoverPayoutV7Capsules(args: { ownerAddress: Address; profile: ReceivingProfileV4; ownedNullifierHashes: string[]; recoveryPublicKeyB64: string; recoveryPrivateKeyB64: string; isCurrent(): boolean }, runtime: PayoutV7Runtime) {
  const prefix = `parly:payout-v7:${args.ownerAddress.toLowerCase()}:`, capsules = new Map<string, PayoutV7RecoveryCapsule>()
  const profileDigest = sha256(toHex(receivingProfileJsonV4(args.profile))), owned = new Set(args.ownedNullifierHashes.map(n => n.toLowerCase()))
  check(args.isCurrent())
  const candidates: { manifestHash: string; sealedPayload: string }[] = []
  try {
    for (const key of Array.from({ length: runtime.storage.length }, (_, i) => runtime.storage.key(i))) {
      if (!key?.startsWith(prefix) || !/^0x[a-f0-9]{64}$/.test(key.slice(prefix.length))) continue
      const sealedPayload = runtime.storage.getItem(key)
      if (sealedPayload) candidates.push({ manifestHash: key.slice(prefix.length), sealedPayload })
    }
  } catch { /* Remote recovery does not require this device's local storage. */ }
  try {
    const response = await runtime.fetcher(new URL(`/api/phase3/payout-v7/recovery?key=${sha256(toHex(args.recoveryPublicKeyB64)).slice(2)}`, runtime.origin), { cache: "no-store", signal: AbortSignal.timeout(10000) })
    const body = await response.json()
    check(response.ok && body?.ok === true && typeof body.truncated === "boolean" && Array.isArray(body.capsules) && body.capsules.length <= 128)
    candidates.push(...body.capsules)
  } catch { /* An unavailable remote reader cannot erase verified local history. */ }
  for (const candidate of candidates) {
    check(args.isCurrent())
    try {
    check(candidate && /^0x[a-f0-9]{64}$/.test(candidate.manifestHash) && typeof candidate.sealedPayload === "string" && /^0x(?:[a-fA-F0-9]{2}){49,262192}$/.test(candidate.sealedPayload))
    const c = await runtime.openRecovery(args.recoveryPublicKeyB64, args.recoveryPrivateKeyB64, candidate.sealedPayload as Hex) as PayoutV7RecoveryCapsule
    check(c.version === 1 && c.adapterVersion === "v7" && Array.isArray(c.refundSalts) && c.refundSalts.length === c.manifest.children.length)
    c.manifest = { ...c.manifest, children: c.manifest.children.map(child => ({ ...child, intent: restorePayoutIntentV7(child.intent) })) }
    check(/^[A-Za-z0-9_-]{43}$/.test(c.statusAccessToken) && Number.isSafeInteger(c.createdAt) && c.createdAt > 0 && Array.isArray(c.sourceNullifierHashes) && c.sourceNullifierHashes.length===c.manifest.inputCount && c.sourceNullifierHashes.length>=1 && c.sourceNullifierHashes.length<=4 && c.sourceNullifierHashes.every(n=>/^0x[a-f0-9]{64}$/.test(n)&&BigInt(n)>0n&&owned.has(n)) && new Set(c.sourceNullifierHashes).size===c.sourceNullifierHashes.length)
    check(c.manifest.profileDigest === profileDigest && c.manifest.chainId === args.profile.chainId && args.profile.assets.some(a => a.assetId === c.manifest.assetId && getAddress(a.pool) === getAddress(c.manifest.sourcePool) && getAddress(a.token) === getAddress(c.manifest.sourceToken)))
    buildPayoutV7AuthorizationMessage(c.manifest,{wallet:args.ownerAddress,issuedAt:0,nonce:c.manifestHash})
    check(hashPayoutV7Manifest(c.manifest) === c.manifestHash && candidate.manifestHash === c.manifestHash)
    c.manifest.children.forEach((child, index) => {
      const salt = c.refundSalts[index]!
      check(/^0x[a-f0-9]{64}$/.test(salt) && getAddress(child.refundWallet) === getAddress(args.ownerAddress) && child.intent.environment === args.profile.environment && child.intent.settlementDomainId === args.profile.settlementDomain)
      check(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }], [BigInt(c.manifest.chainId), child.intent.escrowSalt, args.ownerAddress, salt])) === child.intent.refundRecipientCommitment)
    })
    if (!capsules.has(c.manifestHash)) {
      capsules.set(c.manifestHash, c)
      try { if (!runtime.storage.getItem(prefix + c.manifestHash)) runtime.storage.setItem(prefix + c.manifestHash, candidate.sealedPayload) } catch { /* Verified remote recovery also works without local storage. */ }
    }
    } catch { /* Independently reject foreign keys, malformed ciphertext and unrelated wallet/profile records. */ }
  }
  check(args.isCurrent())
  return [...capsules.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 128)
}
export async function claimPayoutV7Refund(args: { capsule: PayoutV7RecoveryCapsule; ownerAddress: Address; wallet: { writeContract(args: any): Promise<Hex> }; readStatus(intentHash: Hex): Promise<{ status: number; recoveryAvailableAt: bigint }>; isCurrent(): boolean }) {
  const results: Hex[] = []
  for (const [index, c] of args.capsule.manifest.children.entries()) {
    check(args.isCurrent() && getAddress(c.refundWallet) === getAddress(args.ownerAddress))
    const status = await args.readStatus(c.intentHash), presubmission = status.status === 1 || status.status === 2
    if (status.status === 4 || status.status === 6 || status.status === 0 || status.status === 3) continue
    if (presubmission && (status.recoveryAvailableAt <= 0n || status.recoveryAvailableAt > BigInt(Math.floor(Date.now()/1000)))) continue
    if (presubmission) check(status.recoveryAvailableAt > 0n && status.recoveryAvailableAt <= BigInt(Math.floor(Date.now() / 1000)))
    else check(status.status === 5)
    check(args.isCurrent() && getAddress(c.refundWallet) === getAddress(args.ownerAddress))
    results.push(await args.wallet.writeContract({ address: args.capsule.manifest.adapter, abi: parlyPayoutAdapterV7Abi, functionName: presubmission ? "claimPreSubmissionRefundAfterMaturity" : "claimRefund", args: [c.intentHash, args.capsule.refundSalts[index]], account: args.ownerAddress }))
  }
  return results
}
