import {
  buildCanonicalPayoutV6AuthorizationMessage,
  buildCanonicalPayoutV6ManifestText
} from "@parly/shared-types"
import { encodeAbiParameters, getAddress, isAddress, keccak256, toHex, type Address } from "viem"
import type { PayoutV6Authorization, PayoutV6Manifest } from "./public-api.js"

export type { PayoutV6Authorization, PayoutV6Manifest } from "./public-api.js"

const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/u
const AMOUNT_RE = /^(?:0|[1-9][0-9]*)$/u

function amount(value: string, field: string, positive = false) {
  if (!AMOUNT_RE.test(value) || (positive && BigInt(value) === 0n)) throw new Error(`${field} is invalid.`)
  return BigInt(value)
}

function address(value: string, field: string) {
  if (!isAddress(value)) throw new Error(`${field} is invalid.`)
  return getAddress(value)
}

function hash(value: string, field: string) {
  if (!BYTES32_RE.test(value)) throw new Error(`${field} is invalid.`)
  return value.toLowerCase() as `0x${string}`
}

export function derivePayoutV6SourceFingerprint(
  sourceNotes: readonly { secret: string; nullifier: string }[]
) {
  if (sourceNotes.length < 1 || sourceNotes.length > 4 ||
      sourceNotes.some((note) => !/^\d+$/u.test(note.secret) || !/^\d+$/u.test(note.nullifier))) {
    throw new Error("Payout V6 recovery requires one to four valid private source notes.")
  }
  return keccak256(encodeAbiParameters(
    [{ type: "uint256[]" }, { type: "uint256[]" }],
    [sourceNotes.map((note) => BigInt(note.secret)), sourceNotes.map((note) => BigInt(note.nullifier))]
  ))
}

export function derivePayoutV6RefundSalt(args: {
  chainId: number
  adapter: Address
  escrowSalt: `0x${string}`
  clientAuthorizationId: `0x${string}`
  sourceNotes: readonly { secret: string; nullifier: string }[]
}) {
  if (!Number.isSafeInteger(args.chainId) || args.chainId <= 0) throw new Error("chainId is invalid.")
  return keccak256(encodeAbiParameters(
    [
      { type: "string" },
      { type: "uint256" },
      { type: "address" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" }
    ],
    [
      "parly:payout-v6-refund:v1",
      BigInt(args.chainId),
      address(args.adapter, "adapter"),
      hash(args.escrowSalt, "escrow salt"),
      hash(args.clientAuthorizationId, "client authorization id"),
      derivePayoutV6SourceFingerprint(args.sourceNotes)
    ]
  ))
}

export function derivePayoutV6RefundCommitment(args: {
  chainId: number
  refundWallet: Address
  escrowSalt: `0x${string}`
  refundSalt: `0x${string}`
}) {
  if (!Number.isSafeInteger(args.chainId) || args.chainId <= 0) throw new Error("chainId is invalid.")
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
    [
      BigInt(args.chainId),
      hash(args.escrowSalt, "escrow salt"),
      address(args.refundWallet, "refund wallet"),
      hash(args.refundSalt, "refund salt")
    ]
  ))
}

export function computePayoutV6ManifestHash(manifest: PayoutV6Manifest) {
  return keccak256(toHex(buildCanonicalPayoutV6ManifestText({ ...manifest, manifestHash: "0x" + "00".repeat(32) })))
}

