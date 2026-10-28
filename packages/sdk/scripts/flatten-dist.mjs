import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const distRoot = path.join(packageRoot, "dist")
const flatArtifacts = [path.join(distRoot, "index.js"), path.join(distRoot, "index.d.ts")]

const candidates = [
  path.join(distRoot, "sdk", "src"),
  path.join(distRoot, "src"),
  path.join(distRoot, "packages", "sdk", "src")
]
let nestedSource
for (const candidate of candidates) {
  try {
    await fs.access(candidate)
    nestedSource = candidate
    break
  } catch {
    // TypeScript preserves different source roots in workspace and public-export builds.
  }
}
if (!nestedSource) {
  await Promise.all(flatArtifacts.map((artifact) => fs.access(artifact)))
  process.exit(0)
}
for (const entry of await fs.readdir(nestedSource, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.(?:js|d\.ts)$/u.test(entry.name)) continue
  await fs.copyFile(path.join(nestedSource, entry.name), path.join(distRoot, entry.name))
}
