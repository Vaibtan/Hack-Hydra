import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { Llm, LlmLive, loadDotEnv, readPathModels, verifyModels } from "@palimpsest/llm"
import { ClaimGraph, Reader, Retrieve, Supersede } from "@palimpsest/palimpsest"
import { Effect, Layer, Schema } from "effect"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  JUDGE_MODEL,
  ReaderAbFile,
  SPLIT_FILE,
  arg,
  assertGenerationMatches,
  batchOf,
  flag,
  judge,
  judgeTemplate,
  liveExtractionGeneration,
  mergeBatches,
  orExit,
  parseBatch,
  parseDataset,
  parseProfile,
  parseSplit,
  readRuntimeConfig,
  readSplitFile,
  renderReaderAb,
  splitFilePath,
  testGateRefusal,
  uidFor,
  workspaceRoot,
  writeAtomic,
  type ReaderAbRow
} from "../src/index.js"

/** `reader-ab [--split dev] [--types a,b] [--profile full|fast] [--concurrency 6] [--batch 2/5 | --merge]` */
loadDotEnv()

const split = orExit(() => parseSplit(arg("split", "dev"))) ?? "dev"
const dataset = orExit(() => parseDataset(arg("dataset", "s")))
const profile = orExit(() => parseProfile(arg("profile", "full")))
const concurrency = Number(arg("concurrency", "6"))
const judgeModel = arg("judge", JUDGE_MODEL)
const types = arg("types", "single-session-preference,knowledge-update")
  .split(",")
  .map((one) => one.trim())
  .filter((one) => one !== "")
const merge = flag("merge")
const batch = orExit(() => parseBatch(arg("batch", "")))

const root = workspaceRoot()
const outDir = resolve(root, arg("out", "results"))

