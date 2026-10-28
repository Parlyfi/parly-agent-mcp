import assert from "node:assert/strict"
import test from "node:test"

import {
  buildPayoutV5AuthorizationMessage,
  derivePayoutV5RefundCommitment,
  derivePayoutV5RefundSalt
} from "../dist/payout-v5.js"

const A = "0x1111111111111111111111111111111111111111"
const B = "0x2222222222222222222222222222222222222222"
const C = "0x3333333333333333333333333333333333333333"
const D = "0x4444444444444444444444444444444444444444"
const H1 = `0x${"11".repeat(32)}`
const H2 = `0x${"22".repeat(32)}`
const H3 = `0x${"33".repeat(32)}`
const H4 = `0x${"44".repeat(32)}`

function quote(overrides = {}) {
  return {
    quoteHash: H1,
    assetId: 2,
    sourcePool: A,
    sourceToken: B,
    adapter: C,
    withdrawalExecutor: D,
    escrow: A,
    escrowAmountBaseUnits: "990000",
    executorFeeBaseUnits: "2000",
    protocolFeeBaseUnits: "5000",
    destinationChainId: 56,
    destinationToken: B,
    destinationRecipient: C,
    destinationAmountOutBaseUnits: "920000",
    relaySourceAmountBaseUnits: "980000",
    relayRouteCostBaseUnits: "60000",
    submissionReimbursementBaseUnits: "1000",
    deliverySuccessFeeBaseUnits: "1500",
    maximumOperatorFeeBaseUnits: "2500",
    primaryRefundToken: A,
    secondaryRefundToken: B,
    refundRecipientCommitment: H2,
    requestIdHash: H3,
    refundRouteBindingHash: H4,
    quoteExpiresAt: 2_000_000_000,
    preSubmissionRecoveryDelaySeconds: 1800,
    maximumCompletionDelaySeconds: 172800,
    totalNeededFromNoteBaseUnits: "997000",
    ...overrides
  }
}

test("V5 authorization has one stable field order and production domain", () => {
  const message = buildPayoutV5AuthorizationMessage({
    quote: quote(),
    authorization: { wallet: D, issuedAt: 1_900_000_000, nonce: "abcdefghijklmnopqrstuvwx" }
  })
  assert.equal(message.split("\n")[0], "Parly Cross-Chain Payout Authorization")
  assert.match(message, /^Parly Cross-Chain Payout Authorization\nDomain: parly\.fi\nAction: authorize-payout-v5/u)
  assert.match(message, /Refund Claimant Commitment: 0x2222/u)
  assert.match(message, /The delivery fee is earned only after objective destination proof/u)
  assert.equal(message.split("\n").length, 34)
})

test("V5 authorization rejects an operator fee above its signed maximum", () => {
  assert.throws(
    () => buildPayoutV5AuthorizationMessage({
      quote: quote({ maximumOperatorFeeBaseUnits: "2499" }),
      authorization: { wallet: D, issuedAt: 1_900_000_000, nonce: "abcdefghijklmnopqrstuvwx" }
    }),
    /operator fee exceeds the authorized maximum/u
  )
})

test("V5 refund material is deterministic and claimant-bound", () => {
  const refundSalt = derivePayoutV5RefundSalt({
    sourceNoteSecret: "123",
    sourceNoteNullifier: "456",
    refundWallet: D,
    escrowSalt: H1
  })
  assert.equal(refundSalt, derivePayoutV5RefundSalt({
    sourceNoteSecret: "123",
    sourceNoteNullifier: "456",
    refundWallet: D,
    escrowSalt: H1
  }))
  assert.notEqual(refundSalt, derivePayoutV5RefundSalt({
    sourceNoteSecret: "123",
    sourceNoteNullifier: "456",
    refundWallet: C,
    escrowSalt: H1
  }))
  assert.notEqual(
    derivePayoutV5RefundCommitment({ chainId: 4217, refundWallet: D, escrowSalt: H1, refundSalt }),
    derivePayoutV5RefundCommitment({ chainId: 4217, refundWallet: C, escrowSalt: H1, refundSalt })
  )
})
