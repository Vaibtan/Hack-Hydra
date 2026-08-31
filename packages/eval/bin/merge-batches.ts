import { existsSync, readFileSync, readdirSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { EvalRow } from "../src/index.js"

/**
 * `merge-batches --system palimpsest --split dev [--variant no-select] [--results results]`
 *
 * Joins the batch files of one system into the whole-population results file
 * every other command expects.
 *
 * Batches exist because a read costs ~750 MiB of resident memory per distinct
 * user and does not bound, so the node holds about seven of the 60 dev users
 * before the capacity gate stops it (`ops/hydradb/step-load-2026-08.md`). A
 * 60-question run cannot happen in one node lifetime; it happens in twelve,
 * with the node restarted between them.
 *
 * That makes this file a place where a results set can quietly become wrong, so
 * it refuses rather than repairs:
 *
 *  - a batch missing from the set, or a duplicate index;
 *  - batches that disagree about the population, the split, the prefix, the
 *    extraction generation, the models or the ablations — two halves of a table
 *    measured against different things;
 *  - rows that do not add up to the population the batches declare, or a
 *    question answered by two batches.
 *
 * Nothing here re-runs a model or touches the graph, so it is free and
 * repeatable.
 */

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const workspaceRoot = (): string => {
  let dir = process.cwd()
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

const root = workspaceRoot()
const resultsDir = resolve(root, arg("results", "results"))
const system = arg("system", "")
const split = arg("split", "dev")
const variant = arg("variant", "")

if (system === "") {
  console.error("usage: merge-batches --system palimpsest --split dev [--variant no-select]")
  process.exit(2)
}

interface BatchEnvelope {
  readonly system: string
  readonly rows: ReadonlyArray<EvalRow>
  readonly batch?: {
    readonly index: number
    readonly count: number
    readonly population: ReadonlyArray<string>
  }
  readonly [field: string]: unknown
}

const stem = `${system}-${split}${variant === "" ? "" : `-${variant}`}`
const files = readdirSync(resultsDir)
  .filter((name) => name.startsWith(`${stem}.batch-`) && name.endsWith(".json"))
  .sort()

if (files.length === 0) {
  console.error(`no batch files matching ${stem}.batch-*.json in ${resultsDir}`)
  process.exit(2)
}

const envelopes = files.map(
  (name) => JSON.parse(readFileSync(resolve(resultsDir, name), "utf8")) as BatchEnvelope
)

const refusals: Array<string> = []

const batches = envelopes.map((envelope, at) => {
  if (envelope.batch === undefined) {
    refusals.push(`${files[at]} carries no batch record`)
  }
  return envelope.batch
})

const count = batches[0]?.count
if (count === undefined) {
  console.error(refusals.join("\n"))
  process.exit(2)
}
if (batches.some((one) => one?.count !== count)) {
  refusals.push(`the files disagree about how many batches there are: ${
    [...new Set(batches.map((one) => one?.count))].join(", ")
  }`)
}

const seen = new Set(batches.map((one) => one?.index))
for (let index = 1; index <= count; index++) {
  if (!seen.has(index)) refusals.push(`batch ${index} of ${count} is missing`)
}
if (seen.size !== batches.length) {
  refusals.push("two files claim the same batch index")
}

// Fields that must be identical across batches, because a table whose halves
// disagree about any of them is not one measurement.
for (const field of [
  "system",
  "dataset",
  "prefix",
  "split",
  "profile",
  "readerModel",
  "selectModel",
  "sufficiencyModel",
  "judgeModel",
  "extractionGeneration"
] as const) {
  const values = [...new Set(envelopes.map((one) => JSON.stringify(one[field] ?? null)))]
  if (values.length > 1) {
    refusals.push(`the batches disagree on \`${field}\`: ${values.join(" vs ")}`)
  }
}
const ablations = [...new Set(envelopes.map((one) => JSON.stringify(one["ablations"] ?? [])))]
if (ablations.length > 1) {
  refusals.push(`the batches disagree on \`ablations\`: ${ablations.join(" vs ")}`)
}

const population = batches[0]?.population ?? []
if (envelopes.some((_, at) => JSON.stringify(batches[at]?.population) !== JSON.stringify(population))) {
  refusals.push("the batches were cut from different populations")
}

const rows = envelopes.flatMap((one) => one.rows)
const byId = new Map<string, EvalRow>()
for (const row of rows) {
  if (byId.has(row.questionId)) {
    refusals.push(`${row.questionId} was answered by more than one batch`)
  }
  byId.set(row.questionId, row)
}
for (const questionId of population) {
  if (!byId.has(questionId)) refusals.push(`${questionId} is in no batch's rows`)
}

if (refusals.length > 0) {
  console.error(`refusing to merge ${files.length} file(s) into ${stem}.json:`)
  for (const refusal of refusals) console.error(`  ${refusal}`)
  process.exit(2)
}

// Sorted by question id, like a split run, so a merged file and an unbatched
// one diff line for line.
const merged = {
  ...envelopes[0]!,
  slice: population.length,
  requestedSlice: population.length,
  partial: false,
  // Kept, because how a results file was produced is part of what it is: these
  // rows were measured across `count` node lifetimes, not one.
  batches: count,
  rows: [...population].map((questionId) => byId.get(questionId)!)
}
delete (merged as { batch?: unknown }).batch

const outPath = resolve(resultsDir, `${stem}.json`)
await writeFile(outPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8")

console.log(`merged ${files.length} batches (${merged.rows.length} rows) into ${outPath}`)
