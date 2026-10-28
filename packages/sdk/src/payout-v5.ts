import { buildCanonicalPayoutV5AuthorizationMessage } from "@parly/shared-types"
import { encodeAbiParameters, getAddress, isAddress, keccak256, type Address } from "viem"
import type { PayoutV5Quote, PayoutV5QuoteAuthorization } from "./public-api.js"

const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/u
const AMOUNT_RE = /^(?:0|[1-9][0-9]*)$/u

function amount(value: string, field: string, positive = false) {
  if (!AMOUNT_RE.test(value) || (positive && BigInt(value) === 0n)) throw new Error(`${field} is invalid.`)
  return value
}

function address(value: string, field: string) {
  if (!isAddress(value)) throw new Error(`${field} is invalid.`)
  return getAddress(value)
}

function hash(value: string, field: string) {
  if (!BYTES32_RE.test(value)) throw new Error(`${field} is invalid.`)
  return value.toLowerCase()
}

export function derivePayoutV5RefundSalt(args: {
  sourceNoteSecret: string
  sourceNoteNullifier: string
  refundWallet: Address
  escrowSalt: `0x${string}`
}) {
  if (!/^\d+$/u.test(args.sourceNoteSecret) || !/^\d+$/u.test(args.sourceNoteNullifier)) {
    throw new Error("Payout recovery requires a valid private source note.")
  }
  if (!BYTES32_RE.test(args.escrowSalt)) throw new Error("escrowSalt must be bytes32.")
  return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }],
    ["parly:payout-v5-refund:v1", BigInt(args.sourceNoteSecret), BigInt(args.sourceNoteNullifier),
      getAddress(args.refundWallet), args.escrowSalt]
  ))
}

export function derivePayoutV5RefundCommitment(args: {
  chainId: number
  refundWallet: Address
  escrowSalt: `0x${string}`
  refundSalt: `0x${string}`
}) {
  if (!Number.isSafeInteger(args.chainId) || args.chainId <= 0 ||
      !BYTES32_RE.test(args.escrowSalt) || !BYTES32_RE.test(args.refundSalt)) {
    throw new Error("V5 refund commitment input is invalid.")
  }
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
    [BigInt(args.chainId), args.escrowSalt, getAddress(args.refundWallet), args.refundSalt]
  ))
}

export function buildPayoutV5AuthorizationMessage(args: {
  quote: PayoutV5Quote
  authorization: Pick<PayoutV5QuoteAuthorization, "wallet" | "issuedAt" | "nonce">
}) {
  const input = args.quote
  const operatorFee = BigInt(amount(input.submissionReimbursementBaseUnits, "submission reimbursement")) +
    BigInt(amount(input.deliverySuccessFeeBaseUnits, "delivery success fee"))
  if (operatorFee > BigInt(amount(input.maximumOperatorFeeBaseUnits, "maximum operator fee"))) {
    throw new Error("The operator fee exceeds the authorized maximum.")
  }
  return buildCanonicalPayoutV5AuthorizationMessage({
    wallet: address(args.authorization.wallet, "wallet"),
    quoteHash: hash(input.quoteHash, "quote hash"),
    assetId: input.assetId,
    sourcePool: address(input.sourcePool, "source pool"),
    sourceToken: address(input.sourceToken, "source token"),
    escrow: address(input.escrow, "escrow"),
    escrowAmountBaseUnits: amount(input.escrowAmountBaseUnits, "escrow amount", true),
    executorFeeBaseUnits: amount(input.executorFeeBaseUnits, "executor fee"),
    protocolFeeBaseUnits: amount(input.protocolFeeBaseUnits, "protocol fee"),
    destinationChainId: input.destinationChainId,
    destinationToken: address(input.destinationToken, "destination token"),
    destinationRecipient: address(input.destinationRecipient, "destination recipient"),
    destinationAmountOutBaseUnits: amount(input.destinationAmountOutBaseUnits, "destination amount", true),
    relaySourceAmountBaseUnits: amount(input.relaySourceAmountBaseUnits, "relay source amount", true),
    relayRouteCostBaseUnits: amount(input.relayRouteCostBaseUnits, "relay route cost"),
    submissionReimbursementBaseUnits: amount(input.submissionReimbursementBaseUnits, "submission reimbursement"),
    deliverySuccessFeeBaseUnits: amount(input.deliverySuccessFeeBaseUnits, "delivery success fee"),
    maximumOperatorFeeBaseUnits: amount(input.maximumOperatorFeeBaseUnits, "maximum operator fee"),
    primaryRefundToken: address(input.primaryRefundToken, "primary refund token"),
    secondaryRefundToken: address(input.secondaryRefundToken, "secondary refund token"),
    refundRecipientCommitment: hash(input.refundRecipientCommitment, "refund commitment"),
    requestIdHash: hash(input.requestIdHash, "request hash"),
    refundRouteBindingHash: hash(input.refundRouteBindingHash, "refund route binding"),
    quoteExpiresAt: input.quoteExpiresAt,
    preSubmissionRecoveryDelaySeconds: input.preSubmissionRecoveryDelaySeconds,
    maximumCompletionDelaySeconds: input.maximumCompletionDelaySeconds,
    issuedAt: args.authorization.issuedAt,
    nonce: args.authorization.nonce
  })
}
