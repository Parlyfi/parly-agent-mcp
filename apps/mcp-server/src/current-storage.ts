import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { isAbsolute } from "node:path"

export function createCurrentStorage(file: string) {
  if (!isAbsolute(file)) throw Error("PARLY_CURRENT_STORAGE_PATH must be absolute.")
  function read(): Record<string, string> {
    if (!existsSync(file)) return Object.create(null)
    const info = lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 134217728) throw Error("Current payment storage is unavailable.")
    const value: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([key, item]) => key.length > 1024 || typeof item !== "string" || item.length > 1048576)) throw Error("Current payment storage is invalid.")
    return Object.assign(Object.create(null), value)
  }
  function update(key: string, value: string | null) {
    const lock = `${file}.lock`, descriptor = openSync(lock, "wx", 0o600)
    const temporary = `${file}.${process.pid}.tmp`
    try {
      const values = read()
      if (value === null) delete values[key]
      else {
        if (key.length > 1024 || value.length > 1048576) throw Error("Current payment storage entry is too large.")
        values[key] = value
      }
      if (Object.keys(values).length > 256) throw Error("Current payment storage is full.")
      const output = openSync(temporary, "wx", 0o600)
      try { writeFileSync(output, JSON.stringify(values)); fsyncSync(output) } finally { closeSync(output) }
      renameSync(temporary, file)
      if (read()[key] !== (value ?? undefined)) throw Error("Current payment storage readback failed.")
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
      closeSync(descriptor)
      unlinkSync(lock)
    }
  }
  return {
    get length() { return Object.keys(read()).length },
    key(index: number) { return Object.keys(read())[index] ?? null },
    getItem(key: string) { return read()[key] ?? null },
    setItem(key: string, value: string) { update(key, value) },
    removeItem(key: string) { update(key, null) },
    async withExclusiveExecution<T>(operation: () => Promise<T>): Promise<T> {
      const lock = `${file}.execution-lock`, descriptor = openSync(lock, "wx", 0o600)
      try { return await operation() }
      finally { closeSync(descriptor); unlinkSync(lock) }
    }
  }
}
