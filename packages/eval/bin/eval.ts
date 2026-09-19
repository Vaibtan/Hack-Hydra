import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { Llm, LlmLive, loadDotEnv, readPathModels, verifyModels } from "@palimpsest/llm"
import { ClaimGraph, Reader, Retrieve, Supersede } from "@palimpsest/palimpsest"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  JUDGE_MODEL,
  LIVE_SYSTEMS,
  RETIRED_SYSTEMS,
  SPLIT_FILE,
  SYSTEMS,
  ablationNames,
  arg,
  assertGenerationMatches,
  batchOf,
  benchmarkSlice,
  flag,
  isSystemName,
  judge,
  leakedTestIds,
  liveExtractionGeneration,
  notIngested,
  orExit,
  parseAblations,
  parseBatch,
  parseDataset,
  parseGranularity,
  parseProfile,
  parseSplit,
  pct,
  readRuntimeConfig,
  readSplitFile,
  renderRunTable,
  responseOf,
  resultsStem,
  rowFromBaseline,
  rowFromV2,
  splitFilePath,
  splitQuestions,
  summariseByType,
  testGateRefusal,
  uidFor,
  variantTokens,
  workspaceRoot,
  writeEnvelopeAtomic,
  type EvalEnvelope,
  type EvalRow,
  type SystemDeps,
  type SystemName
} from "../src/index.js"

/**
 * `eval --system palimpsest-v2,bm25,fullctx,oracle-session|all [--split dev|test | --slice 100]`
 * `     [--prefix g3] [--profile full|fast] [--batch 3/12] [--skip-missing] [ablation flags]`
 */
loadDotEnv()

const refuse = (message: string): never => {
  console.error(message)
  process.exit(2)
}

const sliceSize = Number(arg("slice", "100"))
const dataset = orExit(() => parseDataset(arg("dataset", "s")))
const concurrency = Number(arg("concurrency", "8"))
const split = orExit(() => parseSplit(arg("split", "")))
const profile = orExit(() => parseProfile(arg("profile", "full")))
const batch = orExit(() => parseBatch(arg("batch", "")))
const ablations = parseAblations()
const granularity = orExit(() => parseGranularity(arg("granularity", "")))
const skipMissing = flag("skip-missing")
const judgeModel = arg("judge", JUDGE_MODEL)
const root = workspaceRoot()
const outDir = resolve(root, arg("out", "results"))
const fullCtxChars = Number(arg("fullctx-chars", process.env["PALIMPSEST_FULLCTX_CHARS"] ?? "520000"))
const DEFAULT_READ_TIMEOUT_MS = 25_000
const pass: EvalEnvelope["pass"] =
  Number(process.env["PALIMPSEST_READ_TIMEOUT_MS"] ?? "0") > DEFAULT_READ_TIMEOUT_MS ? "cold" : "warm"

const requested = arg("system", "palimpsest-v2")
const named = requested === "all" ? [...LIVE_SYSTEMS] : requested.split(",").map((s) => s.trim())
const unknown = named.filter((name) => !isSystemName(name))
if (unknown.length > 0) {
  refuse(`unknown --system value(s): ${unknown.join(", ")}\nknown systems: ${LIVE_SYSTEMS.join(", ")}, or "all"`)
}
const systems = named.filter(isSystemName)
const retired = systems.filter((name) => RETIRED_SYSTEMS.includes(name))
if (retired.length > 0) refuse(`${retired.join(", ")}: v1 was removed; run it from the pre-cleanup-v1 tag`)

const splitFile = (() => {
  if (split === null) return null
  if (!existsSync(splitFilePath(root))) {
    refuse(`--split ${split} needs ${SPLIT_FILE}; run \`pnpm splits\` and commit it first`)
  }
  const file = readSplitFile(splitFilePath(root))
  const gate = testGateRefusal(file, split)
  if (gate !== null) refuse(gate)
  try {
    assertGenerationMatches(file)
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error))
  }
  return file
})()

const prefix = arg("prefix", splitFile?.prefix ?? "g3")
const variant = variantTokens({ profile, ablations: ablationNames(ablations), granularity })

