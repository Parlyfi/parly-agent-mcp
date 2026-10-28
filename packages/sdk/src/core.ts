import fs from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { requireEnv, requirePositiveChainIdValue } from "@parly/env-utils"
import { buildIndexedMerklePath } from "@parly/crypto-utils"
import { tempoShieldedPoolV2Abi } from "@parly/protocol-abis"
import type { CanonicalRelayExecutionPayload, PublicSurfaceRecord } from "@parly/shared-types"
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  parseUnits
} from "viem"
import { privateKeyToAccount } from "viem/accounts"

import { safeApproveExactSdk } from "./erc20.js"
import {
  preparePoolV3PrivateSend,
  summarizePoolV3PrivateBalance,
  type PoolV3CoinSelectionNote,
  type PoolV3PrivateBalanceSummary,
  type PoolV3PublicSpendPlan
} from "./coin-selection.js"
import {
  type EnvelopeRow,
  fetchEnvelopes,
  fetchLeaves,
  type LeafRow,
  fetchNullifiers,
  fetchRecoveryHeads,
  type NullifierRow,
  type RecoveryHeads
} from "./indexer.js"
import { resolveTempoSettlementEid } from "./lz-options.js"
import {
  createFreshNote,
  createSealedRecoveryEnvelope,
  openSealedNoteEnvelope,
  reconstructEnvelopeNote,
  type NoteEnvelopePayload
} from "./note-crypto.js"
import {
  buildPayoutV5AuthorizationMessage,
  derivePayoutV5RefundCommitment,
  derivePayoutV5RefundSalt
} from "./payout-v5.js"
import { ParlyPublicApiClient, type PayoutV5Acceptance, type PayoutV5Quote } from "./public-api.js"
import { buildSdkRecoveryAuthMessage, deriveRecoveryKeypair } from "./recovery-keys.js"

const require = createRequire(import.meta.url)
const snarkjs = require("snarkjs") as {
  groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmPath: string,
      zkeyPath: string
    ): Promise<{
      proof: {
        pi_a: [string, string]
        pi_b: [[string, string], [string, string]]
        pi_c: [string, string]
      }
      publicSignals: string[]
    }>
  }
}
const { buildPoseidon } = require("circomlibjs") as {
  buildPoseidon(): Promise<any>
}

export type ParlySDKConfig = {
  privateKeyHex: `0x${string}`
  tempoRpcUrl: string
  tempoChainId: number
  tempoLzEid: number
  ponderGraphqlUrl?: string
  proofAssetsBasePath?: string
  webApiBaseUrl?: string
}

export type ExecuteCrossChainPayoutParams = {
  destinationChainId: number
  destinationToken: `0x${string}`
  destinationRecipient: `0x${string}`
  amount: string
  assetId: 1 | 2
  poolAddress: `0x${string}`
  proofAssetsBasePath?: string
}

export type CrossChainPayoutRecovery = {
  adapter: `0x${string}`
  intentHash: `0x${string}`
  escrowSalt: `0x${string}`
  refundSalt: `0x${string}`
  statusAccessToken: string
  sourceNoteNullifierHash: `0x${string}`
}

export type ExecuteCrossChainPayoutOutcome =
  | {
      kind: "relayer_submitted"
      payoutId: string
      supportReference: string
      statusAccessToken: string
      recovery: CrossChainPayoutRecovery
    }
  | { kind: "terminal_failure"; message: string }

export type ExecutePaymentParams = {
  destination: `0x${string}`
  amount: string
  assetId: 1 | 2
  destinationEid: number
  poolAddress: `0x${string}`
  proofAssetsBasePath?: string
}

export type BatchPaymentOutput = {
  destination: `0x${string}`
  amount: string
  destinationEid: number
}

export type ExecuteBatchPaymentParams = {
  outputs: BatchPaymentOutput[]
  assetId: 1 | 2
  poolAddress: `0x${string}`
  proofAssetsBasePath?: string
}

export type ParlyLaunchContext = Pick<ParlySDKConfig, "tempoChainId" | "tempoLzEid"> & {
  publicSurfaces: PublicSurfaceRecord[]
}

export type ExecutePaymentOutcome =
  | { kind: "success"; hash: `0x${string}` }
  | {
      kind: "pending_confirmation"
      hash: `0x${string}`
      message: string
      persistedTo: string | null
    }
  | { kind: "terminal_failure"; hash?: `0x${string}`; message: string }

export type GetPrivateBalanceParams = {
  assetId: 1 | 2
  poolAddress: `0x${string}`
}

export type PreparePrivateSendParams = GetPrivateBalanceParams & {
  amount: string
  finalFees?: string
  consolidationFee?: string
  approvedCommitments?: readonly `0x${string}`[]
}

type PendingSdkExecutionRecord = {
  version: 1
  recordedAt: number
  submittedHash: `0x${string}`
  nullifierHash: `0x${string}`
  pool: `0x${string}`
  destination: `0x${string}`
  destinationEid: number
  assetId: 1 | 2
  approvalToken: `0x${string}` | null
  approvalSpender: `0x${string}` | null
  reason: string
}

type CachedSdkBestNote = {
  envelope: `0x${string}`
  commitment: `0x${string}`
  nullifierHash: `0x${string}`
  amount: string
}

type SdkRecoveryCacheEntry = {
  version: 4
  assetId: 1 | 2
  poolAddress: `0x${string}`
  chainId: number
  recoveryPublicKeyB64: string
  heads: RecoveryHeads
  leaves: Array<{
    commitment: string
    leafIndex: number
    kind?: number
    txHash?: string
    timestamp?: string
  }>
  best: CachedSdkBestNote | null
}

