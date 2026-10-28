import assert from "node:assert/strict"
import test from "node:test"

import {
  calcFinalCommitment,
  calcPoolV3InnerCommitment,
  calcPoolV3NoteDomain,
  calcPoolV3NullifierHash,
  parseNoteEnvelopePayload,
  reconstructEnvelopeNote
} from "../src/note-crypto.ts"

const common = {
  amount: "1000000",
  secret: "1",
  nullifier: "2",
  depositor: "3",
  ownerRecoveryPubKeyB64: "public-key",
  createdAt: 1
}

test("accepts versioned PoolV2 and PoolV3 envelopes without reinterpretation", () => {
  assert.equal(
    parseNoteEnvelopePayload({ ...common, version: 1, kind: "deposit", assetId: 1 }).version,
    1
  )
  assert.equal(
    parseNoteEnvelopePayload({
      ...common,
      version: 2,
      poolVersion: 3,
      poolAddress: "0x1111111111111111111111111111111111111111",
      chainId: 4217,
      assetId: "1",
      commitment: `0x${"11".repeat(32)}`,
      kind: "privacy_link"
    }).version,
    2
  )
})

test("rejects unknown versions and cross-pool metadata drift", () => {
  assert.throws(() => parseNoteEnvelopePayload({ ...common, version: 9 }), /Unsupported/)
  assert.throws(
    () =>
      parseNoteEnvelopePayload({
        ...common,
        version: 2,
        poolVersion: 2,
        poolAddress: "0x1111111111111111111111111111111111111111",
        chainId: 4217,
        assetId: "1",
        commitment: `0x${"11".repeat(32)}`,
        kind: "deposit"
      }),
    /Invalid PoolV3/
  )
})

test("matches the PoolV3 circuit note domain, commitment, and nullifier vector", async () => {
  const poolAddress = "0x1970996e79051e691e68d76ad8f259ab9c94921b"
  const secret = "10000"
  const nullifier = "20000"
  const depositor = BigInt("0x1111111111111111111111111111111111111111").toString()
  const noteDomain = await calcPoolV3NoteDomain(poolAddress, 1)
  const innerCommitment = await calcPoolV3InnerCommitment(
    secret,
    nullifier,
    depositor,
    1,
    poolAddress
  )
  const commitment = await calcFinalCommitment(innerCommitment, "20000")
  const nullifierHash = await calcPoolV3NullifierHash(secret, nullifier, 1, poolAddress)

  assert.equal(
    noteDomain,
    "1538035884618822181028805577966228337566184207012222760019336167741982546135"
  )
  assert.equal(
    commitment,
    "0x2d18fb62c97f3a88f30b9d584067207760a7b0e2b643fc852474a82e8ae17286"
  )
  assert.equal(
    nullifierHash,
    "0x2a7bc6cf03d6744ff5d24d9d84b8db7a8b81411aaa49e069da2237c4c577d502"
  )
  assert.notEqual(
    noteDomain,
    await calcPoolV3NoteDomain("0x1111111111111111111111111111111111111111", 1)
  )

  const reconstructed = await reconstructEnvelopeNote({
    ...common,
    version: 2,
    poolVersion: 3,
    poolAddress,
    chainId: 4217,
    assetId: "1",
    secret,
    nullifier,
    depositor,
    amount: "20000",
    commitment,
    kind: "deposit"
  })
  assert.deepEqual(reconstructed, { commitment, nullifierHash })
})
