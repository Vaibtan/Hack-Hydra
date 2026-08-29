import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { existsSync } from "node:fs"

/**
 * Content-addressed disk cache for LLM calls.
 *
 * Extraction is not deterministic; caching is what makes a *run* deterministic
 * and what makes re-running the benchmark free. The key covers everything that
 * can change the answer — model, system prompt, prompt, and the JSON schema the
 * provider is constrained to — so a prompt edit is a cache miss by construction.
 */

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
  readonly model: string
  /** The encoded (wire) form of the structured output, so decoding stays honest. */
  readonly value: unknown
  readonly inputTokens: number
  readonly outputTokens: number
  /**
   * What the model was actually shown, stored beside what it answered.
   *
   * The cache key is a hash of these, which proves two runs sent the same
   * prompt and shows nobody what it was. A replay has to be able to open one
   * file and read the question that produced an answer -- otherwise "here is
   * the receipt" stops at the boundary of the LLM call, which is exactly where
   * a reader of a benchmark result wants to look hardest.
   *
   * Optional so that every entry written before this field existed still loads:
   * an old entry replays its value and says nothing about its prompt, rather
   * than being a cache miss and a fresh charge.
   */
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
    return JSON.parse(await readFile(path, "utf8")) as CachedCall
  } catch {
    // A truncated cache entry is a miss, not a failure.
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
