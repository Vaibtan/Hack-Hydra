import type { DatasetQuestion } from "@palimpsest/dataset"
import type { ClaimGraph } from "@palimpsest/palimpsest"
import { Effect, Schema } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { SPLIT_FILE, SplitFile, type SplitName } from "./Splits.js"

export const workspaceRoot = (): string => {
  let dir = process.cwd()
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

export const splitFilePath = (root: string = workspaceRoot()): string => resolve(root, SPLIT_FILE)

const assertSplitFile: (input: unknown) => asserts input is SplitFile = Schema.asserts(SplitFile, {
  errors: "first"
})

export const readSplitFile = (path: string = splitFilePath()): SplitFile => {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  assertSplitFile(parsed)
  return parsed
}

/** Why the test half may not be read yet, or null. */
export const testGateRefusal = (file: SplitFile, split: SplitName): string | null =>
  split === "test" && file.gate === null
    ? `refusing --split test: ${SPLIT_FILE} has no gate record. The test half is read once, ` +
      "after the dev gate is written down."
    : null

export const uidFor = (prefix: string, questionId: string): string =>
  prefix === "" ? questionId : `${prefix}-${questionId}`

export const splitQuestions = (
  questions: ReadonlyArray<DatasetQuestion>,
  file: SplitFile,
  split: SplitName
): { readonly slice: ReadonlyArray<DatasetQuestion>; readonly wanted: number } => {
  const wanted = new Set(split === "dev" ? file.dev : file.test)
  return {
    slice: questions
      .filter((question) => wanted.has(question.questionId))
      .sort((a, b) => a.questionId.localeCompare(b.questionId)),
    wanted: wanted.size
  }
}

export const batchOf = <A>(
  items: ReadonlyArray<A>,
  batch: { readonly index: number; readonly count: number }
): { readonly items: ReadonlyArray<A>; readonly from: number } => {
  const size = Math.ceil(items.length / batch.count)
  const from = (batch.index - 1) * size
  return { items: items.slice(from, from + size), from }
}

/** Test ids a `--slice` run would answer while the gate is still unread. */
export const leakedTestIds = (
  slice: ReadonlyArray<DatasetQuestion>,
  committed: SplitFile | null
): ReadonlyArray<string> => {
  if (committed === null || committed.gate !== null) return []
  const testIds = new Set(committed.test)
  return slice.map((question) => question.questionId).filter((id) => testIds.has(id))
}

/** Question ids whose user has no claims in the graph. */
export const notIngested = (
  claimGraph: ClaimGraph,
  prefix: string,
  slice: ReadonlyArray<DatasetQuestion>,
  concurrency: number
) =>
  Effect.forEach(
    slice,
    (question) =>
      claimGraph
        .claimCount(uidFor(prefix, question.questionId))
        .pipe(Effect.map((claims) => (claims === 0 ? [question.questionId] : []))),
    { concurrency }
  ).pipe(Effect.map((missing) => missing.flat()))
