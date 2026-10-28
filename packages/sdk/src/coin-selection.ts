export type PoolV3CoinSelectionNote = {
  commitment: `0x${string}`
  amount: bigint
  confirmedLeafIndex: number
  chainId: number
  poolAddress: `0x${string}`
  assetId: string
  state: "unspent" | "spent"
  pendingLock?: boolean
}

export type PoolV3NoteSummary = Pick<
  PoolV3CoinSelectionNote,
  "commitment" | "amount" | "confirmedLeafIndex"
>

export type PoolV3ConsolidationInput =
  | PoolV3NoteSummary
  | { plannedRound: number; amount: bigint }

export type PoolV3ConsolidationRound = {
  round: number
  inputs: PoolV3ConsolidationInput[]
  inputTotal: bigint
  executorFee: bigint
  expectedChange: bigint
  cancellation: {
    beforeSubmission: true
    whilePending: false
    afterConfirmation: true
  }
}

export type PoolV3SpendPlan =
  | {
      kind: "ready"
      selected: PoolV3NoteSummary[]
      inputTotal: bigint
      required: bigint
      change: bigint
    }
  | {
      kind: "consolidation_required"
      rounds: PoolV3ConsolidationRound[]
      projectedSelection: PoolV3ConsolidationInput[]
      projectedInputTotal: bigint
      required: bigint
      projectedChange: bigint
      requiresReplanAfterEachConfirmation: true
    }
  | {
      kind: "insufficient_balance"
      available: bigint
      required: bigint
    }
  | {
      kind: "invalid_approved_commitments"
      commitments: `0x${string}`[]
    }

export type PlanPoolV3SpendInput = {
  notes: readonly PoolV3CoinSelectionNote[]
  chainId: number
  poolAddress: `0x${string}`
  assetId: string
  requestedAmount: bigint
  finalFees: bigint
  approvedCommitments?: readonly `0x${string}`[]
  consolidationFee: (quote: {
    round: number
    inputTotal: bigint
    inputCount: 4
  }) => bigint
}

export type PoolV3PrivateBalanceSummary = {
  poolVersion: 3
  assetDecimals: 6
  totalPrivateBalanceBaseUnits: string
  immediatelySpendableBaseUnits: string
  noteCount: number
  consolidationRequired: boolean
  historyCompatibility: {
    poolV2: "read_only"
  }
}

export type PoolV3PublicSpendPlan =
  | {
      kind: "ready"
      poolVersion: 3
      selectionMode: "automatic_deterministic"
      requestedAmountBaseUnits: string
      finalFeesBaseUnits: string
      requiredBaseUnits: string
      selectedInputCount: number
      inputTotalBaseUnits: string
      changeBaseUnits: string
      balance: PoolV3PrivateBalanceSummary
    }
  | {
      kind: "consolidation_required"
      poolVersion: 3
      selectionMode: "automatic_deterministic"
      requestedAmountBaseUnits: string
      finalFeesBaseUnits: string
      requiredBaseUnits: string
      consolidationRoundCount: number
      projectedInputCount: number
      projectedInputTotalBaseUnits: string
      projectedChangeBaseUnits: string
      requiresReplanAfterEachConfirmation: true
      balance: PoolV3PrivateBalanceSummary
    }
  | {
      kind: "insufficient_balance"
      poolVersion: 3
      selectionMode: "automatic_deterministic"
      requestedAmountBaseUnits: string
      finalFeesBaseUnits: string
      availableBaseUnits: string
      requiredBaseUnits: string
      balance: PoolV3PrivateBalanceSummary
    }
  | {
      kind: "invalid_approved_notes"
      poolVersion: 3
      selectionMode: "automatic_deterministic"
      invalidNoteCount: number
      balance: PoolV3PrivateBalanceSummary
    }

export type PreparePoolV3PrivateSendInput = PlanPoolV3SpendInput

type Candidate = PoolV3ConsolidationInput & {
  tieLeaf: number
  tieCommitment: string
}

