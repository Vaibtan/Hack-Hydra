import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { existsSync } from "node:fs"
import { Result, Schema } from "effect"

const CachedCallSchema = Schema.Struct({
  model: Schema.String,
  resolvedModel: Schema.optionalKey(Schema.String),
  value: Schema.Unknown,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  system: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String)
})

export const cacheKey = (parts: {
  readonly model: string
  readonly system: string
  readonly prompt: string
  readonly schema: unknown
}): string =>
  createHash("sha256")
    .update(parts.model, "utf8")
    .update(" | ", "utf8")
    .update(parts.system, "utf8")
    .update(" | ", "utf8")
    .update(parts.prompt, "utf8")
    .update(" | ", "utf8")
    .update(JSON.stringify(parts.schema), "utf8")
    .digest("hex")

const workspaceRoot = (): string => {
  let dir = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

export const defaultCacheDir = (): string => {
  const override = process.env["PALIMPSEST_LLM_CACHE"]
  if (override !== undefined && override !== "") return override
  return resolve(workspaceRoot(), ".cache", "llm")
}

export interface CachedCall {
  /** Requested provider model identifier used in the cache key. */
  readonly model: string
  /** Provider-returned model identifier, absent on historical entries that did not record it. */
  readonly resolvedModel?: string
  /** The encoded (wire) form of the structured output, so decoding stays honest. */
  readonly value: unknown
  readonly inputTokens: number
  readonly outputTokens: number
  readonly system?: string
  readonly prompt?: string
}

const pathFor = (dir: string, kind: string, key: string): string =>
  resolve(dir, kind, `${key.slice(0, 2)}`, `${key}.json`)

export const readCache = async (
  dir: string,
  kind: string,
  key: string
): Promise<CachedCall | undefined> => {
  const path = pathFor(dir, kind, key)
  if (!existsSync(path)) return undefined
  try {
    const decoded = Schema.decodeUnknownResult(CachedCallSchema)(JSON.parse(await readFile(path, "utf8")))
    return Result.isSuccess(decoded) ? decoded.success : undefined
  } catch {
    return undefined
  }
}

export const writeCache = async (
  dir: string,
  kind: string,
  key: string,
  entry: CachedCall
): Promise<void> => {
  const path = pathFor(dir, kind, key)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(entry), "utf8")
}
