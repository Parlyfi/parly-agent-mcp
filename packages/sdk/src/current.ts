/// <reference path="./current-external.d.ts" />
import { readFile } from "node:fs/promises"
import { resolve, basename } from "node:path"
import { createRequire } from "node:module"
import { createPublicClient, createWalletClient, defineChain, getAddress, http, keccak256, parseUnits, toHex, type Address, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { assertReceivingProfileV4, type ReceivingProfileV4 } from "@parly/crypto-utils/receiving-profile-v4"
import { buildRecoveryAuthMessage, type RelayerRegistryEntry } from "@parly/shared-types"
import { planPoolV3Spend } from "./coin-selection.js"
import { deriveRecoveryKeypair } from "./recovery-keys.js"
import { createSealedRecoveryEnvelope, openSealedRecoveryEnvelope } from "./note-crypto.js"
import { createReceivingProverV4 } from "./current-prover-v4.js"
import { recoverNotesForAssetV4, type ReceivingDeploymentV4, type RecoveredAssetStateV4 } from "./current-recovery-v4.js"
import { executePoolV4SelfRelay, previewPoolV4BrowserExecution, readPoolV4BrowserSettlement, readPoolV4ProtocolFee, type PoolV4BrowserExecutionArgs, type PoolV4BrowserOutput } from "./current-execution-v4.js"
import { quotePayoutV7, authorizePayoutV7, readPayoutV7Status, recoverPayoutV7Capsules, claimPayoutV7Refund, payoutV7ExpiredWithoutSpend, type PayoutV7BrowserQuote } from "./current-payout-v7.js"
import type { PayoutV7Runtime } from "./current-runtime.js"
import { createCurrentNodeFetch } from "./current-node-transport.js"

export * from "./current-recovery-v4.js"
export * from "./current-execution-v4.js"
export * from "./current-payout-v7.js"
export * from "./current-prover-v4.js"
export type { PoolV4Runtime, PayoutV7Runtime } from "./current-runtime.js"
export { parseReceivingProfileV4, receivingProfileJsonV4 } from "@parly/crypto-utils/receiving-profile-v4"

export type CurrentParlySDKConfig = {
  privateKeyHex: Hex; tempoRpcUrl: string; tempoLzEid: number; profile: ReceivingProfileV4
  keyEnvironment: "development" | "staging" | "mainnet"; origin: string
  deployments: Partial<Record<1 | 2 | 3, ReceivingDeploymentV4>>
  ponderGraphqlUrl: string; proofAssetsBasePath: string; webApiBaseUrl: string
  recovery: { officialOrigin: string; usdcPool: Address; usdtPool: Address; verifierAddress: Address }
  relayRewardPolicy: { address: Address; codeHash: Hex }
  payoutV7: PayoutV7Runtime["pins"]
  destinationRoutes: { chainId: number; token: Address; decimals: number }[]
  storage: PayoutV7Runtime["storage"]
  selectedRelayer?: RelayerRegistryEntry
}
type AssetParams = { assetId: 1 | 2 | 3; poolAddress: Address }
type SendOutput = { destination: Address; amount: string; destinationEid: number }
type Pending = { owner: Address; chainId: number; pool: Address; assetId: 1 | 2 | 3; nullifiers: Hex[]; callHash?: Hex; hash?: Hex; manifestHash?: Hex }
const check: (ok: unknown, message: string) => asserts ok = (ok, message) => { if (!ok) throw Error(message) }
const units = (value: string) => { check(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value), "Amount must be a decimal with at most six places."); return parseUnits(value, 6) }

