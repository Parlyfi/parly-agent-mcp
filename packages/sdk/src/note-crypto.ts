import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const sodium = require("libsodium-wrappers-sumo") as {
  ready: Promise<void>
  base64_variants: { ORIGINAL: string }
  randombytes_buf(length: number): Uint8Array
  from_base64(value: string, variant: string): Uint8Array
  from_string(value: string): Uint8Array
  to_string(value: Uint8Array): string
  crypto_box_seal(message: Uint8Array, recipientPub: Uint8Array): Uint8Array
  crypto_box_seal_open(
    ciphertext: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array
  ): Uint8Array | null
}
const { buildPoseidon } = require("circomlibjs") as {
  buildPoseidon(): Promise<any>
}
let poseidonPromise: ReturnType<typeof buildPoseidon> | null = null

export type NoteEnvelopeV1 = {
  version: 1
  kind: "deposit" | "change"
  assetId: 1 | 2
  amount: string
  secret: string
  nullifier: string
  depositor: string
  ownerRecoveryPubKeyB64: string
  createdAt: number
}

export type NoteEnvelopeV2 = {
  version: 2
  poolVersion: 3
  poolAddress: `0x${string}`
  chainId: 4217
  assetId: "1" | "2"
  amount: string
  secret: string
  nullifier: string
  depositor: string
  ownerRecoveryPubKeyB64: string
  commitment: `0x${string}`
  kind: "deposit" | "change" | "privacy_link" | "consolidation"
  createdAt: number
}

export type NoteEnvelopePayload = NoteEnvelopeV1 | NoteEnvelopeV2

export type LiveNote = NoteEnvelopePayload & {
  commitment: `0x${string}`
  nullifierHash: `0x${string}`
  status: "live" | "spent"
}

