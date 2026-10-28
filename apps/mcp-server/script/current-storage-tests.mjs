import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import test from "node:test"
import ts from "typescript"

const module = { exports: {} }
const source = fs.readFileSync(new URL("../src/current-storage.ts", import.meta.url), "utf8")
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
  module, exports: module.exports, process, require: name => ({ "node:fs": fs, "node:path": path })[name]
})

test("current payment storage survives restart and corrupt state never becomes empty", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parly-agent-storage-")), file = path.join(root, "pending.json")
  try {
    const first = module.exports.createCurrentStorage(file)
    first.setItem("capsule", "encrypted synthetic capsule")
    const restarted = module.exports.createCurrentStorage(file)
    assert.equal(restarted.getItem("capsule"), "encrypted synthetic capsule")
    assert.equal(restarted.length, 1)
    assert.equal(restarted.key(0), "capsule")
    restarted.removeItem("capsule")
    assert.equal(first.getItem("capsule"), null)
    fs.writeFileSync(file, "broken")
    assert.throws(() => first.getItem("capsule"))
    assert.throws(() => first.setItem("next", "cannot overwrite corrupt state"))
    assert.equal(fs.readFileSync(file, "utf8"), "broken")
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("separate HTTP runtimes cannot prepare simultaneous wallet executions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parly-agent-lock-")), file = path.join(root, "pending.json")
  try {
    const first = module.exports.createCurrentStorage(file), second = module.exports.createCurrentStorage(file)
    let release
    const running = first.withExclusiveExecution(() => new Promise(resolve => { release = resolve }))
    await assert.rejects(second.withExclusiveExecution(async () => "duplicate"))
    release("first"); assert.equal(await running, "first")
    assert.equal(await second.withExclusiveExecution(async () => "next"), "next")
    fs.writeFileSync(`${file}.execution-lock`, "stale")
    await assert.rejects(second.withExclusiveExecution(async () => "unsafe retry"))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
