import { encodeAbiParameters, type Hex } from "viem"
import { RECEIVING_V4_ARTIFACTS, receivingArtifactNameV4 } from "./current-artifacts-v4.js"
export type ReceivingProverV4 = (role: keyof typeof RECEIVING_V4_ARTIFACTS, input: Record<string, unknown>) => Promise<{ proof: Hex; publicSignals: string[] }>
export function createReceivingProverV4(args: { readArtifact(name: string): Promise<Uint8Array> }): ReceivingProverV4 {
return async function proveReceivingV4(role, input) {
  const spec = RECEIVING_V4_ARTIFACTS[role]
  const read = async (kind: "wasm" | "zkey") => {
    const bytes = await args.readArtifact(receivingArtifactNameV4(role, kind)), hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))
    if (Array.from(hash, n => n.toString(16).padStart(2, "0")).join("") !== spec[kind]) throw Error("Payment security file verification failed.")
    return bytes
  }
  const wasm = await read("wasm"), key = await read("zkey")
  const snark = await import("snarkjs") as unknown as { groth16: { fullProve(input: unknown, wasm: Uint8Array, key: Uint8Array): Promise<{ proof: unknown; publicSignals: string[] }>; exportSolidityCallData(proof: unknown, signals: string[]): Promise<string> } }
  const result = await snark.groth16.fullProve(input, wasm, key)
  if (result.publicSignals.length !== spec.nPublic) throw Error("Payment proof could not be prepared.")
  const calldata = JSON.parse("[" + await snark.groth16.exportSolidityCallData(result.proof, result.publicSignals) + "]")
  const values = calldata.slice(0, 3).map((v: unknown) => JSON.parse(JSON.stringify(v), (_, n) => typeof n === "string" ? BigInt(n) : n))
  return { proof: encodeAbiParameters([{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }], values as [readonly [bigint, bigint], readonly [readonly [bigint, bigint], readonly [bigint, bigint]], readonly [bigint, bigint]]) as Hex, publicSignals: result.publicSignals }
}
}
export { RECEIVING_V4_ARTIFACTS, receivingArtifactNameV4 } from "./current-artifacts-v4.js"