const CANCELLATION = {
  beforeSubmission: true,
  whilePending: false,
  afterConfirmation: true
} as const

function compareCommitment(left: string, right: string): number {
  return left.toLowerCase().localeCompare(right.toLowerCase())
}

function compareOldest(left: Candidate, right: Candidate): number {
  return left.tieLeaf - right.tieLeaf || compareCommitment(left.tieCommitment, right.tieCommitment)
}

function compareSmallest(left: Candidate, right: Candidate): number {
  if (left.amount !== right.amount) return left.amount < right.amount ? -1 : 1
  return compareOldest(left, right)
}

function compareSubsets(left: Candidate[], right: Candidate[]): number {
  const leftTotal = sum(left)
  const rightTotal = sum(right)
  if (leftTotal !== rightTotal) return leftTotal < rightTotal ? -1 : 1

  const leftOrdered = [...left].sort(compareOldest)
  const rightOrdered = [...right].sort(compareOldest)
  for (let index = 0; index < leftOrdered.length; index += 1) {
    const comparison = compareOldest(leftOrdered[index], rightOrdered[index])
    if (comparison !== 0) return comparison
  }
  return 0
}

function sum(notes: readonly Pick<Candidate, "amount">[]): bigint {
  return notes.reduce((total, note) => total + note.amount, 0n)
}

function select(notes: Candidate[], required: bigint): Candidate[] | null {
  const single = notes
    .filter((note) => note.amount >= required)
    .sort(compareSmallest)[0]
  if (single) return [single]

  type Pair = { left: number; right: number; total: bigint }
  const pairs: Pair[] = []
  for (let left = 0; left < notes.length; left += 1) {
    for (let right = left + 1; right < notes.length; right += 1) {
      pairs.push({ left, right, total: notes[left].amount + notes[right].amount })
    }
  }
  pairs.sort(
    (left, right) =>
      (left.total < right.total ? -1 : left.total > right.total ? 1 : 0) ||
      compareSubsets(
        [notes[left.left], notes[left.right]],
        [notes[right.left], notes[right.right]]
      )
  )

  const lowerBound = (minimum: bigint): number => {
    let low = 0
    let high = pairs.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (pairs[middle].total < minimum) low = middle + 1
      else high = middle
    }
    return low
  }
  const best = (current: Candidate[] | null, next: Candidate[]): Candidate[] =>
    current === null || compareSubsets(next, current) < 0 ? next : current

  const pairIndex = lowerBound(required)
  if (pairIndex < pairs.length) {
    const pair = pairs[pairIndex]
    return [notes[pair.left], notes[pair.right]]
  }

  let selectedThree: Candidate[] | null = null
  for (let singleIndex = 0; singleIndex < notes.length; singleIndex += 1) {
    for (
      let pairIndex = lowerBound(required - notes[singleIndex].amount);
      pairIndex < pairs.length;
      pairIndex += 1
    ) {
      const pair = pairs[pairIndex]
      if (pair.left === singleIndex || pair.right === singleIndex) continue
      const candidate = [notes[singleIndex], notes[pair.left], notes[pair.right]]
      selectedThree = best(selectedThree, candidate)
      break
    }
  }
  if (selectedThree) return selectedThree

  let selectedFour: Candidate[] | null = null
  for (const first of pairs) {
    for (
      let pairIndex = lowerBound(required - first.total);
      pairIndex < pairs.length;
      pairIndex += 1
    ) {
      const second = pairs[pairIndex]
      if (
        first.left === second.left ||
        first.left === second.right ||
        first.right === second.left ||
        first.right === second.right
      ) {
        continue
      }
      const candidate = [
        notes[first.left],
        notes[first.right],
        notes[second.left],
        notes[second.right]
      ]
      selectedFour = best(selectedFour, candidate)
      break
    }
  }
  return selectedFour
}

function publicInput(note: Candidate): PoolV3ConsolidationInput {
  if ("commitment" in note) {
    return {
      commitment: note.commitment,
      amount: note.amount,
      confirmedLeafIndex: note.confirmedLeafIndex
    }
  }
  return { plannedRound: note.plannedRound, amount: note.amount }
}

