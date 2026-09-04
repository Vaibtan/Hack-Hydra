import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetName, type DatasetQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { loadDotEnv } from "@palimpsest/llm"
import { readUserStats } from "@palimpsest/palimpsest"
import { Effect, Layer, Option } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  BENCHMARK_EXTRACTION_DEPENDENCIES,
  SPLIT_FILE,
  benchmarkSlice,
  liveExtractionGeneration,
  outsidePopulation,
  splitByCached,
  type SplitFile
} from "../src/index.js"

/** `splits [--slice 200] [--prefix g3] [--dev-from results/palimpsest-60.json] [--check] [--gate-tripped]` */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const sliceSize = Number(arg("slice", "200"))
const dataset = arg("dataset", "s") as DatasetName
const prefix = arg("prefix", "g3")
const devFrom = arg("dev-from", "results/palimpsest-60.json")
const check = process.argv.includes("--check")
const gateTripped = process.argv.includes("--gate-tripped")

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
const outPath = resolve(root, arg("out", SPLIT_FILE))

const uidFor = (questionId: string): string =>
  prefix === "" ? questionId : `${prefix}-${questionId}`

const AppLive = HydraClient.Default.pipe(Layer.provide(NodeHttpClient.layerUndici))

const cachedIds = (): ReadonlyArray<string> => {
  const path = resolve(root, devFrom)
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    rows: ReadonlyArray<{ questionId: string }>
  }
  return parsed.rows.map((row) => row.questionId)
}

const program = Effect.gen(function* () {
  const hydra = yield* HydraClient
  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  const population = benchmarkSlice(questions, sliceSize)
  const cached = cachedIds()

  const stray = outsidePopulation(population, cached)
  if (stray.length > 0) {
    return yield* Effect.dieMessage(
      `${stray.length} of the ${cached.length} cached ids are not in benchmarkSlice(${sliceSize}): ` +
        `${stray.slice(0, 10).join(", ")}. Pin the population as an explicit id list instead of ` +
        "relying on --slice."
    )
  }

  const { dev, test } = splitByCached(population, cached)
  const generation = liveExtractionGeneration()

  let ingested = population.length
  if (check) {
    const byQuestion = new Map(population.map((q) => [q.questionId, q] as const))
    const results = yield* Effect.forEach(
      population,
      (question: DatasetQuestion) =>
        readUserStats(hydra, uidFor(question.questionId)).pipe(
          Effect.map((stats) =>
            Option.isSome(stats) && stats.value.sessions === question.sessions.length
              ? question.questionId
              : null
          )
        ),
      { concurrency: 8 }
    )
    const complete = results.filter((id): id is string => id !== null)
    ingested = complete.length
    const missing = population.filter((q) => !complete.includes(q.questionId))
    console.log(`ingested   ${ingested}/${population.length} users fully written under ${prefix}`)
    if (missing.length > 0) {
      console.log(
        `missing    ${missing.length}: ${missing.slice(0, 12).map((q) => q.questionId).join(", ")}` +
          `${missing.length > 12 ? " …" : ""}`
      )
    }
    console.log(`  (dev users among them: ${dev.filter((id) => complete.includes(id)).length}/${dev.length})`)
    void byQuestion
  }

  const existing: SplitFile | null = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, "utf8")) as SplitFile)
    : null

  const file: SplitFile = {
    schemaVersion: 1,
    dataset,
    slice: sliceSize,
    prefix,
    createdAt: existing?.createdAt ?? new Date().toISOString().slice(0, 10),
    note:
      `dev = the ${dev.length} questions already cached from the g2 run (results/*-60.json); ` +
      `test = the other ${test.length}, read once after the gate. Both lists are fixed before the ` +
      "first v2 result exists.",
    extractionGeneration: {
      id: generation.id,
      promptTemplateSha256: generation.promptTemplateSha256,
      outputSchemaSha256: generation.outputSchemaSha256,
      dependencies: BENCHMARK_EXTRACTION_DEPENDENCIES
    },
    population: {
      requested: population.length,
      ingested,
      capacityGateTripped: gateTripped || (existing?.population.capacityGateTripped ?? false)
    },
    dev,
    test,
    gate: existing?.gate ?? null
  }

  yield* Effect.promise(() => mkdir(dirname(outPath), { recursive: true }))
  yield* Effect.promise(() => writeFile(outPath, `${JSON.stringify(file, null, 2)}\n`, "utf8"))

  const abs = (ids: ReadonlyArray<string>): number => ids.filter((id) => id.endsWith("_abs")).length
  console.log(`population ${population.length} questions (${abs(population.map((q) => q.questionId))} _abs)`)
  console.log(`dev        ${dev.length} (${abs(dev)} _abs, ${dev.length - abs(dev)} answerable)`)
  console.log(`test       ${test.length} (${abs(test)} _abs, ${test.length - abs(test)} answerable)`)
  console.log(`generation ${generation.id}`)
  console.log(`gate       ${file.gate === null ? "not read yet" : `${file.gate.passed ? "passed" : "failed"} on ${file.gate.readAt}`}`)
  console.log(`wrote      ${outPath}`)
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