export function buildPayoutV6AuthorizationMessage(args: {
  manifest: PayoutV6Manifest
  authorization: Pick<PayoutV6Authorization, "wallet" | "issuedAt" | "nonce">
}) {
  const input = args.manifest
  if (input.version !== 6 || input.inputCount < 1 || input.inputCount > 4) {
    throw new Error("Payout V6 input count is invalid.")
  }
  if (input.preSubmissionRecoveryDelaySeconds < 300 || input.preSubmissionRecoveryDelaySeconds > 600) {
    throw new Error("Payout V6 recovery delay is invalid.")
  }
  if (input.children.length < 1 || input.children.length > 10) throw new Error("Payout V6 recipient count is invalid.")
  hash(input.manifestHash, "manifest hash")
  hash(input.clientAuthorizationId, "client authorization id")
  hash(input.sourceCallHash, "source call hash")
  hash(input.sealedExecutionPayloadHash, "sealed execution payload hash")
  address(input.adapter, "adapter")
  address(input.withdrawalExecutor, "withdrawal executor")
  address(input.selectedRelayer, "selected relayer")
  hash(input.relayerPublicKeyHash, "relayer public key hash")
  address(input.sourcePool, "source pool")
  address(input.sourceToken, "source token")

  const sourceFee = amount(input.sourceExecutorFeeBaseUnits, "source executor fee")
  const allocations = input.children.reduce(
    (total, child) => total + amount(child.sourceExecutorFeeAllocationBaseUnits, "source fee allocation"),
    0n
  )
  if (sourceFee !== allocations) throw new Error("The source executor fee does not match its child allocations.")
  const escrowTotal = input.children.reduce(
    (total, child) => total + amount(child.escrowAmountBaseUnits, "child escrow amount", true),
    0n
  )
  const destinationTotal = input.children.reduce(
    (total, child) => total + amount(child.destinationAmountOutBaseUnits, "child destination amount", true),
    0n
  )
  if (escrowTotal !== amount(input.totalEscrowAmountBaseUnits, "total escrow amount", true) ||
      destinationTotal !== amount(input.totalDestinationAmountBaseUnits, "total destination amount", true) ||
      escrowTotal + sourceFee + amount(input.protocolFeeBaseUnits, "protocol fee") !==
        amount(input.maximumTotalNoteDeductionBaseUnits, "maximum total note deduction", true)) {
    throw new Error("Payout V6 manifest totals do not reconcile.")
  }
  for (const child of input.children) {
    hash(child.intentHash, "child intent hash")
    address(child.escrow, "child escrow")
    address(child.destinationToken, "child destination token")
    address(child.destinationRecipient, "child destination recipient")
    hash(child.refundRecipientCommitment, "child refund commitment")
    hash(child.requestIdHash, "child request hash")
    hash(child.refundRouteBindingHash, "child refund route binding")
    const operatorFee =
      amount(child.sourceExecutorFeeAllocationBaseUnits, "child source fee allocation") +
      amount(child.submissionReimbursementBaseUnits, "child submission reimbursement") +
      amount(child.deliverySuccessFeeBaseUnits, "child delivery success fee")
    const cap = (amount(child.escrowAmountBaseUnits, "child escrow amount", true) * 35n + 9_999n) / 10_000n
    if (operatorFee > cap) throw new Error("A child route exceeds the aggregate relayer fee cap.")
  }
  return buildCanonicalPayoutV6AuthorizationMessage({
    manifest: input,
    wallet: address(args.authorization.wallet, "wallet"),
    issuedAt: args.authorization.issuedAt,
    nonce: args.authorization.nonce
  })
}

export function allocatePayoutV6SourceFee(args: {
  sourceFee: bigint
  children: readonly {
    escrowAmount: bigint
    submissionReimbursement: bigint
    deliverySuccessFee: bigint
  }[]
}) {
  if (args.sourceFee < 0n || args.children.length < 1 || args.children.length > 10) {
    throw new Error("Payout V6 source fee allocation is invalid.")
  }
  const totalEscrow = args.children.reduce((sum, child) => {
    if (
      child.escrowAmount <= 0n ||
      child.submissionReimbursement < 0n ||
      child.deliverySuccessFee < 0n
    ) {
      throw new Error("Payout V6 source fee allocation is invalid.")
    }
    return sum + child.escrowAmount
  }, 0n)
  const capacities = args.children.map((child) => {
    const cap = (child.escrowAmount * 35n + 9_999n) / 10_000n
    const committed = child.submissionReimbursement + child.deliverySuccessFee
    if (committed > cap) throw new Error("Payout V6 child fees exceed the aggregate cap.")
    return cap - committed
  })
  if (capacities.reduce((sum, value) => sum + value, 0n) < args.sourceFee) {
    throw new Error("Payout V6 source fee exceeds the aggregate cap.")
  }
  const allocations = args.children.map((child, index) => {
    const proportional = (args.sourceFee * child.escrowAmount) / totalEscrow
    return proportional > capacities[index]! ? capacities[index]! : proportional
  })
  let remaining = args.sourceFee - allocations.reduce((sum, value) => sum + value, 0n)
  for (let index = 0; remaining > 0n && index < allocations.length; index += 1) {
    const addition = capacities[index]! - allocations[index]! < remaining
      ? capacities[index]! - allocations[index]!
      : remaining
    allocations[index] += addition
    remaining -= addition
  }
  if (remaining !== 0n) throw new Error("Payout V6 source fee allocation is incomplete.")
  return allocations
}