function validateInput(input: PlanPoolV3SpendInput): void {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new Error("chainId must be a positive safe integer.")
  }
  if (input.requestedAmount <= 0n) throw new Error("requestedAmount must be positive.")
  if (input.finalFees < 0n) throw new Error("finalFees cannot be negative.")

  const commitments = new Set<string>()
  for (const note of input.notes) {
    if (note.amount <= 0n) throw new Error("Note amounts must be positive.")
    if (!Number.isSafeInteger(note.confirmedLeafIndex) || note.confirmedLeafIndex < 0) {
      throw new Error("confirmedLeafIndex must be a non-negative safe integer.")
    }
    if (!/^0x[0-9a-f]{64}$/iu.test(note.commitment)) {
      throw new Error("Note commitment must be 32-byte hex.")
    }
    const commitment = note.commitment.toLowerCase()
    if (commitments.has(commitment)) throw new Error("Duplicate note commitment.")
    commitments.add(commitment)
  }
}

function eligiblePoolV3Notes(
  notes: readonly PoolV3CoinSelectionNote[],
  scope: Pick<PlanPoolV3SpendInput, "chainId" | "poolAddress" | "assetId">
): PoolV3CoinSelectionNote[] {
  return notes.filter(
    (note) =>
      note.chainId === scope.chainId &&
      note.poolAddress.toLowerCase() === scope.poolAddress.toLowerCase() &&
      note.assetId === scope.assetId &&
      note.state === "unspent" &&
      note.pendingLock !== true
  )
}

export function summarizePoolV3PrivateBalance(
  input: Pick<PlanPoolV3SpendInput, "notes" | "chainId" | "poolAddress" | "assetId">
): PoolV3PrivateBalanceSummary {
  const eligible = eligiblePoolV3Notes(input.notes, input)
  const totalPrivateBalance = eligible.reduce((total, note) => total + note.amount, 0n)
  const immediatelySpendable = [...eligible]
    .sort((left, right) => (left.amount === right.amount ? 0 : left.amount > right.amount ? -1 : 1))
    .slice(0, 4)
    .reduce((total, note) => total + note.amount, 0n)

  return {
    poolVersion: 3,
    assetDecimals: 6,
    totalPrivateBalanceBaseUnits: totalPrivateBalance.toString(),
    immediatelySpendableBaseUnits: immediatelySpendable.toString(),
    noteCount: eligible.length,
    consolidationRequired: eligible.length > 4,
    historyCompatibility: {
      poolV2: "read_only"
    }
  }
}