type SdkRecoveryCacheFile = {
  version: 4
  assets: Record<string, SdkRecoveryCacheEntry>
}

const PUBLIC_SURFACES: PublicSurfaceRecord[] = [
  {
    name: "relayer",
    description: "Operator-facing public relayer distribution.",
    audience: "operators"
  },
  {
    name: "sdk",
    description: "Developer-facing public SDK distribution.",
    audience: "developers"
  },
  {
    name: "mcp",
    description: "Parly Unhosted MCP: developer-operated agent tools, separate from Hosted MCP.",
    audience: "agent-integrators"
  }
]

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const
const DEFAULT_RECEIPT_TIMEOUT_MS = 300_000
const DEFAULT_PROOF_ASSETS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../assets"
)

function assertSdkProductionEnv(env: NodeJS.ProcessEnv) {
  if (env.PARLY_ENV !== "mainnet" && env.NEXT_PUBLIC_PARLY_ENV !== "mainnet") {
    return
  }

  for (const [key, value] of Object.entries(env)) {
    if (!value || value.trim() === "" || /^0x0{40}$/iu.test(value.trim())) continue
    if (/SPOKE|PATHUSD|LZD|LAYERZERO|DVN/u.test(key)) {
      throw new Error(`${key} is forbidden in active Tempo-only production SDK runtime.`)
    }
    if (key.includes("RPC") && /moderato|testnet|sepolia/iu.test(value)) {
      throw new Error(`${key} points at a test/staging RPC in active Tempo-only production SDK runtime.`)
    }
  }
}

function recoveryHeadsEqual(a: RecoveryHeads | null, b: RecoveryHeads | null) {
  if (!a || !b) {
    return false
  }
  return (
    a.leafCursor === b.leafCursor &&
    a.envelopeCursor === b.envelopeCursor &&
    a.nullifierCursor === b.nullifierCursor
  )
}

function sdkRecoveryCacheKey(
  assetId: 1 | 2,
  poolAddress: `0x${string}`,
  chainId: number,
  recoveryPublicKeyB64: string
) {
  return `${chainId}:${assetId}:${poolAddress.toLowerCase()}:${recoveryPublicKeyB64}`
}

function loadSdkRecoveryCache(
  assetId: 1 | 2,
  poolAddress: `0x${string}`,
  chainId: number,
  recoveryPublicKeyB64: string
): SdkRecoveryCacheEntry | null {
  const raw = process.env.SDK_RECOVERY_CACHE_FILE
  if (!raw) {
    return null
  }

  const cacheFile = path.resolve(process.cwd(), raw)
  if (!fs.existsSync(cacheFile)) {
    return null
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as SdkRecoveryCacheFile
    const entry = parsed?.assets?.[sdkRecoveryCacheKey(assetId, poolAddress, chainId, recoveryPublicKeyB64)]
    return entry &&
      parsed?.version === 4 &&
      entry.version === 4 &&
      entry.assetId === assetId &&
      entry.chainId === chainId &&
      entry.recoveryPublicKeyB64 === recoveryPublicKeyB64 &&
      entry.poolAddress.toLowerCase() === poolAddress.toLowerCase()
      ? entry
      : null
  } catch {
    return null
  }
}

function saveSdkRecoveryCache(entry: SdkRecoveryCacheEntry) {
  const raw = process.env.SDK_RECOVERY_CACHE_FILE
  if (!raw) {
    return
  }

  const cacheFile = path.resolve(process.cwd(), raw)
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true })

  let file: SdkRecoveryCacheFile = {
    version: 4,
    assets: {}
  }

  try {
    if (fs.existsSync(cacheFile)) {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as SdkRecoveryCacheFile | null
      if (parsed && parsed.assets && typeof parsed.assets === "object" && !Array.isArray(parsed.assets)) {
        file = parsed
      }
    }
  } catch {
      file = {
        version: 4,
        assets: {}
      }
  }

  file.version = 4
  file.assets[sdkRecoveryCacheKey(entry.assetId, entry.poolAddress, entry.chainId, entry.recoveryPublicKeyB64)] = entry
  fs.writeFileSync(cacheFile, JSON.stringify(file, null, 2) + "\n", "utf8")
}

function clearSdkRecoveryCache(
  assetId: 1 | 2,
  poolAddress: `0x${string}`,
  chainId: number,
  recoveryPublicKeyB64: string
) {
  const raw = process.env.SDK_RECOVERY_CACHE_FILE
  if (!raw) {
    return
  }

  const cacheFile = path.resolve(process.cwd(), raw)
  if (!fs.existsSync(cacheFile)) {
    return
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as SdkRecoveryCacheFile
    delete parsed.assets[sdkRecoveryCacheKey(assetId, poolAddress, chainId, recoveryPublicKeyB64)]
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 4,
        assets: parsed.assets || {}
      }, null, 2) + "\n",
      "utf8"
    )
  } catch {
    return
  }
}

function persistSdkPendingExecution(record: PendingSdkExecutionRecord): string | null {
  const raw = process.env.SDK_PENDING_EXECUTIONS_FILE
  if (!raw) {
    return null
  }

  const outputFile = path.resolve(process.cwd(), raw)
  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  fs.appendFileSync(outputFile, `${JSON.stringify(record)}\n`)
  return outputFile
}

