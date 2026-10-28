import assert from "node:assert/strict"
import test from "node:test"

import {
  allocatePayoutV6SourceFee,
  buildPayoutV6AuthorizationMessage,
  derivePayoutV6RefundCommitment,
  derivePayoutV6RefundSalt,
  derivePayoutV6SourceFingerprint
} from "../dist/payout-v6.js"

const A = "0x1111111111111111111111111111111111111111"
const B = "0x2222222222222222222222222222222222222222"
const C = "0x3333333333333333333333333333333333333333"
const D = "0x4444444444444444444444444444444444444444"
const H1 = `0x${"11".repeat(32)}`
const H2 = `0x${"22".repeat(32)}`
const H3 = `0x${"33".repeat(32)}`
const H4 = `0x${"44".repeat(32)}`

function child(index, overrides = {}) {
  return {
    intentHash: `0x${String(index).padStart(64, "0")}`,
    escrow: A,
    escrowAmountBaseUnits: "990000",
    sourceExecutorFeeAllocationBaseUnits: "100",
    destinationChainId: 56,
    destinationToken: B,
    destinationRecipient: C,
    destinationAmountOutBaseUnits: "920000",
    relaySourceAmountBaseUnits: "980000",
    relayRouteCostBaseUnits: "60000",
    submissionReimbursementBaseUnits: "1000",
    deliverySuccessFeeBaseUnits: "1500",
    refundRecipientCommitment: H2,
    requestIdHash: H3,
    refundRouteBindingHash: H4,
    ...overrides
  }
}

function manifest(overrides = {}) {
  return {
    version: 6,
    manifestHash: H1,
    clientAuthorizationId: H2,
    adapter: A,
    withdrawalExecutor: B,
    sourcePool: C,
    sourceToken: D,
    assetId: 2,
    inputCount: 2,
    sourceCallHash: H3,
    sealedExecutionPayloadHash: H4,
    selectedRelayer: D,
    relayerPublicKeyHash: H1,
    protocolFeeBaseUnits: "5000",
    sourceExecutorFeeBaseUnits: "200",
    totalDestinationAmountBaseUnits: "1840000",
    totalEscrowAmountBaseUnits: "1980000",
    maximumTotalNoteDeductionBaseUnits: "1985200",
    quoteExpiresAt: 2_000_000_000,
    preSubmissionRecoveryDelaySeconds: 600,
    children: [child(1), child(2)],
    ...overrides
  }
}

test("V6 authorization binds one exact ordered manifest without note witnesses", () => {
  const message = buildPayoutV6AuthorizationMessage({
    manifest: manifest(),
    authorization: { wallet: D, issuedAt: 1_900_000_000, nonce: "abcdefghijklmnopqrstuvwx" }
  })

  assert.match(message, /^Parly Cross-Chain Payout V6 Authorization\nDomain: parly\.fi/u)
  assert.match(message, /Ordered Child 1: 0x0{63}1/u)
  assert.match(message, /Ordered Child 2: 0x0{63}2/u)
  assert.doesNotMatch(message, /nullifier|note secret|witness/iu)
  assert.notEqual(
    message,
    buildPayoutV6AuthorizationMessage({
      manifest: manifest({ children: [child(2), child(1)] }),
      authorization: { wallet: D, issuedAt: 1_900_000_000, nonce: "abcdefghijklmnopqrstuvwx" }
    })
  )
})

test("V6 manifest validation rejects invalid input counts, recovery delays, and fee totals", () => {
  const authorization = { wallet: D, issuedAt: 1_900_000_000, nonce: "abcdefghijklmnopqrstuvwx" }
  assert.throws(
    () => buildPayoutV6AuthorizationMessage({ manifest: manifest({ inputCount: 5 }), authorization }),
    /input count/u
  )
  assert.throws(
    () => buildPayoutV6AuthorizationMessage({
      manifest: manifest({ preSubmissionRecoveryDelaySeconds: 299 }),
      authorization
    }),
    /recovery delay/u
  )
  assert.throws(
    () => buildPayoutV6AuthorizationMessage({
      manifest: manifest({ sourceExecutorFeeBaseUnits: "201" }),
      authorization
    }),
    /source executor fee/u
  )
})

test("V6 refund material is ordered-note, adapter, authorization, and claimant bound", () => {
  const notes = [
    { secret: "123", nullifier: "456" },
    { secret: "789", nullifier: "101112" }
  ]
  const sourceFingerprint = derivePayoutV6SourceFingerprint(notes)
  const refundSalt = derivePayoutV6RefundSalt({
    chainId: 4217,
    adapter: A,
    escrowSalt: H1,
    clientAuthorizationId: H2,
    sourceNotes: notes
  })
  assert.notEqual(sourceFingerprint, derivePayoutV6SourceFingerprint([...notes].reverse()))
  assert.notEqual(refundSalt, derivePayoutV6RefundSalt({
    chainId: 4217,
    adapter: A,
    escrowSalt: H1,
    clientAuthorizationId: H2,
    sourceNotes: [...notes].reverse()
  }))
  assert.notEqual(
    derivePayoutV6RefundCommitment({ chainId: 4217, refundWallet: D, escrowSalt: H1, refundSalt }),
    derivePayoutV6RefundCommitment({ chainId: 4217, refundWallet: C, escrowSalt: H1, refundSalt })
  )
})

test("V6 source fee allocation is deterministic and respects every child cap", () => {
  const allocations = allocatePayoutV6SourceFee({
    sourceFee: 500n,
    children: [
      { escrowAmount: 1_000_000n, submissionReimbursement: 100n, deliverySuccessFee: 200n },
      { escrowAmount: 2_000_000n, submissionReimbursement: 200n, deliverySuccessFee: 400n }
    ]
  })
  assert.deepEqual(allocations, [167n, 333n])
  assert.equal(allocations.reduce((sum, value) => sum + value, 0n), 500n)
})