export function planPoolV3Spend(input: PlanPoolV3SpendInput): PoolV3SpendPlan {
  validateInput(input)
  const required = input.requestedAmount + input.finalFees
  const eligible = eligiblePoolV3Notes(input.notes, input)

  const eligibleByCommitment = new Map(
    eligible.map((note) => [note.commitment.toLowerCase(), note] as const)
  )
  const approved = input.approvedCommitments
    ? [...new Set(input.approvedCommitments.map((commitment) => commitment.toLowerCase()))]
    : null
  if (approved) {
    const invalid = approved.filter((commitment) => !eligibleByCommitment.has(commitment))
    if (invalid.length > 0) {
      return {
        kind: "invalid_approved_commitments",
        commitments: invalid.sort(compareCommitment) as `0x${string}`[]
      }
    }
  }

  const candidates: Candidate[] = (approved
    ? approved.map((commitment) => eligibleByCommitment.get(commitment)!)
    : eligible
  ).map((note) => ({
    commitment: note.commitment,
    amount: note.amount,
    confirmedLeafIndex: note.confirmedLeafIndex,
    tieLeaf: note.confirmedLeafIndex,
    tieCommitment: note.commitment
  }))
  const available = sum(candidates)
  if (available < required) return { kind: "insufficient_balance", available, required }

  const selected = select(candidates, required)
  if (selected) {
    const inputTotal = sum(selected)
    return {
      kind: "ready",
      selected: selected
        .map(publicInput)
        .filter((note): note is PoolV3NoteSummary => "commitment" in note)
        .sort((left, right) => compareCommitment(left.commitment, right.commitment)),
      inputTotal,
      required,
      change: inputTotal - required
    }
  }

  const simulated = [...candidates]
  const rounds: PoolV3ConsolidationRound[] = []
  let cumulativeFees = 0n
  while (simulated.length > 4) {
    const inputs = [...simulated].sort(compareSmallest).slice(0, 4)
    const inputTotal = sum(inputs)
    const round = rounds.length + 1
    const executorFee = input.consolidationFee({ round, inputTotal, inputCount: 4 })
    if (executorFee < 0n) throw new Error("consolidationFee cannot be negative.")
    cumulativeFees += executorFee
    if (executorFee >= inputTotal) {
      return {
        kind: "insufficient_balance",
        available,
        required: required + cumulativeFees
      }
    }

    const expectedChange = inputTotal - executorFee
    rounds.push({
      round,
      inputs: inputs.map(publicInput),
      inputTotal,
      executorFee,
      expectedChange,
      cancellation: CANCELLATION
    })
    for (const selectedInput of inputs) simulated.splice(simulated.indexOf(selectedInput), 1)
    simulated.push({
      plannedRound: round,
      amount: expectedChange,
      tieLeaf: Number.MAX_SAFE_INTEGER - 1_000 + round,
      tieCommitment: `planned:${round.toString().padStart(6, "0")}`
    })

    const projectedSelection = select(simulated, required)
    if (projectedSelection) {
      const projectedInputTotal = sum(projectedSelection)
      return {
        kind: "consolidation_required",
        rounds,
        projectedSelection: projectedSelection
          .sort((left, right) => compareCommitment(left.tieCommitment, right.tieCommitment))
          .map(publicInput),
        projectedInputTotal,
        required,
        projectedChange: projectedInputTotal - required,
        requiresReplanAfterEachConfirmation: true
      }
    }
  }

  return {
    kind: "insufficient_balance",
    available,
    required: required + cumulativeFees
  }
}

export function preparePoolV3PrivateSend(
  input: PreparePoolV3PrivateSendInput
): PoolV3PublicSpendPlan {
  const balance = summarizePoolV3PrivateBalance({
    notes: input.notes,
    chainId: input.chainId,
    poolAddress: input.poolAddress,
    assetId: input.assetId
  })
  const plan = planPoolV3Spend(input)
  const common = {
    poolVersion: 3 as const,
    selectionMode: "automatic_deterministic" as const,
    requestedAmountBaseUnits: input.requestedAmount.toString(),
    finalFeesBaseUnits: input.finalFees.toString(),
    balance
  }

  if (plan.kind === "ready") {
    return {
      ...common,
      kind: "ready",
      requiredBaseUnits: plan.required.toString(),
      selectedInputCount: plan.selected.length,
      inputTotalBaseUnits: plan.inputTotal.toString(),
      changeBaseUnits: plan.change.toString()
    }
  }

  if (plan.kind === "consolidation_required") {
    return {
      ...common,
      kind: "consolidation_required",
      requiredBaseUnits: plan.required.toString(),
      consolidationRoundCount: plan.rounds.length,
      projectedInputCount: plan.projectedSelection.length,
      projectedInputTotalBaseUnits: plan.projectedInputTotal.toString(),
      projectedChangeBaseUnits: plan.projectedChange.toString(),
      requiresReplanAfterEachConfirmation: true
    }
  }

  if (plan.kind === "insufficient_balance") {
    return {
      ...common,
      kind: "insufficient_balance",
      availableBaseUnits: plan.available.toString(),
      requiredBaseUnits: plan.required.toString()
    }
  }

  return {
    ...common,
    kind: "invalid_approved_notes",
    invalidNoteCount: plan.commitments.length
  }
}
