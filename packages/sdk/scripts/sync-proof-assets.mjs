import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { RECEIVING_V4_ARTIFACTS, receivingArtifactNameV4 } from "../dist/current-artifacts-v4.js"

const sdkAssetsRoot = path.resolve(import.meta.dirname, "..", "assets")
const args = process.argv.slice(2)
const download = args.length === 1 && args[0] === "--download"
const source = args.length === 2 && args[0] === "--source" ? path.resolve(args[1]) : null
if (args.length && !download && !source) throw Error("Use --source <existing verified files directory> or explicitly --download.")
const digest = bytes => createHash("sha256").update(bytes).digest("hex")
// Current balance recovery needs no proving assets; Spend60 uses these two frozen files only.
for (const kind of ["wasm", "zkey"]) {
  const name = receivingArtifactNameV4("spend", kind), expected = RECEIVING_V4_ARTIFACTS.spend[kind]
  const destination = path.join(sdkAssetsRoot, name)
  try {
    const installed = await fs.readFile(destination)
    if (digest(installed) !== expected) throw Error("An installed proof asset does not match its pinned hash: " + name)
    console.log("Verified " + name)
    continue
  } catch (error) { if (error.code !== "ENOENT") throw error }
  let bytes
  if (source) bytes = await fs.readFile(path.join(source, name))
  else if (download) {
    const response = await fetch("https://parly.fi/api/proof-assets/" + name, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(120000) })
    if (!response.ok || !response.body) throw Error("The pinned proof asset is unavailable: " + name)
    const reader = response.body.getReader(), chunks = []
    let length = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.length
      if (length > 64 * 1024 * 1024) { await reader.cancel(); throw Error("Proof asset exceeds its byte limit.") }
      chunks.push(value)
    }
    bytes = Buffer.concat(chunks)
  } else throw Error("Missing pinned Spend60 asset. Run sync:proof-assets --source <directory> or explicitly sync:proof-assets --download.")
  if (bytes.length > 64 * 1024 * 1024 || digest(bytes) !== expected) throw Error("Pinned V4 proof asset mismatch: " + name)
  await fs.mkdir(sdkAssetsRoot, { recursive: true })
  const temporary = destination + "." + randomUUID() + ".tmp"
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx" })
    await fs.rename(temporary, destination)
  } finally { await fs.rm(temporary, { force: true }) }
  console.log("Installed and verified " + name)
}
