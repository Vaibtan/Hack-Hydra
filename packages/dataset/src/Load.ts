import { Effect } from "effect"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseQuestion, type DatasetQuestion, type RawQuestion } from "./LongMemEval.js"

/**
 * The two dataset files, by the names they have in `data/` (gitignored — 15 MB
 * and 265 MB). `s` is the benchmark proper; `oracle` keeps only the
 * answer-bearing sessions and is what the day-1 extraction gate measures on.
 */
export const DATASET_FILES = {
  oracle: "longmemeval_oracle.json",
  s: "longmemeval_s_cleaned.json"
} as const

export type DatasetName = keyof typeof DATASET_FILES

export class DatasetUnavailable extends Error {
  constructor(readonly path: string, override readonly cause: unknown) {
    super(`cannot read LongMemEval file at ${path} — the data/ directory is gitignored`)
  }
}

/**
 * The dataset files live in the workspace's gitignored `data/`. Resolving them
 * relative to the process cwd breaks the moment a command runs from a package
 * directory (which is what `pnpm --filter` does), so the root is found by
 * walking up for `pnpm-workspace.yaml`. `PALIMPSEST_DATA_DIR` overrides.
 */
export const defaultDataDir = (): string => {
  const override = process.env["PALIMPSEST_DATA_DIR"]
  if (override !== undefined && override !== "") return override
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return resolve(dir, "data")
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return "data"
}

export const datasetPath = (name: DatasetName, dataDir = defaultDataDir()): string =>
  resolve(dataDir, DATASET_FILES[name])

/**
 * Reads and parses a whole file. `longmemeval_s_cleaned.json` is 265 MB and
 * parses in ~1.5 s into ~0.9 GB of heap, which is well inside Node's default
 * budget, so there is no streaming path to maintain.
 */
export const loadDataset = (
  name: DatasetName,
  dataDir = defaultDataDir()
): Effect.Effect<ReadonlyArray<DatasetQuestion>, DatasetUnavailable> => {
  const path = datasetPath(name, dataDir)
  return Effect.tryPromise({
    try: async () => {
      const text = await readFile(path, "utf8")
      return (JSON.parse(text) as ReadonlyArray<RawQuestion>).map(parseQuestion)
    },
    catch: (cause) => new DatasetUnavailable(path, cause)
  })
}

/** Loads one user's haystack. `uid` is the LongMemEval `question_id`. */
export const loadQuestion = (
  name: DatasetName,
  uid: string,
  dataDir = defaultDataDir()
): Effect.Effect<DatasetQuestion, DatasetUnavailable> =>
  loadDataset(name, dataDir).pipe(
    Effect.flatMap((questions) => {
      const found = questions.find((q) => q.questionId === uid)
      return found === undefined
        ? Effect.fail(new DatasetUnavailable(datasetPath(name, dataDir), `no question with id ${uid}`))
        : Effect.succeed(found)
    })
  )