function resolveProofAssetsBasePath(explicitPath?: string): string {
  return explicitPath || process.env.PARLY_SDK_ASSETS_PATH || DEFAULT_PROOF_ASSETS_PATH
}

function resolveReceiptTimeoutMs(): number {
  const raw = process.env.SDK_RECEIPT_TIMEOUT_MS
  if (!raw) {
    return DEFAULT_RECEIPT_TIMEOUT_MS
  }

  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error("SDK_RECEIPT_TIMEOUT_MS invalid")
  }

  return value
}

export class ParlySDK {
  readonly config: ParlySDKConfig
  private readonly account
  private readonly publicClient
  private readonly walletClient

  constructor(config: ParlySDKConfig) {
    this.config = config

    const chain = defineChain({
      id: config.tempoChainId,
      name: "Tempo",
      nativeCurrency: { name: "TMP", symbol: "TMP", decimals: 18 },
      rpcUrls: { default: { http: [config.tempoRpcUrl] } }
    })

    this.account = privateKeyToAccount(config.privateKeyHex)
    this.publicClient = createPublicClient({
      chain,
      transport: http(config.tempoRpcUrl)
    })
    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(config.tempoRpcUrl)
    })
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ParlySDK {
    assertSdkProductionEnv(env)

    return new ParlySDK({
      privateKeyHex: requireEnv("AGENT_PRIVATE_KEY", env) as `0x${string}`,
      tempoRpcUrl: requireEnv("TEMPO_RPC_URL", env),
      tempoChainId: requirePositiveChainIdValue(
        env.TEMPO_CHAIN_ID ?? env.NEXT_PUBLIC_TEMPO_CHAIN_ID,
        "TEMPO_CHAIN_ID/NEXT_PUBLIC_TEMPO_CHAIN_ID"
      ),
      tempoLzEid: resolveTempoSettlementEid(
        env.SETTLEMENT_DOMAIN_ID ??
          env.NEXT_PUBLIC_SETTLEMENT_DOMAIN_ID
      ),
      ponderGraphqlUrl: env.PONDER_GRAPHQL_URL ?? env.NEXT_PUBLIC_PONDER_GRAPHQL_URL,
      proofAssetsBasePath: env.PARLY_SDK_ASSETS_PATH,
      webApiBaseUrl: env.PARLY_WEB_API_BASE_URL
    })
  }

  getLaunchContext(): ParlyLaunchContext {
    return {
      tempoChainId: this.config.tempoChainId,
      tempoLzEid: this.config.tempoLzEid,
      publicSurfaces: PUBLIC_SURFACES
    }
  }

  describe(): string {
    return `ParlySDK V16.9.10 ready for Tempo chain ${this.config.tempoChainId} and settlement domain ${this.config.tempoLzEid}.`
  }

  async authenticate(recoveryMessage: string) {
    return (await this.walletClient.signMessage({
      account: this.account,
      message: recoveryMessage
    })) as `0x${string}`
  }

  async getRecoveryKeypair(args: {
    assetId: 1 | 2
    poolAddress: `0x${string}`
  }) {
    const recoveryMessage = buildSdkRecoveryAuthMessage({
      chainId: this.config.tempoChainId,
      settlementDomainId: this.config.tempoLzEid,
      poolAddress: args.poolAddress,
      assetPoolIdentity: `Tempo launch asset ${args.assetId} pool ${args.poolAddress.toLowerCase()}`
    })
    const signature = await this.authenticate(recoveryMessage)
    return deriveRecoveryKeypair(signature, recoveryMessage)
  }

  async recoverLargestNote(assetId: 1 | 2, poolAddress?: `0x${string}`) {
    const resolvedPoolAddress =
      poolAddress ||
      (assetId === 1
        ? (process.env.NEXT_PUBLIC_USDC_POOL as `0x${string}` | undefined)
        : (process.env.NEXT_PUBLIC_USDT_POOL as `0x${string}` | undefined)) ||
      (process.env.PARLY_RECOVERY_POOL_ADDRESS as `0x${string}` | undefined)

    if (!resolvedPoolAddress) {
      throw new Error("poolAddress is required for v2 SDK recovery.")
    }

    const chainId = this.config.tempoChainId
    const keypair = await this.getRecoveryKeypair({ assetId, poolAddress: resolvedPoolAddress })
    const latestHeads = await fetchRecoveryHeads(assetId, {
      ponderUrl: this.config.ponderGraphqlUrl,
      poolAddress: resolvedPoolAddress
    })
    const cached = loadSdkRecoveryCache(assetId, resolvedPoolAddress, chainId, keypair.publicKeyB64)

    if (cached && recoveryHeadsEqual(cached.heads, latestHeads)) {
      try {
        return {
          best: cached.best
            ? {
                payload: await openSealedNoteEnvelope(
                  keypair.publicKeyB64,
                  keypair.privateKeyB64,
                  cached.best.envelope
                ),
                commitment: cached.best.commitment,
                nullifierHash: cached.best.nullifierHash,
                amount: BigInt(cached.best.amount)
              }
            : null,
          leaves: cached.leaves,
          kp: keypair
        }
      } catch {
        clearSdkRecoveryCache(assetId, resolvedPoolAddress, chainId, keypair.publicKeyB64)
      }
    }

    const [envelopes, leaves, nullifiers] = (await Promise.all([
      fetchEnvelopes(assetId, {
        ponderUrl: this.config.ponderGraphqlUrl,
        poolAddress: resolvedPoolAddress
      }),
      fetchLeaves(assetId, {
        ponderUrl: this.config.ponderGraphqlUrl,
        poolAddress: resolvedPoolAddress
      }),
      fetchNullifiers(assetId, {
        ponderUrl: this.config.ponderGraphqlUrl,
        poolAddress: resolvedPoolAddress
      })
    ])) as [EnvelopeRow[], LeafRow[], NullifierRow[]]

    const leafSet = new Set(leaves.map((leaf: any) => String(leaf.commitment).toLowerCase()))
    const spentSet = new Set(
      nullifiers.map((nullifier: any) => String(nullifier.nullifierHash).toLowerCase())
    )

      let best:
        | {
            payload: NoteEnvelopePayload
            envelope: `0x${string}`
            commitment: `0x${string}`
            nullifierHash: `0x${string}`
            amount: bigint
        }
      | null = null

    for (const envelope of envelopes) {
      try {
        const payload = await openSealedNoteEnvelope(
          keypair.publicKeyB64,
          keypair.privateKeyB64,
          envelope.envelope as `0x${string}`
        )

        const reconstructed = await reconstructEnvelopeNote(payload)
        if (
          String(reconstructed.commitment).toLowerCase() !==
          String(envelope.commitment).toLowerCase()
        ) {
          continue
        }
        if (!leafSet.has(String(reconstructed.commitment).toLowerCase())) {
          continue
        }
        if (spentSet.has(String(reconstructed.nullifierHash).toLowerCase())) {
          continue
        }

        const row = {
          payload,
          envelope: envelope.envelope as `0x${string}`,
          commitment: reconstructed.commitment,
          nullifierHash: reconstructed.nullifierHash,
          amount: BigInt(payload.amount)
        }

        if (!best || row.amount > best.amount) {
          best = row
        }
      } catch {
        continue
      }
    }

    saveSdkRecoveryCache({
      version: 4,
      assetId,
      poolAddress: resolvedPoolAddress,
      chainId,
      recoveryPublicKeyB64: keypair.publicKeyB64,
      heads: latestHeads,
      leaves,
      best: best
        ? {
            envelope: best.envelope,
            commitment: best.commitment,
            nullifierHash: best.nullifierHash,
            amount: best.amount.toString()
          }
        : null
    })

    return { best, leaves, kp: keypair }
  }

  private async recoverPoolV3SelectionNotes(
    assetId: 1 | 2,
    poolAddress: `0x${string}`
  ): Promise<PoolV3CoinSelectionNote[]> {
    if (!isAddress(poolAddress) || poolAddress.toLowerCase() === ZERO_ADDRESS) {
      throw new Error("PoolV3 address must be a non-zero address.")
    }

    const keypair = await this.getRecoveryKeypair({ assetId, poolAddress })
    const [envelopes, leaves, nullifiers] = (await Promise.all([
      fetchEnvelopes(assetId, {
        ponderUrl: this.config.ponderGraphqlUrl,
        poolAddress
      }),
      fetchLeaves(assetId, {
        ponderUrl: this.config.ponderGraphqlUrl,
        poolAddress
      }),
      fetchNullifiers(assetId, {
        ponderUrl: this.config.ponderGraphqlUrl,
        poolAddress
      })
    ])) as [EnvelopeRow[], LeafRow[], NullifierRow[]]

    const leavesByCommitment = new Map(
      leaves.map((leaf) => [String(leaf.commitment).toLowerCase(), leaf] as const)
    )
    const spent = new Set(
      nullifiers.map((row) => String(row.nullifierHash).toLowerCase())
    )
    const recovered = new Map<string, PoolV3CoinSelectionNote>()

    for (const envelope of envelopes) {
      try {
        const payload = await openSealedNoteEnvelope(
          keypair.publicKeyB64,
          keypair.privateKeyB64,
          envelope.envelope
        )
        if (
          payload.version !== 2 ||
          payload.poolVersion !== 3 ||
          payload.chainId !== this.config.tempoChainId ||
          Number(payload.assetId) !== assetId ||
          payload.poolAddress.toLowerCase() !== poolAddress.toLowerCase()
        ) {
          continue
        }

        const note = await reconstructEnvelopeNote(payload)
        const commitment = note.commitment.toLowerCase()
        const leaf = leavesByCommitment.get(commitment)
        if (!leaf || spent.has(note.nullifierHash.toLowerCase())) continue

        recovered.set(commitment, {
          commitment: note.commitment,
          amount: BigInt(payload.amount),
          confirmedLeafIndex: Number(leaf.leafIndex),
          chainId: this.config.tempoChainId,
          poolAddress,
          assetId: String(assetId),
          state: "unspent"
        })
      } catch {
        continue
      }
    }

    return [...recovered.values()]
  }

  async getPrivateBalance(
    params: GetPrivateBalanceParams
  ): Promise<PoolV3PrivateBalanceSummary> {
    const notes = await this.recoverPoolV3SelectionNotes(params.assetId, params.poolAddress)
    return summarizePoolV3PrivateBalance({
      notes,
      chainId: this.config.tempoChainId,
      poolAddress: params.poolAddress,
      assetId: String(params.assetId)
    })
  }

  async preparePrivateSend(
    params: PreparePrivateSendParams
  ): Promise<PoolV3PublicSpendPlan> {
    const notes = await this.recoverPoolV3SelectionNotes(params.assetId, params.poolAddress)
    const consolidationFee = parseUnits(params.consolidationFee ?? "0", 6)

    return preparePoolV3PrivateSend({
      notes,
      chainId: this.config.tempoChainId,
      poolAddress: params.poolAddress,
      assetId: String(params.assetId),
      requestedAmount: parseUnits(params.amount, 6),
      finalFees: parseUnits(params.finalFees ?? "0", 6),
      approvedCommitments: params.approvedCommitments,
      consolidationFee: () => consolidationFee
    })
  }

  private async buildPayoutV5PoolPayload(args: {
    quote: PayoutV5Quote
    sourceNote: {
      payload: NoteEnvelopePayload
      commitment: `0x${string}`
      nullifierHash: `0x${string}`
      amount: bigint
    }
    recoveryPublicKeyB64: string
    assetId: 1 | 2
    poolAddress: `0x${string}`
    proofAssetsBasePath?: string
  }): Promise<CanonicalRelayExecutionPayload> {
    const amountIn = BigInt(args.quote.escrowAmountBaseUnits)
    const protocolFee = BigInt(args.quote.protocolFeeBaseUnits)
    const executorFee = BigInt(args.quote.executorFeeBaseUnits)
    const expectedTotal = amountIn + protocolFee + executorFee
    if (BigInt(args.quote.totalNeededFromNoteBaseUnits) !== expectedTotal) {
      throw new Error("The V5 quote total does not match its signed fee components.")
    }
    if (args.sourceNote.amount < expectedTotal) throw new Error("Insufficient private balance for payout and source fees.")

    const [poseidon, leaves, zeros] = await Promise.all([
      buildPoseidon(),
      fetchLeaves(args.assetId, { ponderUrl: this.config.ponderGraphqlUrl, poolAddress: args.poolAddress }),
      Promise.all(Array.from({ length: 32 }, (_, level) => this.publicClient.readContract({
        address: args.poolAddress,
        abi: tempoShieldedPoolV2Abi,
        functionName: "zeros",
        args: [BigInt(level)]
      })))
    ])
    const note = leaves.find((leaf) =>
      String(leaf.commitment).toLowerCase() === args.sourceNote.commitment.toLowerCase()
    )
    if (!note) throw new Error("Private balance note is missing from the current Merkle tree.")
    const treePath = buildIndexedMerklePath({
      levels: 32,
      leaves: leaves.map((leaf) => ({ index: Number(leaf.leafIndex), value: BigInt(leaf.commitment) })),
      leafIndex: Number(note.leafIndex),
      zeros: zeros.map((zero) => BigInt(zero)),
      hash: (left, right) => BigInt(poseidon.F.toString(poseidon([left, right])))
    })
    const proofRoot = `0x${treePath.root.toString(16).padStart(64, "0")}` as `0x${string}`
    const rootIsKnown = await this.publicClient.readContract({
      address: args.poolAddress,
      abi: tempoShieldedPoolV2Abi,
      functionName: "knownRoots",
      args: [proofRoot]
    })
    if (!rootIsKnown) throw new Error("Private balance proof is still syncing.")

    const changeAmount = args.sourceNote.amount - expectedTotal
    let newChangeCommitment = `0x${"0".repeat(64)}` as `0x${string}`
    let newChangeEnvelope = "0x" as `0x${string}`
    let newChangeSecret = "0"
    let newChangeNullifier = "0"
    if (changeAmount > 0n) {
      const change = await createFreshNote(
        args.recoveryPublicKeyB64,
        args.sourceNote.payload.depositor,
        args.assetId,
        changeAmount.toString(),
        "change"
      )
      newChangeCommitment = change.commitment
      newChangeEnvelope = change.envelope
      newChangeSecret = change.secret
      newChangeNullifier = change.nullifier
    }

    const recipients = [getAddress(args.quote.escrow), ...Array(9).fill(ZERO_ADDRESS)] as `0x${string}`[]
    const amounts = [amountIn, ...Array(9).fill(0n)]
    const destinationEids = Array(10).fill(this.config.tempoLzEid) as number[]
    const circuitInputs = {
      root: treePath.root.toString(),
      nullifierHash: BigInt(args.sourceNote.nullifierHash).toString(),
      protocol_fee: protocolFee.toString(),
      executor_fee: executorFee.toString(),
      total_input_amount: args.sourceNote.payload.amount,
      asset_id: String(args.assetId),
      local_eid: String(this.config.tempoLzEid),
      recipients: recipients.map((recipient) => BigInt(recipient).toString()),
      amounts: amounts.map(String),
      dest_eids: destinationEids.map(String),
      new_change_commitment: BigInt(newChangeCommitment).toString(),
      relayer: BigInt(getAddress(args.quote.withdrawalExecutor)).toString(),
      secret: args.sourceNote.payload.secret,
      nullifier: args.sourceNote.payload.nullifier,
      depositor: BigInt(args.sourceNote.payload.depositor).toString(),
      pathElements: treePath.pathElements.map(String),
      pathIndices: treePath.pathIndices,
      new_change_secret: newChangeSecret,
      new_change_nullifier: newChangeNullifier
    }
    const assetsBasePath = resolveProofAssetsBasePath(args.proofAssetsBasePath || this.config.proofAssetsBasePath)
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInputs,
      `${assetsBasePath}/joinsplit.wasm`,
      `${assetsBasePath}/joinsplit_final.zkey`
    )
    const mappedSignals = publicSignals.map((signal) => BigInt(signal))
    if (mappedSignals[11] !== treePath.root) throw new Error("Generated proof root does not match the selected private balance.")
    const hex = (value: string) => `0x${BigInt(value).toString(16).padStart(64, "0")}` as `0x${string}`
    return {
      pool: args.poolAddress,
      pA: [hex(proof.pi_a[0]), hex(proof.pi_a[1])],
      pB: [[hex(proof.pi_b[0][1]), hex(proof.pi_b[0][0])], [hex(proof.pi_b[1][1]), hex(proof.pi_b[1][0])]],
      pC: [hex(proof.pi_c[0]), hex(proof.pi_c[1])],
      pubSignals: publicSignals,
      recipients,
      amounts: amounts.map(String),
      destEids: destinationEids,
      newChangeCommitment,
      newChangeEnvelope,
      lzOptions: Array(10).fill("0x") as `0x${string}`[],
      payoutV5: {
        intentHash: args.quote.quoteHash,
        adapter: getAddress(args.quote.adapter),
        withdrawalExecutor: getAddress(args.quote.withdrawalExecutor),
        escrow: getAddress(args.quote.escrow),
        amountIn: amountIn.toString(),
        executorFee: executorFee.toString()
      }
    }
  }

  async sendCrossChainShieldedPayment(
    params: ExecuteCrossChainPayoutParams
  ): Promise<ExecuteCrossChainPayoutOutcome> {
    try {
      const baseUrl = this.config.webApiBaseUrl?.trim()
      if (!baseUrl) throw new Error("webApiBaseUrl is required for cross-chain payouts.")
      if (!isAddress(params.poolAddress) || !isAddress(params.destinationToken) || !isAddress(params.destinationRecipient)) {
        throw new Error("Cross-chain payout addresses are invalid.")
      }
      if (!Number.isSafeInteger(params.destinationChainId) || params.destinationChainId <= 0 ||
          params.destinationChainId === this.config.tempoChainId) {
        throw new Error("Cross-chain destination is invalid.")
      }
      const amountOut = parseUnits(params.amount, 6)
      if (amountOut <= 0n) throw new Error("Payout amount must be positive.")
      const { best, kp } = await this.recoverLargestNote(params.assetId, params.poolAddress)
      if (!best) throw new Error("No live note found.")

      const escrowSalt = `0x${randomBytes(32).toString("hex")}` as `0x${string}`
      const refundSalt = derivePayoutV5RefundSalt({
        sourceNoteSecret: best.payload.secret,
        sourceNoteNullifier: best.payload.nullifier,
        refundWallet: this.account.address,
        escrowSalt
      })
      const refundRecipientCommitment = derivePayoutV5RefundCommitment({
        chainId: this.config.tempoChainId,
        refundWallet: this.account.address,
        escrowSalt,
        refundSalt
      })
      const api = new ParlyPublicApiClient(baseUrl)
      const quoted = await api.quoteCrossChainPayout({
        assetId: params.assetId,
        sourcePool: getAddress(params.poolAddress),
        destinationChainId: params.destinationChainId,
        destinationToken: getAddress(params.destinationToken),
        destinationRecipient: getAddress(params.destinationRecipient),
        amountOutBaseUnits: amountOut.toString(),
        refundWallet: this.account.address,
        refundRecipientCommitment,
        escrowSalt
      })
      if (!quoted.ok || !quoted.quote) throw new Error(quoted.error || "Cross-chain payout quote is unavailable.")
      const quote = quoted.quote
      const poolPayload = await this.buildPayoutV5PoolPayload({
        quote,
        sourceNote: best,
        recoveryPublicKeyB64: kp.publicKeyB64,
        assetId: params.assetId,
        poolAddress: getAddress(params.poolAddress),
        proofAssetsBasePath: params.proofAssetsBasePath
      })
      const issuedAt = Math.floor(Date.now() / 1000)
      if (quote.quoteExpiresAt < issuedAt + 300) throw new Error("The payout quote expired while its private proof was prepared.")
      const authorizationBase = {
        wallet: this.account.address,
        issuedAt,
        nonce: randomBytes(24).toString("base64url")
      }
      const authorizationMessage = buildPayoutV5AuthorizationMessage({ quote, authorization: authorizationBase })
      const authorization = {
        ...authorizationBase,
        signature: await this.walletClient.signMessage({ account: this.account, message: authorizationMessage })
      }
      const accepted = await api.authorizeCrossChainPayout({ quoteHash: quote.quoteHash, authorization })
      if (!accepted.ok || !accepted.payout) throw new Error(accepted.error || "Cross-chain payout authorization was rejected.")
      const payout: PayoutV5Acceptance = accepted.payout
      const capsule = {
        version: 2,
        adapterVersion: "v5",
        chainId: this.config.tempoChainId,
        statusAccessToken: payout.statusAccessToken,
        adapter: payout.adapter,
        intentHash: payout.intentHash,
        escrowSalt,
        sourceNoteNullifierHash: best.nullifierHash,
        assetId: params.assetId,
        amountLabel: params.amount,
        destinationLabel: String(params.destinationChainId),
        createdAt: issuedAt
      } as const
      await api.storePayoutRecoveryCapsule({
        statusAccessToken: payout.statusAccessToken,
        adapterVersion: "v5",
        recoveryKeyHash: createHash("sha256").update(kp.publicKeyB64).digest("hex"),
        sealedPayload: await createSealedRecoveryEnvelope(kp.publicKeyB64, capsule)
      })
      await api.attachCrossChainPayoutProof({
        statusAccessToken: payout.statusAccessToken,
        payload: poolPayload as unknown as Record<string, unknown>
      })
      return {
        kind: "relayer_submitted",
        payoutId: payout.payoutId,
        supportReference: payout.supportReference,
        statusAccessToken: payout.statusAccessToken,
        recovery: {
          adapter: payout.adapter,
          intentHash: payout.intentHash,
          escrowSalt,
          refundSalt,
          statusAccessToken: payout.statusAccessToken,
          sourceNoteNullifierHash: best.nullifierHash
        }
      }
    } catch (error) {
      return { kind: "terminal_failure", message: error instanceof Error ? error.message : String(error) }
    }
  }

  async executeAgenticPayment(params: ExecutePaymentParams | ExecuteBatchPaymentParams): Promise<ExecutePaymentOutcome> {
    let approvalToken: `0x${string}` | null = null
    let submittedHash: `0x${string}` | null = null
    let shouldCleanupApproval = false
    let finalHash: `0x${string}` | null = null
    let replacementReason: "replaced" | "repriced" | "cancelled" | null = null
    let pendingRecordOutput: BatchPaymentOutput | null = null
    let activeNullifierHash =
      "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`

    try {
      if (!isAddress(params.poolAddress) || params.poolAddress.toLowerCase() === ZERO_ADDRESS) {
        throw new Error("Pool address must be a non-zero address.")
      }

      const outputs =
        "outputs" in params
          ? params.outputs
          : [
              {
                destination: params.destination,
                amount: params.amount,
                destinationEid: params.destinationEid
              }
            ]
      if (outputs.length < 1 || outputs.length > 10) {
        throw new Error("Batch send supports 1 to 10 payout lanes.")
      }
      pendingRecordOutput = outputs[0] ?? null

      const { best, kp } = await this.recoverLargestNote(params.assetId, params.poolAddress)
      if (!best) {
        throw new Error("No live note found.")
      }
      activeNullifierHash = best.nullifierHash as `0x${string}`

      const [poseidon, leaves, zeros] = await Promise.all([
        buildPoseidon(),
        fetchLeaves(params.assetId, {
          ponderUrl: this.config.ponderGraphqlUrl,
          poolAddress: params.poolAddress
        }),
        Promise.all(
          Array.from({ length: 32 }, (_, level) =>
            this.publicClient.readContract({
              address: params.poolAddress,
              abi: tempoShieldedPoolV2Abi,
              functionName: "zeros",
              args: [BigInt(level)]
            })
          )
        )
      ])

      const note = leaves.find(
        (leaf) =>
          String(leaf.commitment).toLowerCase() === String(best.commitment).toLowerCase()
      )
      if (!note) {
        throw new Error("Note not found in Merkle tree.")
      }

      const treePath = buildIndexedMerklePath({
        levels: 32,
        leaves: leaves.map((leaf) => ({
          index: Number(leaf.leafIndex),
          value: BigInt(leaf.commitment)
        })),
        leafIndex: Number(note.leafIndex),
        zeros: zeros.map((zero) => BigInt(zero)),
        hash: (left, right) => BigInt(poseidon.F.toString(poseidon([left, right])))
      })
      const proofRoot = `0x${treePath.root.toString(16).padStart(64, "0")}` as `0x${string}`
      const rootIsKnown = await this.publicClient.readContract({
        address: params.poolAddress,
        abi: tempoShieldedPoolV2Abi,
        functionName: "knownRoots",
        args: [proofRoot]
      })
      if (!rootIsKnown) {
        throw new Error("Private balance proof is still syncing. Refresh recovery and try again.")
      }

      const localEid = this.config.tempoLzEid
      for (const output of outputs) {
        if (!isAddress(output.destination) || output.destination.toLowerCase() === ZERO_ADDRESS) {
          throw new Error("Destination must be a non-zero address.")
        }
        if (output.destinationEid !== localEid) {
          throw new Error(
            "Cross-chain private sends are not enabled in this SDK path. Use the public payment route APIs for supported cross-chain deposits."
          )
        }
      }
      const outputAmounts = outputs.map((output) => parseUnits(output.amount, 6))
      const amount = outputAmounts.reduce((sum, value) => sum + value, 0n)

      const feeBps = (await this.publicClient.readContract({
        address: params.poolAddress,
        abi: tempoShieldedPoolV2Abi,
        functionName: "globalFeeBps"
      })) as bigint

      const protocolFee = (amount * feeBps) / 10_000n
      const executorFee = 0n
      const changeAmount = best.amount - amount - protocolFee - executorFee
      if (changeAmount < 0n) {
        throw new Error("Insufficient balance.")
      }

      let newChangeCommitment =
        "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`
      let newChangeEnvelope = "0x" as `0x${string}`
      let newChangeSecret = "0"
      let newChangeNullifier = "0"

      if (changeAmount > 0n) {
        const freshChange = await createFreshNote(
          kp.publicKeyB64,
          best.payload.depositor,
          params.assetId,
          changeAmount.toString(),
          "change"
        )

        newChangeCommitment = freshChange.commitment
        newChangeEnvelope = freshChange.envelope
        newChangeSecret = freshChange.secret
        newChangeNullifier = freshChange.nullifier
      }

      const circuitInputs = {
        root: treePath.root.toString(),
        nullifierHash: BigInt(best.nullifierHash).toString(),
        protocol_fee: protocolFee.toString(),
        executor_fee: executorFee.toString(),
        total_input_amount: best.payload.amount,
        asset_id: params.assetId.toString(),
        local_eid: String(localEid),
        recipients: [
          ...outputs.map((output) => BigInt(output.destination).toString()),
          ...Array(10 - outputs.length).fill("0")
        ],
        amounts: [
          ...outputAmounts.map((outputAmount) => outputAmount.toString()),
          ...Array(10 - outputs.length).fill("0")
        ],
        dest_eids: [
          ...outputs.map((output) => String(output.destinationEid)),
          ...Array(10 - outputs.length).fill(String(localEid))
        ],
        new_change_commitment: BigInt(newChangeCommitment).toString(),
        relayer: BigInt(this.account.address).toString(),
        secret: best.payload.secret,
        nullifier: best.payload.nullifier,
        depositor: BigInt(best.payload.depositor).toString(),
        pathElements: treePath.pathElements.map((element) => element.toString()),
        pathIndices: treePath.pathIndices,
        new_change_secret: newChangeSecret,
        new_change_nullifier: newChangeNullifier
      }

      const assetsBasePath = resolveProofAssetsBasePath(
        params.proofAssetsBasePath || this.config.proofAssetsBasePath
      )

      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        circuitInputs,
        `${assetsBasePath}/joinsplit.wasm`,
        `${assetsBasePath}/joinsplit_final.zkey`
      )

      const pA = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint]

      const pB = [
        [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
        [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])]
      ] as [[bigint, bigint], [bigint, bigint]]

      const pC = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint]

      const mappedSignals = publicSignals.map((signal: string) => BigInt(signal))
      if (mappedSignals[11] !== treePath.root) {
        throw new Error("Generated proof root does not match the selected private balance.")
      }
      const receiptTimeoutMs = resolveReceiptTimeoutMs()

      submittedHash = await this.walletClient.writeContract({
        address: params.poolAddress,
        abi: tempoShieldedPoolV2Abi,
        functionName: "batchWithdraw",
        args: [
          pA,
          pB,
          pC,
          mappedSignals as any,
          [...outputs.map((output) => output.destination), ...Array(10 - outputs.length).fill(ZERO_ADDRESS)],
          [...outputAmounts, ...Array(10 - outputs.length).fill(0n)],
          [...outputs.map((output) => output.destinationEid), ...Array(10 - outputs.length).fill(localEid)],
          newChangeCommitment,
          newChangeEnvelope
        ]
      })

      finalHash = submittedHash

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: submittedHash,
        timeout: receiptTimeoutMs,
        onReplaced: (replacement) => {
          replacementReason = replacement.reason
          finalHash = replacement.transactionReceipt.transactionHash as `0x${string}`
        }
      })

      if (replacementReason === "cancelled") {
        shouldCleanupApproval = true
        return {
          kind: "terminal_failure",
          hash: finalHash || submittedHash,
          message: "Payment transaction cancelled before inclusion."
        }
      }

      if (replacementReason === "replaced") {
        shouldCleanupApproval = true
        return {
          kind: "terminal_failure",
          hash: finalHash || submittedHash,
          message: "Payment transaction replaced before inclusion."
        }
      }

      if (receipt.status !== "success") {
        shouldCleanupApproval = true
        return {
          kind: "terminal_failure",
          hash: finalHash || submittedHash,
          message: `Payment transaction reverted: ${finalHash || submittedHash}`
        }
      }

      return { kind: "success", hash: finalHash || submittedHash }
    } catch (error: any) {
      const message = error?.message || String(error)

      if (submittedHash) {
        const persistedTo = persistSdkPendingExecution({
          version: 1,
          recordedAt: Math.floor(Date.now() / 1000),
          submittedHash: finalHash || submittedHash,
          nullifierHash: activeNullifierHash,
          pool: params.poolAddress,
          destination: pendingRecordOutput?.destination ?? ZERO_ADDRESS,
          destinationEid: pendingRecordOutput?.destinationEid ?? this.config.tempoLzEid,
          assetId: params.assetId,
          approvalToken,
          approvalSpender: params.poolAddress,
          reason: message
        })

        return {
          kind: "pending_confirmation",
          hash: finalHash || submittedHash,
          message,
          persistedTo
        }
      }

      shouldCleanupApproval = true
      return { kind: "terminal_failure", message }
    } finally {
      if (approvalToken && (shouldCleanupApproval || !submittedHash)) {
        try {
          await safeApproveExactSdk({
            token: approvalToken,
            spender: params.poolAddress,
            amount: 0n,
            owner: this.account.address,
            publicClient: this.publicClient,
            walletClient: this.walletClient
          })
        } catch (cleanupError: any) {
          console.error(`SDK cleanup error: ${cleanupError.message || cleanupError}`)
        }
      }
    }
  }

  async sendShieldedPayment(
    params?: ExecutePaymentParams
  ): Promise<ExecutePaymentOutcome> {
    if (!params) {
      return {
        kind: "terminal_failure",
        message: "Payment params required."
      }
    }

    return this.executeAgenticPayment(params)
  }

  async sendShieldedBatchPayment(
    params?: ExecuteBatchPaymentParams
  ): Promise<ExecutePaymentOutcome> {
    if (!params) {
      return {
        kind: "terminal_failure",
        message: "Batch payment params required."
      }
    }

    return this.executeAgenticPayment(params)
  }

  /**
   * @deprecated Use sendShieldedPayment() for new Phase 3 integrations.
   * This legacy alias remains for SDK compatibility and delegates to the
   * Send-named API without changing payment behavior.
   */
  async executeShieldedPayment(
    params?: ExecutePaymentParams
  ): Promise<ExecutePaymentOutcome> {
    return this.sendShieldedPayment(params)
  }
}