export class CurrentParlySDK {
  readonly #config: CurrentParlySDKConfig
  readonly #account: ReturnType<typeof privateKeyToAccount>
  readonly #public
  readonly #wallet
  readonly #runtime: PayoutV7Runtime
  #keys?: ReturnType<typeof deriveRecoveryKeypair>
  // shortcut: one writer per wallet/storage, use a process-shared caller lock for multiple SDK instances.
  #busy = false
  readonly #quotes = new Map<string, { quote: PayoutV7BrowserQuote; commitments: Hex[] }>()
  constructor(config: CurrentParlySDKConfig) {
    assertReceivingProfileV4(config.profile)
    check(config.origin === config.profile.origin && new URL(config.webApiBaseUrl).origin === config.origin, "Current SDK origin must match the pinned V4 profile and API.")
    check(Number.isSafeInteger(config.tempoLzEid) && config.tempoLzEid > 0, "An explicit Tempo LayerZero EID is required.")
    for (const asset of config.profile.assets) check(config.deployments[asset.assetId], "A deployment anchor is required for every admitted asset.")
    check(Array.isArray(config.destinationRoutes) && config.destinationRoutes.every(r => Number.isSafeInteger(r.chainId) && r.chainId > 0 && Number.isSafeInteger(r.decimals) && r.decimals >= 0 && r.decimals <= 36 && /^0x[a-fA-F0-9]{40}$/.test(r.token)), "Explicit destination token precision is required.")
    this.#config = { ...config, profile: structuredClone(config.profile), deployments: structuredClone(config.deployments), destinationRoutes: structuredClone(config.destinationRoutes), recovery: { ...config.recovery }, payoutV7: { ...config.payoutV7 }, relayRewardPolicy: { ...config.relayRewardPolicy }, selectedRelayer: config.selectedRelayer ? structuredClone(config.selectedRelayer) : undefined }
    this.#account = privateKeyToAccount(config.privateKeyHex)
    const chain = defineChain({ id: config.profile.chainId, name: "Tempo", nativeCurrency: { name: "USD", symbol: "USD", decimals: 6 }, rpcUrls: { default: { http: [config.tempoRpcUrl] } } })
    this.#public = createPublicClient({ chain, transport: http(config.tempoRpcUrl) })
    this.#wallet = createWalletClient({ account: this.#account, chain, transport: http(config.tempoRpcUrl) })
    const sodium = createRequire(import.meta.url)("libsodium-wrappers-sumo")
    this.#runtime = { origin: config.origin, storage: config.storage, pins: { ...config.payoutV7 },
      prove: createReceivingProverV4({ readArtifact: async name => { check(basename(name) === name, "Invalid proof artifact name."); return new Uint8Array(await readFile(resolve(config.proofAssetsBasePath, name))) } }),
      fetcher: createCurrentNodeFetch(config.origin), sealRecovery: createSealedRecoveryEnvelope, openRecovery: openSealedRecoveryEnvelope,
      relayRewardPolicyEnv: { NEXT_PUBLIC_RELAY_REWARD_POLICY_V4_ADDRESS: config.relayRewardPolicy.address, NEXT_PUBLIC_RELAY_REWARD_POLICY_V4_CODE_HASH: config.relayRewardPolicy.codeHash },
      signMessage: args => this.#account.signMessage({ message: args.message }),
      sealRelay: async (key, payload) => { await sodium.ready; check(/^[A-Za-z0-9+/]{43}=$/.test(key), "Invalid relay encryption key."); const bytes = sodium.from_base64(key, sodium.base64_variants.ORIGINAL); check(bytes.length === 32 && sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL) === key, "Invalid relay encryption key."); return toHex(sodium.crypto_box_seal(sodium.from_string(JSON.stringify(payload)), bytes)) },
      wallet: { request: async q => q.method === "eth_accounts" ? [this.#account.address] : this.#rpc({ method: q.method, params: q.params ?? [] }), sendTransaction: tx => this.#wallet.sendTransaction(tx) }
    }
  }
  #rpc = (q: { method: string; params: unknown[] }) => this.#public.request(q as any) as Promise<unknown>
  #asset(params: AssetParams) {
    const asset = this.#config.profile.assets.find(a => a.assetId === params.assetId)
    check(asset && getAddress(asset.pool) === getAddress(params.poolAddress), "The asset/pool is not admitted by the pinned V4 profile.")
    return asset
  }
  #root() {
    this.#keys ??= (async () => {
      const c = this.#config, r = c.recovery
      const message = buildRecoveryAuthMessage({ appName: "Parly", officialOrigin: r.officialOrigin, currentOrigin: c.origin, purpose: "private payment note recovery", recoveryVersion: 2, environment: c.keyEnvironment, chainId: c.profile.chainId, settlementDomainId: Number(c.profile.settlementDomain), poolAddress: r.usdcPool, verifierAddress: r.verifierAddress, assetPoolIdentity: `Tempo launch pool set: USDC.e ${r.usdcPool.toLowerCase()}; USDT0 ${r.usdtPool.toLowerCase()}` })
      return deriveRecoveryKeypair(await this.#account.signMessage({ message }), message)
    })()
    return this.#keys
  }
  async #recover(params: AssetParams) {
    this.#asset(params)
    const c = this.#config, keys = await this.#root()
    return recoverNotesForAssetV4({ profile: c.profile, origin: c.origin, keyEnvironment: c.keyEnvironment, ownerAddress: this.#account.address, privateKeyB64: keys.privateKeyB64, assetId: params.assetId, deployment: c.deployments[params.assetId]!, ponderUrl: c.ponderGraphqlUrl, rpc: this.#rpc, isCurrent: () => true })
  }
  #pendingPrefix() { return `parly:sdk:v4:${this.#account.address.toLowerCase()}:${this.#config.profile.chainId}:` }
  #pending() {
    const s = this.#config.storage, records: { key: string; value: Pending }[] = []
    for (let i = 0; i < s.length; i++) { const key = s.key(i); if (key?.startsWith(this.#pendingPrefix())) { const raw = s.getItem(key); check(raw, "Pending execution storage is unavailable."); const value = JSON.parse(raw) as Pending; check(value.owner?.toLowerCase() === this.#account.address.toLowerCase() && value.chainId === this.#config.profile.chainId && Array.isArray(value.nullifiers), "Pending execution record is invalid."); records.push({ key, value }) } }
    return records
  }
  #save(key: string, value: unknown) { const raw = JSON.stringify(value); this.#config.storage.setItem(key, raw); check(this.#config.storage.getItem(key) === raw, "Execution recovery storage readback failed.") }
  #balance(state: RecoveredAssetStateV4) {
    const locked = new Set(this.#pending().flatMap(p => p.value.nullifiers)), available = state.notes.filter(n => !locked.has(n.nullifierHash))
    return { poolVersion: 4 as const, assetDecimals: 6 as const, totalPrivateBalanceBaseUnits: String(state.total), immediatelySpendableBaseUnits: String(available.slice(0, 4).reduce((sum, n) => sum + n.amount, 0n)), noteCount: state.notes.length, consolidationRequired: available.length > 4 }
  }
  async getPrivateBalance(params: AssetParams) { return this.#balance(await this.#recover(params)) }
  async #plan(params: AssetParams, outputs: PoolV4BrowserOutput[], approvedCommitments?: readonly Hex[]) {
    const state = await this.#recover(params), keys = await this.#root(), locked = new Set(this.#pending().flatMap(p => p.value.nullifiers))
    const protocolFee = await readPoolV4ProtocolFee({ profile: this.#config.profile, rpc: this.#rpc, assetId: params.assetId, outputs })
    const plan = planPoolV3Spend({ notes: state.notes.filter(n => !locked.has(n.nullifierHash)).map(n => ({ commitment: n.commitment, amount: n.amount, confirmedLeafIndex: n.leafIndex, chainId: this.#config.profile.chainId, poolAddress: params.poolAddress, assetId: String(params.assetId), state: "unspent" })), chainId: this.#config.profile.chainId, poolAddress: params.poolAddress, assetId: String(params.assetId), requestedAmount: outputs.reduce((s, o) => s + o.amount, 0n), finalFees: protocolFee, approvedCommitments, consolidationFee: () => 0n })
    const base = { poolVersion: 4 as const, requestedAmountBaseUnits: String(outputs.reduce((s, o) => s + o.amount, 0n)), finalFeesBaseUnits: String(protocolFee), balance: this.#balance(state) }
    if (plan.kind !== "ready") return { summary: { ...base, kind: plan.kind }, args: null }
    const args: PoolV4BrowserExecutionArgs = { profile: this.#config.profile, keyEnvironment: this.#config.keyEnvironment, ownerAddress: this.#account.address, recoveryPrivateKeyB64: keys.privateKeyB64, assetId: params.assetId, state, sourceNotes: plan.selected.map(n => state.notes.find(note => note.commitment === n.commitment)!), outputs, relayMode: "self", rpc: this.#rpc, isCurrent: () => true, runtime: this.#runtime }
    const preview = await previewPoolV4BrowserExecution(args)
    return { summary: { ...base, kind: "ready" as const, requiredBaseUnits: String(preview.totalNeededFromNotes), selectedInputCount: preview.inputCount, inputTotalBaseUnits: String(preview.totalPrivateBalanceUsed), changeBaseUnits: String(preview.changeAfterExecution) }, args }
  }
  async preparePrivateSend(params: AssetParams & { amount: string; finalFees?: string; approvedCommitments?: readonly Hex[]; consolidationFee?: string }) {
    check(params.finalFees === undefined || units(params.finalFees) === 0n, "Current SDK reads fees from the pinned V4 pool; omit finalFees.")
    check(params.consolidationFee === undefined || units(params.consolidationFee) === 0n, "Consolidation is an explicit separately reviewed operation.")
    return (await this.#plan(params, [{ destination: this.#account.address, amount: units(params.amount) }], params.approvedCommitments)).summary
  }
  async preparePrivateBatchSend(params: AssetParams & { outputs: SendOutput[] }) {
    check(params.outputs.length > 0 && params.outputs.length <= 10 && params.outputs.every(o => o.destinationEid === this.#config.tempoLzEid), "The batch must contain one to ten same-chain outputs.")
    return (await this.#plan(params, params.outputs.map(o => ({ destination: o.destination, amount: units(o.amount) })))).summary
  }
  async #send(params: AssetParams, outputs: SendOutput[]) {
    check(!this.#busy, "An SDK execution is already being prepared.")
    check(outputs.every(o => o.destinationEid === this.#config.tempoLzEid), "Use the V7 payout API for cross-chain destinations.")
    this.#busy = true
    let key: string | undefined, record: Pending | undefined
    try {
      const plan = await this.#plan(params, outputs.map(o => ({ destination: o.destination, amount: units(o.amount) })))
      check(plan.args, `Private send is not ready: ${plan.summary.kind}`)
      const submitted = await executePoolV4SelfRelay({ ...plan.args, onPrepared: prepared => {
        key = this.#pendingPrefix() + prepared.nullifierHashes.join("")
        record = { owner: this.#account.address, chainId: this.#config.profile.chainId, pool: params.poolAddress, assetId: params.assetId, nullifiers: prepared.nullifierHashes, callHash: keccak256(prepared.transaction.data) }
        this.#save(key, record)
      } })
      record!.hash = submitted.hash; this.#save(key!, record)
      const status = await readPoolV4BrowserSettlement({ profile: this.#config.profile, ownerAddress: this.#account.address, hash: submitted.hash, poolAddress: params.poolAddress, nullifierHashes: submitted.nullifierHashes, callHash: record!.callHash, rpc: this.#rpc })
      if (status !== "pending") this.#config.storage.removeItem(key!)
      if (status === "confirmed") return { kind: "success" as const, hash: submitted.hash }
      if (status === "reverted") return { kind: "terminal_failure" as const, hash: submitted.hash, message: "The transaction reverted." }
      return { kind: "pending_confirmation" as const, hash: submitted.hash, message: "Submitted; do not send again while confirmation is pending.", persistedTo: key! }
    } catch (error) {
      if (key && !(error as { submissionUncertain?: boolean }).submissionUncertain && !record?.hash) this.#config.storage.removeItem(key)
      throw error
    } finally { this.#busy = false }
  }
  sendShieldedPayment(params: AssetParams & SendOutput) { return this.#send(params, [params]) }
  sendShieldedBatchPayment(params: AssetParams & { outputs: SendOutput[] }) { return this.#send(params, params.outputs) }
  async reconcilePendingExecutions() {
    const results = []
    for (const { key, value: p } of this.#pending()) {
      if (p.manifestHash) {
        const capsule = await this.#capsule(p.manifestHash), status = await readPayoutV7Status(capsule, this.#runtime), state = await this.#recover({ assetId: p.assetId, poolAddress: p.pool })
        const expired = payoutV7ExpiredWithoutSpend(capsule, status, state, this.#account.address)
        const spent = p.nullifiers.every(n => state.history.notes.some(note => note.nullifierHash === n && note.status === "spent"))
        if (expired || spent) this.#config.storage.removeItem(key)
        results.push({ manifestHash: p.manifestHash, status: expired ? "expired_without_spend" : spent ? "source_spent" : "pending" })
        continue
      }
      const status = p.hash ? await readPoolV4BrowserSettlement({ profile: this.#config.profile, ownerAddress: this.#account.address, hash: p.hash, poolAddress: p.pool, nullifierHashes: p.nullifiers, callHash: p.callHash, rpc: this.#rpc }) : "pending"
      if (status !== "pending") this.#config.storage.removeItem(key)
      results.push({ hash: p.hash, status })
    }
    return results
  }
  async quotePayoutV7(params: AssetParams & { outputs: Parameters<typeof quotePayoutV7>[0]["outputs"] }) {
    const relayer = this.#config.selectedRelayer; check(relayer, "A verified V7 relayer must be explicitly configured.")
    const state = await this.#recover(params), locked = new Set(this.#pending().flatMap(p => p.value.nullifiers))
    const sourceNotes = state.notes.filter(n => !locked.has(n.nullifierHash)).slice(0, 4)
    check(sourceNotes.length > 0, "Private balance is unavailable for payout.")
    const destinationAmounts = params.outputs.map(output => {
      const routes = this.#config.destinationRoutes.filter(r => r.chainId === output.destinationChainId && getAddress(r.token) === getAddress(output.destinationToken))
      check(routes.length === 1 && output.amountOut > 0n, "The destination token precision is not explicitly configured.")
      const decimals = routes[0]!.decimals
      if (decimals >= 6) return output.amountOut * 10n ** BigInt(decimals - 6)
      const divisor = 10n ** BigInt(6 - decimals)
      check(output.amountOut % divisor === 0n, "The source amount cannot be represented exactly by the destination token.")
      return output.amountOut / divisor
    })
    const quote = await quotePayoutV7({ ownerAddress: this.#account.address, assetId: params.assetId, sourcePool: params.poolAddress, inputCount: sourceNotes.length, selectedRelayer: relayer, outputs: params.outputs }, this.#runtime)
    check(quote.children.length === destinationAmounts.length && quote.children.every((child, i) => child.intent.destinationAmountOut === destinationAmounts[i]), "The quoted destination amount does not match its configured token precision.")
    this.#quotes.set(quote.quoteSessionId, { quote: structuredClone(quote), commitments: sourceNotes.map(n => n.commitment) })
    return quote
  }
  async authorizePayoutV7(quoteSessionId: Hex) {
    check(!this.#busy, "An SDK execution is already being prepared."); this.#busy = true
    try {
      const retained = this.#quotes.get(quoteSessionId); check(retained, "A retained reviewed V7 quote is required.")
      const q = retained.quote, state = await this.#recover({ assetId: q.assetId, poolAddress: q.sourcePool }), keys = await this.#root()
      const locked = new Set(this.#pending().flatMap(p => p.value.nullifiers))
      const sourceNotes = retained.commitments.map(c => state.notes.find(n => n.commitment === c && !locked.has(n.nullifierHash)))
      check(sourceNotes.every(n => n), "The quote's selected notes changed; request a fresh quote.")
      const args = { profile: this.#config.profile, keyEnvironment: this.#config.keyEnvironment, ownerAddress: this.#account.address, assetId: q.assetId, state, sourceNotes: sourceNotes as NonNullable<typeof sourceNotes[number]>[], recoveryPrivateKeyB64: keys.privateKeyB64, recoveryPublicKeyB64: keys.publicKeyB64, rpc: this.#rpc, runtime: this.#runtime, isCurrent: () => true, quote: q, selectedRelayer: this.#config.selectedRelayer! }
      let pendingKey: string | undefined
      let accepted
      try {
        accepted = await authorizePayoutV7({ ...args, onPrepared: capsule => {
          pendingKey = this.#pendingPrefix() + capsule.sourceNullifierHashes.join("")
          this.#save(pendingKey, { owner: this.#account.address, chainId: this.#config.profile.chainId, pool: q.sourcePool, assetId: q.assetId, nullifiers: capsule.sourceNullifierHashes, manifestHash: capsule.manifestHash } satisfies Pending)
        } }, this.#runtime)
      } catch (error) {
        if (pendingKey && !(error as { submissionUncertain?: boolean }).submissionUncertain) this.#config.storage.removeItem(pendingKey)
        throw error
      }
      this.#quotes.delete(quoteSessionId)
      return { kind: "relayer_submitted" as const, manifestHash: accepted.capsule.manifestHash, children: accepted.children }
    } finally { this.#busy = false }
  }
  async sendCrossChainShieldedPayment(params: AssetParams & { destinationChainId: number; destinationToken: Address; destinationRecipient: Address; amount: string }) {
    const routes = this.#config.destinationRoutes.filter(r => r.chainId === params.destinationChainId && getAddress(r.token) === getAddress(params.destinationToken))
    check(routes.length === 1 && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(params.amount) && (params.amount.split(".")[1]?.length ?? 0) <= routes[0]!.decimals, "The destination token precision is not explicitly configured or the amount exceeds it.")
    const quote = await this.quotePayoutV7({ ...params, outputs: [{ destinationChainId: params.destinationChainId, destinationToken: params.destinationToken, destinationRecipient: params.destinationRecipient, amountOut: units(params.amount) }] })
    return this.authorizePayoutV7(quote.quoteSessionId)
  }
  async #capsule(manifestHash: Hex) {
    const keys = await this.#root(), states = await Promise.all(this.#config.profile.assets.map(a => this.#recover({ assetId: a.assetId, poolAddress: a.pool })))
    const capsules = await recoverPayoutV7Capsules({ ownerAddress: this.#account.address, profile: this.#config.profile, ownedNullifierHashes: states.flatMap(s => s.history.notes.map(n => n.nullifierHash)), recoveryPublicKeyB64: keys.publicKeyB64, recoveryPrivateKeyB64: keys.privateKeyB64, isCurrent: () => true }, this.#runtime)
    const capsule = capsules.find(c => c.manifestHash === manifestHash); check(capsule, "No wallet-owned V7 recovery record matches this payout."); return capsule
  }
  async readPayoutV7Status(manifestHash: Hex) { return readPayoutV7Status(await this.#capsule(manifestHash), this.#runtime) }
  getCrossChainPayoutStatus(manifestHash: Hex) { return this.readPayoutV7Status(manifestHash) }
  async claimPayoutV7Refund(manifestHash: Hex) {
    const capsule = await this.#capsule(manifestHash)
    return claimPayoutV7Refund({ capsule, ownerAddress: this.#account.address, wallet: { writeContract: args => this.#wallet.writeContract(args) }, isCurrent: () => true, readStatus: async intentHash => { const status = await readPayoutV7Status(capsule, this.#runtime), child = status.children.find(c => c.intentHash === intentHash); check(child, "Refund child is unavailable."); return { status: child.status, recoveryAvailableAt: BigInt(child.recoveryAvailableAt) } } })
  }
}
