import { Effect } from "effect"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseQuestion, type DatasetQuestion, type RawQuestion } from "./LongMemEval.js"

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