const splitPath = splitFilePath(root)
if (!existsSync(splitPath)) {
  console.error(`--split ${split} needs ${SPLIT_FILE}; run \`pnpm splits\` and commit it first`)
  process.exit(2)
}
const splitFile = readSplitFile(splitPath)
const gateRefusal = testGateRefusal(splitFile, split)
if (gateRefusal !== null) {
  console.error(gateRefusal)
  process.exit(2)
}
try {
  assertGenerationMatches(splitFile)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

const prefix = arg("prefix", splitFile.prefix)

const batchPath = (index: number, count: number): string =>
  resolve(outDir, `reader-ab-${split}.batch-${String(index).padStart(2, "0")}-of-${count}.json`)

const mergedPath = resolve(outDir, `reader-ab-${split}.json`)

const READER_AB_MEASUREMENT_FIELDS = [
  "kind",
  "split",
  "prefix",
  "profile",
  "readerModel",
  "judgeModel",
  "extractionGeneration",
  "questionTypes"
] as const satisfies ReadonlyArray<keyof ReaderAbFile>

if (merge) {
  const files = readdirSync(outDir)
    .filter((name) => name.startsWith(`reader-ab-${split}.batch-`) && name.endsWith(".json"))
    .sort()
  if (files.length === 0) {
    console.error(`no batch files matching reader-ab-${split}.batch-*.json in ${outDir}`)
    process.exit(2)
  }
  const parts = files.map((name) => ({
    name,
    envelope: Schema.decodeUnknownSync(ReaderAbFile)(
      JSON.parse(readFileSync(resolve(outDir, name), "utf8"))
    )
  }))
  const { refusals, merged } = mergeBatches(parts, READER_AB_MEASUREMENT_FIELDS)
  if (refusals.length > 0 || merged === null) {
    console.error(`refusing to merge ${files.length} file(s):`)
    for (const refusal of refusals) console.error(`  ${refusal}`)
    process.exit(2)
  }
  const { batch: _batch, ...first } = parts[0]!.envelope
  const mergedFile: ReaderAbFile = { ...first, rows: merged.rows }
  writeAtomic(mergedPath, `${JSON.stringify(mergedFile, null, 2)}
`)
  console.log(renderReaderAb(mergedFile))
  console.log("")
  console.log(`merged ${files.length} batches (${mergedFile.rows.length} rows) into ${mergedPath}`)
  process.exit(0)
}

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
  const wanted = new Set(split === "dev" ? splitFile.dev : splitFile.test)
  let population: ReadonlyArray<DatasetQuestion> = questions
    .filter((question) => wanted.has(question.questionId))
    .filter((question) => types.includes(question.questionType))
    .sort((a, b) => a.questionId.localeCompare(b.questionId))

  const wholePopulation = population.length
  if (batch !== null) {
    population = batchOf(population, batch).items
    if (population.length === 0) {
      console.error(`batch ${batch.index}/${batch.count} is empty; the population has ${wholePopulation} questions`)
      return yield* Effect.sync(() => process.exit(2))
    }
  }

  console.log(`split        ${split}`)
  console.log(`types        ${types.join(", ")}`)
  console.log(
    `questions    ${population.length}` +
      (batch === null ? "" : ` (batch ${batch.index} of ${batch.count}, of ${wholePopulation})`)
  )
  console.log(`reader       ${llm.model}   judge ${judgeModel}   profile ${profile}`)
  const runtimeConfig = readRuntimeConfig()
  console.log(
    runtimeConfig.sha256 === null
      ? `runtime      (unavailable: ${runtimeConfig.reason})`
      : `runtime      ${runtimeConfig.sha256.slice(0, 16)}  read-cache ` +
        `${runtimeConfig.readCacheEnabled ? "on" : "off"}`
  )
  console.log("")

  if (population.length === 0) {
    console.error(`no ${split} questions of type ${types.join(", ")}`)
    return yield* Effect.sync(() => process.exit(2))
  }
  const missing = yield* Effect.forEach(
    population,
    (question) =>
      claimGraph
        .claimCount(uidFor(prefix, question.questionId))
        .pipe(Effect.map((claims) => ({ question, claims }))),
    { concurrency: 8 }
  ).pipe(Effect.orDie)
  const absent = missing.filter((one) => one.claims === 0)
  if (absent.length > 0) {
    console.error(
      `${absent.length} of ${population.length} users are not in the graph: ` +
        `${absent.map((one) => one.question.questionId).join(", ")}`
    )
    console.error("finish the ingest first; an unindexed user is not a reader measurement")
    return yield* Effect.sync(() => process.exit(2))
  }

  let done = 0
  const rows = yield* Effect.forEach(
    population,
    (question: DatasetQuestion) =>
      Effect.gen(function* () {
        const uid = uidFor(prefix, question.questionId)
        const questionDate = question.questionDate.raw

        const ask = yield* retrieve.ask(uid, question.question, { questionDate, profile })
        if (ask.verdict === "ABSENT") return null

        const plan = ask.plan
        const withRoute = yield* reader.read(question.question, questionDate, ask.evidence, {
          route: plan.route,
          slotOf: new Map(Object.entries(plan.slots)),
          protectedKeys: new Set(plan.protectedKeys)
        })
        const withoutRoute = yield* reader.readSpans(
          question.question,
          questionDate,
          withRoute.spans,
          {}
        )

        if (withRoute.spanHash !== withoutRoute.spanHash) {
          console.error(
            `${question.questionId}: the two arms read different spans ` +
              `(${withRoute.spanHash.slice(0, 12)} vs ${withoutRoute.spanHash.slice(0, 12)}); skipped`
          )
          return null
        }

        const [judgedRoute, judgedPlain] = yield* Effect.all(
          [
            judge(question, withRoute.answer, judgeModel),
            judge(question, withoutRoute.answer, judgeModel)
          ],
          { concurrency: 2 }
        )

        done++
        console.log(
          `  ${String(done).padStart(3)}/${population.length}  ${question.questionId}  ` +
            `${question.questionType.padEnd(26)} route ${plan.route.padEnd(17)} ` +
            `${judgedRoute.correct ? "OK " : "   "} vs ${judgedPlain.correct ? "OK " : "   "}`
        )

        return {
          questionId: question.questionId,
          questionType: question.questionType,
          judgeTemplate: judgeTemplate(question),
          route: plan.route,
          spanHash: withRoute.spanHash,
          excerpts: withRoute.spans.length,
          withRoute: {
            answer: withRoute.answer,
            correct: judgedRoute.correct,
            judgeReply: judgedRoute.reply,
            notInMemory: withRoute.notInMemory,
            recited: withRoute.recited,
            inputTokens: withRoute.inputTokens,
            outputTokens: withRoute.outputTokens
          },
          withoutRoute: {
            answer: withoutRoute.answer,
            correct: judgedPlain.correct,
            judgeReply: judgedPlain.reply,
            notInMemory: withoutRoute.notInMemory,
            recited: withoutRoute.recited,
            inputTokens: withoutRoute.inputTokens,
            outputTokens: withoutRoute.outputTokens
          }
        } satisfies ReaderAbRow
      }).pipe(Effect.orDie),
    { concurrency }
  )

  const kept: ReadonlyArray<ReaderAbRow> = rows.filter((row) => row !== null)
  const file: ReaderAbFile = {
    kind: "reader-ab",
    split,
    prefix,
    profile,
    readerModel: models.reader,
    judgeModel,
    extractionGeneration: liveExtractionGeneration().id,
    runtimeConfig,
    questionTypes: types,
    ...(batch !== null && { batch: { index: batch.index, count: batch.count } }),
    rows: kept
  }

  mkdirSync(outDir, { recursive: true })
  const jsonPath = batch === null ? mergedPath : batchPath(batch.index, batch.count)
  writeAtomic(jsonPath, `${JSON.stringify(file, null, 2)}
`)

  const table = renderReaderAb(file)
  console.log("")
  console.log(table)
  console.log("")
  console.log(
    `skipped      ${population.length - kept.length} (structural abstention or unpaired evidence)`
  )
  console.log(`cost         $${(yield* llm.costUsd).toFixed(4)}`)
  console.log(`wrote        ${jsonPath}`)
})

Effect.runPromise(Effect.provide(program, AppLive)).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