const AppLive = Retrieve.layer.pipe(
  Layer.provideMerge(Reader.layer),
  Layer.provideMerge(Supersede.layer),
  Layer.provideMerge(ClaimGraph.layer),
  Layer.provideMerge(HydraClient.layer),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  const retrieve = yield* Retrieve
  const reader = yield* Reader
  const claimGraph = yield* ClaimGraph
  const llm = yield* Llm

  const models = readPathModels(llm.model)
  yield* verifyModels(models, { extra: [judgeModel] }).pipe(
    Effect.tapError((error) => Effect.sync(() => console.error(error.message))),
    Effect.orDie
  )

  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  let slice: ReadonlyArray<DatasetQuestion>
  if (splitFile === null || split === null) {
    slice = benchmarkSlice(questions, sliceSize)
  } else {
    const selected = splitQuestions(questions, splitFile, split)
    if (selected.slice.length !== selected.wanted) {
      refuse(
        `${SPLIT_FILE} names ${selected.wanted} ${split} questions but the dataset holds ${selected.slice.length} of them`
      )
    }
    slice = selected.slice
  }
  const requestedCount = split === null ? sliceSize : slice.length
  const populationIds = slice.map((question) => question.questionId)
  if (batch !== null) {
    const cut = batchOf(slice, batch)
    slice = cut.items
    console.log(
      `batch        ${batch.index} of ${batch.count}: questions ${cut.from + 1}-${cut.from + slice.length} of ${populationIds.length}`
    )
    if (slice.length === 0) refuse(`batch ${batch.index}/${batch.count} is empty; the population has ${populationIds.length} questions`)
  }
  if (splitFile === null && existsSync(splitFilePath(root))) {
    const leaked = leakedTestIds(slice, readSplitFile(splitFilePath(root)))
    if (leaked.length > 0) {
      refuse(
        `refusing --slice ${sliceSize}: it contains ${leaked.length} test questions and ${SPLIT_FILE} has no gate record. Use --split dev.`
      )
    }
  }

  const needsGraph = systems.some((system) => SYSTEMS[system].needsGraph)
  const runtimeConfig = readRuntimeConfig()

  console.log(`dataset      ${dataset}`)
  console.log(
    `${(split === null ? "slice" : `split ${split}`).padEnd(12)} ${slice.length} questions ` +
      `(${slice.filter((q) => q.isAbstention).length} abstention, ${slice.filter((q) => !q.isAbstention).length} answerable)`
  )
  console.log(`systems      ${systems.join(", ")}`)
  console.log(`reader       ${llm.model}   judge  ${judgeModel}   profile ${profile}   pass ${pass}`)
  console.log(`prefix       ${prefix || "(none)"}   concurrency ${concurrency}   variant ${variant.join(",") || "(none)"}`)
  console.log(`generation   ${liveExtractionGeneration().id}`)
  console.log(
    runtimeConfig.sha256 === null
      ? `runtime     (unavailable: ${runtimeConfig.reason})`
      : `runtime      ${runtimeConfig.sha256.slice(0, 16)}  read-cache ${runtimeConfig.readCacheEnabled ? "on" : "off"}  query-cap ${runtimeConfig.queryRuntimeMs} ms`
  )
  console.log("")

  if (needsGraph) {
    const missing = yield* notIngested(claimGraph, prefix, slice, concurrency)
    const listed = `${missing.slice(0, 20).join(", ")}${missing.length > 20 ? " …" : ""}`
    if (missing.length > 0 && skipMissing && split === "test") {
      refuse(
        `refusing --skip-missing on --split test: ${missing.length} of ${slice.length} users are not indexed. ` +
          `Finish the ingest, or record a capacity-capped population in ${SPLIT_FILE} and regenerate the split.`
      )
    }
    if (missing.length > 0 && skipMissing) {
      console.log(`skipping     ${missing.length} of ${slice.length} questions whose users are not indexed`)
      console.log(`             ${listed}`)
      console.log("")
      slice = slice.filter((question) => !missing.includes(question.questionId))
    } else if (missing.length > 0) {
      refuse(
        `${missing.length} of ${slice.length} users are not indexed:\n  ${listed}\n` +
          `Run: PALIMPSEST_LLM_CONCURRENCY=48 pnpm ingest-slice --slice ${sliceSize} --dataset ${dataset} --users 7 --prefix ${prefix}\n` +
          `(or pnpm backfill-user --prefix ${prefix} if they were ingested earlier)`
      )
    }
  }

  const runOne = (
    system: SystemName,
    question: DatasetQuestion
  ): Effect.Effect<EvalRow, never, Llm> =>
    Effect.gen(function* () {
      const deps: SystemDeps = {
        retrieve,
        reader,
        uid: uidFor(prefix, question.questionId),
        v2: { profile, ablations, granularity },
        fullCtxChars
      }
      const started = Date.now()
      const outcome = yield* SYSTEMS[system].run(question, deps)
      const latencyMs = Date.now() - started
      const judgement = yield* judge(question, responseOf(outcome), judgeModel)
      return outcome.kind === "v2"
        ? rowFromV2(question, outcome, judgement, latencyMs)
        : rowFromBaseline(system, question, outcome, judgement, latencyMs)
    }).pipe(Effect.orDie)

  mkdirSync(outDir, { recursive: true })

  const runSystem = (system: SystemName) =>
    Effect.gen(function* () {
      const started = Date.now()
      let done = 0
      const rows = yield* Effect.forEach(
        slice,
        (question) =>
          runOne(system, question).pipe(
            Effect.tap((row) =>
              Effect.sync(() => {
                done++
                if (done % 10 === 0 || done === slice.length) {
                  console.log(
                    `  ${system.padEnd(19)} ${String(done).padStart(3)}/${slice.length}  ` +
                      `${((Date.now() - started) / 60_000).toFixed(1)} min  last: ` +
                      `${row.questionId} ${row.judged ? "OK " : "   "}${row.answer.slice(0, 40)}`
                  )
                }
              })
            )
          ),
        { concurrency }
      )
      const envelope: EvalEnvelope = {
        system,
        dataset,
        prefix,
        split,
        profile,
        variant,
        pass,
        slice: slice.length,
        requestedSlice: requestedCount,
        partial: batch === null && slice.length !== requestedCount,
        ...(batch !== null && { batch: { ...batch, population: populationIds } }),
        readerModel: models.reader,
        selectModel: models.select,
        sufficiencyModel: models.sufficiency,
        judgeModel,
        extractionGeneration: liveExtractionGeneration().id,
        runtimeConfig,
        ablations: system === "palimpsest-v2" ? ablationNames(ablations) : [],
        granularity,
        fullCtxChars: system === "fullctx" ? fullCtxChars : null,
        rows
      }
      const path = resolve(
        outDir,
        `${resultsStem({ system, split, sliceSize: slice.length, variant, batch })}.json`
      )
      writeEnvelopeAtomic(path, envelope)
      console.log(`  wrote ${path}`)
      console.log("")
      return [system, rows] as const
    })

  const graphSystems = systems.filter((system) => SYSTEMS[system].needsGraph)
  const datasetSystems = systems.filter((system) => !SYSTEMS[system].needsGraph)
  const bySystem = [
    ...(yield* Effect.forEach(graphSystems, runSystem)),
    ...(yield* Effect.forEach(datasetSystems, runSystem, { concurrency: 2 }))
  ].sort((a, b) => systems.indexOf(a[0]) - systems.indexOf(b[0]))

  const table = renderRunTable({
    population: split === null ? "slice" : `${split} split`,
    dataset,
    prefix,
    profile,
    readerModel: llm.model,
    judgeModel,
    measured: slice.length,
    requested: requestedCount,
    bySystem
  })

  const tablePath = resolve(outDir, `table-${split ?? slice.length}.md`)
  yield* Effect.promise(() => writeFile(tablePath, table + "\n", "utf8"))

  console.log(table)
  console.log("")
  for (const [system, rows] of bySystem) {
    const all = summariseByType(rows).find((s) => s.type === "ALL")!
    console.log(
      `${system.padEnd(19)} accuracy ${pct(all.accuracy).padStart(6)}   abstention ${pct(all.abstentionAccuracy).padStart(6)}` +
        `   false-abst ${pct(all.falseAbstention).padStart(6)}`
    )
  }

  const usage = yield* llm.usageByModel
  console.log("")
  for (const [model, one] of usage) {
    console.log(
      `${model.padEnd(19)} ${one.calls} live calls, ${one.cacheHits} cached, ${one.inputTokens} in / ${one.outputTokens} out`
    )
  }
  console.log(`cost         $${(yield* llm.costUsd).toFixed(4)}`)
  console.log(`wrote        ${tablePath}`)
})

Effect.runPromise(Effect.provide(program, AppLive)).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
