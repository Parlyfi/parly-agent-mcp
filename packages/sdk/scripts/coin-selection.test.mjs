import assert from "node:assert/strict"
import test from "node:test"

import {
  planPoolV3Spend,
  preparePoolV3PrivateSend,
  summarizePoolV3PrivateBalance
} from "../src/coin-selection.ts"

const POOL = "0x1111111111111111111111111111111111111111"

function note(id, amount, leafIndex = id) {
  return {
    commitment: `0x${id.toString(16).padStart(64, "0")}`,
    amount: BigInt(amount),
    confirmedLeafIndex: leafIndex,
    chainId: 4217,
    poolAddress: POOL,
    assetId: "USDC.e",
    state: "unspent"
  }
}

function plan(notes, overrides = {}) {
  return planPoolV3Spend({
    notes,
    chainId: 4217,
    poolAddress: POOL,
    assetId: "USDC.e",
    requestedAmount: 10n,
    finalFees: 0n,
    consolidationFee: () => 0n,
    ...overrides
  })
}

test("selects the smallest sufficient single note before combining notes", () => {
  const result = plan([note(1, 30), note(2, 10), note(3, 20)])
  assert.equal(result.kind, "ready")
  assert.deepEqual(result.selected.map((item) => item.commitment), [note(2, 10).commitment])
  assert.equal(result.change, 0n)
})

test("uses minimum cardinality, then minimum change, then oldest leaf and commitment", () => {
  const result = plan(
    [note(9, 6, 9), note(8, 6, 8), note(7, 4, 7), note(6, 4, 6), note(5, 3, 5)],
    { requestedAmount: 10n }
  )
  assert.equal(result.kind, "ready")
  assert.deepEqual(
    result.selected.map((item) => item.commitment),
    [note(6, 4).commitment, note(8, 6).commitment]
  )
})

test("selects deterministic three-note and four-note subsets regardless of input order", () => {
  const notes = [note(1, 4), note(2, 3), note(3, 2), note(4, 1)]
  const three = plan(notes, { requestedAmount: 8n })
  assert.equal(three.kind, "ready")
  assert.equal(three.selected.length, 3)

  const four = plan([...notes].reverse(), { requestedAmount: 10n })
  assert.equal(four.kind, "ready")
  assert.equal(four.selected.length, 4)
  assert.deepEqual(
    four.selected.map((item) => item.commitment),
    notes.map((item) => item.commitment)
  )
})

test("selects an exact four-note subset from a fragmented wallet without exhaustive combinations", () => {
  const notes = Array.from({ length: 64 }, (_, index) => note(index + 1, 1))
  const result = plan([...notes].reverse(), { requestedAmount: 4n })
  assert.equal(result.kind, "ready")
  assert.deepEqual(
    result.selected.map((item) => item.commitment),
    notes.slice(0, 4).map((item) => item.commitment)
  )
})

test("filters wrong routes, spent notes, and pending locks", () => {
  const wrongPool = { ...note(1, 50), poolAddress: "0x2222222222222222222222222222222222222222" }
  const spent = { ...note(2, 50), state: "spent" }
  const locked = { ...note(3, 50), pendingLock: true }
  const result = plan([wrongPool, spent, locked, note(4, 10)])
  assert.equal(result.kind, "ready")
  assert.deepEqual(result.selected.map((item) => item.commitment), [note(4, 10).commitment])
})

test("advanced commitments restrict selection and reject stale approvals", () => {
  const notes = [note(1, 6), note(2, 4), note(3, 20)]
  const restricted = plan(notes, {
    approvedCommitments: [note(1, 6).commitment, note(2, 4).commitment]
  })
  assert.equal(restricted.kind, "ready")
  assert.deepEqual(
    restricted.selected.map((item) => item.commitment),
    [note(1, 6).commitment, note(2, 4).commitment]
  )

  const stale = plan(notes, { approvedCommitments: [`0x${"ff".repeat(32)}`] })
  assert.equal(stale.kind, "invalid_approved_commitments")
  assert.equal(stale.commitments.length, 1)
})

test("returns insufficient balance when principal and final fees cannot be covered", () => {
  const result = plan([note(1, 5), note(2, 4)], { requestedAmount: 8n, finalFees: 2n })
  assert.equal(result.kind, "insufficient_balance")
  assert.equal(result.available, 9n)
  assert.equal(result.required, 10n)
})