function hexToBytes(hex: `0x${string}`): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex length")
  }
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("Invalid hex value")
  }

  const out = new Uint8Array(clean.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    const byte = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16)
    if (Number.isNaN(byte)) {
      throw new Error("Invalid hex byte")
    }
    out[index] = byte
  }

  return out
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`
}

async function randomFieldElement(): Promise<string> {
  await sodium.ready
  const bytes = sodium.randombytes_buf(31) as Uint8Array
  const hex = Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
  return BigInt(`0x${hex}`).toString()
}

function loadPoseidon() {
  poseidonPromise ??= buildPoseidon()
  return poseidonPromise
}

export async function calcInnerCommitment(
  secret: string,
  nullifier: string,
  depositor: string,
  assetId: 1 | 2
): Promise<string> {
  const poseidon = await loadPoseidon()
  const out = poseidon([
    BigInt(secret),
    BigInt(nullifier),
    BigInt(depositor),
    BigInt(assetId)
  ])
  return BigInt(poseidon.F.toString(out)).toString()
}

export async function calcPoolV3NoteDomain(
  poolAddress: `0x${string}`,
  assetId: 1 | 2
): Promise<string> {
  if (!/^0x[0-9a-f]{40}$/iu.test(poolAddress)) throw new Error("Invalid PoolV3 address")
  const poseidon = await loadPoseidon()
  const out = poseidon([4217n, BigInt(poolAddress), BigInt(assetId), 3n])
  return BigInt(poseidon.F.toString(out)).toString()
}

export async function calcPoolV3InnerCommitment(
  secret: string,
  nullifier: string,
  depositor: string,
  assetId: 1 | 2,
  poolAddress: `0x${string}`
): Promise<string> {
  const poseidon = await loadPoseidon()
  const noteDomain = await calcPoolV3NoteDomain(poolAddress, assetId)
  const out = poseidon([
    BigInt(secret),
    BigInt(nullifier),
    BigInt(depositor),
    BigInt(noteDomain)
  ])
  return BigInt(poseidon.F.toString(out)).toString()
}

export async function calcFinalCommitment(
  innerCommitment: string,
  amount: string
): Promise<`0x${string}`> {
  const poseidon = await loadPoseidon()
  const out = poseidon([BigInt(innerCommitment), BigInt(amount)])
  return `0x${BigInt(poseidon.F.toString(out)).toString(16).padStart(64, "0")}` as `0x${string}`
}

export async function calcNullifierHash(
  secret: string,
  nullifier: string
): Promise<`0x${string}`> {
  const poseidon = await loadPoseidon()
  const out = poseidon([BigInt(secret), BigInt(nullifier)])
  return `0x${BigInt(poseidon.F.toString(out)).toString(16).padStart(64, "0")}` as `0x${string}`
}

export async function calcPoolV3NullifierHash(
  secret: string,
  nullifier: string,
  assetId: 1 | 2,
  poolAddress: `0x${string}`
): Promise<`0x${string}`> {
  const poseidon = await loadPoseidon()
  const noteDomain = await calcPoolV3NoteDomain(poolAddress, assetId)
  const out = poseidon([BigInt(secret), BigInt(nullifier), BigInt(noteDomain)])
  return `0x${BigInt(poseidon.F.toString(out)).toString(16).padStart(64, "0")}` as `0x${string}`
}

export async function createSealedNoteEnvelope(
  recipientRecoveryPubKeyB64: string,
  payload: NoteEnvelopePayload
): Promise<`0x${string}`> {
  await sodium.ready
  const recipientPub = sodium.from_base64(
    recipientRecoveryPubKeyB64,
    sodium.base64_variants.ORIGINAL
  )
  const message = sodium.from_string(JSON.stringify(payload))
  const sealed = sodium.crypto_box_seal(message, recipientPub)
  return bytesToHex(sealed)
}

export async function createSealedRecoveryEnvelope<T>(
  recipientRecoveryPubKeyB64: string,
  payload: T
): Promise<`0x${string}`> {
  await sodium.ready
  const recipientPub = sodium.from_base64(
    recipientRecoveryPubKeyB64,
    sodium.base64_variants.ORIGINAL
  )
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(JSON.stringify(payload)),
    recipientPub
  )
  return bytesToHex(sealed)
}

export async function openSealedRecoveryEnvelope<T>(
  recipientPublicKeyB64: string,
  recipientPrivateKeyB64: string,
  envelope: `0x${string}`
): Promise<T> {
  await sodium.ready
  const publicKey = sodium.from_base64(recipientPublicKeyB64, sodium.base64_variants.ORIGINAL)
  const privateKey = sodium.from_base64(recipientPrivateKeyB64, sodium.base64_variants.ORIGINAL)
  const opened = sodium.crypto_box_seal_open(hexToBytes(envelope), publicKey, privateKey)
  if (!opened) throw new Error("Recovery envelope decryption failed")
  return JSON.parse(sodium.to_string(opened)) as T
}

export async function openSealedNoteEnvelope(
  recipientPublicKeyB64: string,
  recipientPrivateKeyB64: string,
  envelope: `0x${string}`
): Promise<NoteEnvelopePayload> {
  await sodium.ready
  const publicKey = sodium.from_base64(
    recipientPublicKeyB64,
    sodium.base64_variants.ORIGINAL
  )
  const privateKey = sodium.from_base64(
    recipientPrivateKeyB64,
    sodium.base64_variants.ORIGINAL
  )
  const ciphertext = hexToBytes(envelope)
  const opened = sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey)
  if (!opened) {
    throw new Error("Envelope decryption failed")
  }
  return parseNoteEnvelopePayload(JSON.parse(sodium.to_string(opened)))
}

export async function reconstructEnvelopeNote(payload: NoteEnvelopePayload) {
  const assetId = payload.version === 2 ? Number(payload.assetId) as 1 | 2 : payload.assetId
  const innerCommitment =
    payload.version === 2
      ? await calcPoolV3InnerCommitment(
          payload.secret,
          payload.nullifier,
          payload.depositor,
          assetId,
          payload.poolAddress
        )
      : await calcInnerCommitment(
          payload.secret,
          payload.nullifier,
          payload.depositor,
          assetId
        )
  const commitment = await calcFinalCommitment(innerCommitment, payload.amount)
  if (payload.version === 2 && commitment.toLowerCase() !== payload.commitment.toLowerCase()) {
    throw new Error("PoolV3 note commitment mismatch")
  }
  const nullifierHash =
    payload.version === 2
      ? await calcPoolV3NullifierHash(
          payload.secret,
          payload.nullifier,
          assetId,
          payload.poolAddress
        )
      : await calcNullifierHash(payload.secret, payload.nullifier)
  return { commitment, nullifierHash }
}

export function parseNoteEnvelopePayload(value: unknown): NoteEnvelopePayload {
  if (!value || typeof value !== "object") throw new Error("Invalid note envelope payload")
  const payload = value as Record<string, unknown>
  if (payload.version !== 1 && payload.version !== 2) throw new Error("Unsupported note envelope version")
  for (const key of ["amount", "secret", "nullifier", "depositor", "ownerRecoveryPubKeyB64"]) {
    if (typeof payload[key] !== "string" || payload[key] === "") throw new Error(`Invalid note envelope ${key}`)
  }
  if (payload.version === 1) {
    if (payload.assetId !== 1 && payload.assetId !== 2) throw new Error("Invalid note envelope asset")
    if (payload.kind !== "deposit" && payload.kind !== "change") throw new Error("Invalid note envelope kind")
    return payload as unknown as NoteEnvelopeV1
  }
  if (
    payload.poolVersion !== 3 ||
    payload.chainId !== 4217 ||
    (payload.assetId !== "1" && payload.assetId !== "2") ||
    typeof payload.poolAddress !== "string" ||
    !/^0x[0-9a-f]{40}$/iu.test(payload.poolAddress) ||
    typeof payload.commitment !== "string" ||
    !/^0x[0-9a-f]{64}$/iu.test(payload.commitment) ||
    !["deposit", "change", "privacy_link", "consolidation"].includes(String(payload.kind))
  ) {
    throw new Error("Invalid PoolV3 note envelope")
  }
  return payload as unknown as NoteEnvelopeV2
}

export async function createFreshNote(
  recipientRecoveryPubKeyB64: string,
  depositor: string,
  assetId: 1 | 2,
  amount: string,
  kind: "deposit" | "change"
) {
  const secret = await randomFieldElement()
  const nullifier = await randomFieldElement()
  const innerCommitment = await calcInnerCommitment(secret, nullifier, depositor, assetId)
  const commitment = await calcFinalCommitment(innerCommitment, amount)
  const nullifierHash = await calcNullifierHash(secret, nullifier)

  const payload: NoteEnvelopePayload = {
    version: 1,
    kind,
    assetId,
    amount,
    secret,
    nullifier,
    depositor,
    ownerRecoveryPubKeyB64: recipientRecoveryPubKeyB64,
    createdAt: Math.floor(Date.now() / 1000)
  }

  const envelope = await createSealedNoteEnvelope(recipientRecoveryPubKeyB64, payload)

  return {
    secret,
    nullifier,
    innerCommitment,
    commitment,
    nullifierHash,
    envelope,
    payload
  }
}

export async function createFreshPoolV3Note(
  recipientRecoveryPubKeyB64: string,
  depositor: string,
  assetId: 1 | 2,
  amount: string,
  kind: NoteEnvelopeV2["kind"],
  poolAddress: `0x${string}`
) {
  if (!/^0x[0-9a-f]{40}$/iu.test(poolAddress)) throw new Error("Invalid PoolV3 address")
  const secret = await randomFieldElement()
  const nullifier = await randomFieldElement()
  const innerCommitment = await calcPoolV3InnerCommitment(
    secret,
    nullifier,
    depositor,
    assetId,
    poolAddress
  )
  const commitment = await calcFinalCommitment(innerCommitment, amount)
  const nullifierHash = await calcPoolV3NullifierHash(secret, nullifier, assetId, poolAddress)
  const payload: NoteEnvelopeV2 = {
    version: 2,
    poolVersion: 3,
    poolAddress,
    chainId: 4217,
    assetId: String(assetId) as "1" | "2",
    amount,
    secret,
    nullifier,
    depositor,
    ownerRecoveryPubKeyB64: recipientRecoveryPubKeyB64,
    commitment,
    kind,
    createdAt: Math.floor(Date.now() / 1000)
  }
  const envelope = await createSealedNoteEnvelope(recipientRecoveryPubKeyB64, payload)
  return { secret, nullifier, innerCommitment, commitment, nullifierHash, envelope, payload }
}