test("plans fee-aware four-to-one rounds and exposes only safe cancellation boundaries", () => {
  const notes = [1, 2, 3, 4, 5, 6, 7].map((amount, index) => note(index + 1, amount))
  const result = plan(notes, {
    requestedAmount: 24n,
    consolidationFee: ({ round }) => (round === 1 ? 1n : 2n)
  })

  assert.equal(result.kind, "consolidation_required")
  assert.equal(result.rounds.length, 1)
  assert.deepEqual(result.rounds[0].inputs.map((item) => item.amount), [1n, 2n, 3n, 4n])
  assert.equal(result.rounds[0].executorFee, 1n)
  assert.equal(result.rounds[0].expectedChange, 9n)
  assert.deepEqual(result.rounds[0].cancellation, {
    beforeSubmission: true,
    whilePending: false,
    afterConfirmation: true
  })
  assert.equal(result.requiresReplanAfterEachConfirmation, true)
  assert.equal("secret" in result.rounds[0].inputs[0], false)
  assert.equal("nullifier" in result.rounds[0].inputs[0], false)
})

test("charges every consolidation round and fails when fees consume the workflow", () => {
  const notes = Array.from({ length: 10 }, (_, index) => note(index + 1, 2))
  const result = plan(notes, {
    requestedAmount: 15n,
    consolidationFee: () => 3n
  })
  assert.equal(result.kind, "insufficient_balance")
  assert.equal(result.available, 20n)
  assert.equal(result.required, 21n)
})

test("projects multiple four-to-one rounds but requires confirmation-time replanning", () => {
  const notes = Array.from({ length: 10 }, (_, index) => note(index + 1, 2))
  const result = plan(notes, {
    requestedAmount: 15n,
    consolidationFee: () => 1n
  })
  assert.equal(result.kind, "consolidation_required")
  assert.equal(result.rounds.length, 2)
  assert.equal(result.rounds[1].inputs.some((item) => "plannedRound" in item), false)
  assert.equal(result.requiresReplanAfterEachConfirmation, true)
  assert.equal(result.projectedInputTotal, 16n)
})

test("summarizes the total PoolV3 balance while keeping PoolV2 history read-only", () => {
  const notes = [1, 2, 3, 4, 5].map((amount, index) => note(index + 1, amount))
  const summary = summarizePoolV3PrivateBalance({
    notes,
    chainId: 4217,
    poolAddress: POOL,
    assetId: "USDC.e"
  })

  assert.deepEqual(summary, {
    poolVersion: 3,
    assetDecimals: 6,
    totalPrivateBalanceBaseUnits: "15",
    immediatelySpendableBaseUnits: "14",
    noteCount: 5,
    consolidationRequired: true,
    historyCompatibility: {
      poolV2: "read_only"
    }
  })
})

test("returns a deterministic public plan without note or recovery material", () => {
  const notes = [note(1, 6), note(2, 4), note(3, 20)]
  const input = {
    notes,
    chainId: 4217,
    poolAddress: POOL,
    assetId: "USDC.e",
    requestedAmount: 10n,
    finalFees: 0n,
    consolidationFee: () => 0n
  }
  const first = preparePoolV3PrivateSend(input)
  const second = preparePoolV3PrivateSend({ ...input, notes: [...notes].reverse() })

  assert.deepEqual(first, second)
  assert.equal(first.kind, "ready")
  assert.equal(first.selectedInputCount, 1)
  const publicJson = JSON.stringify(first)
  for (const forbidden of [
    "commitment",
    "nullifier",
    "merklePath",
    "secret",
    "recoveryPublicKey",
    "privateKey"
  ]) {
    assert.equal(publicJson.includes(forbidden), false)
  }
})

test("redacts invalid advanced note identifiers from the public plan", () => {
  const result = preparePoolV3PrivateSend({
    notes: [note(1, 10)],
    chainId: 4217,
    poolAddress: POOL,
    assetId: "USDC.e",
    requestedAmount: 10n,
    finalFees: 0n,
    approvedCommitments: [`0x${"ff".repeat(32)}`],
    consolidationFee: () => 0n
  })

  assert.equal(result.kind, "invalid_approved_notes")
  assert.equal(result.invalidNoteCount, 1)
  assert.doesNotMatch(JSON.stringify(result), /ff{10}/u)
})
