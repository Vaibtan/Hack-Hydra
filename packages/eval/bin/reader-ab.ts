import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetName, type DatasetQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { Llm, LlmLive, loadDotEnv, readPathModels, verifyModels } from "@palimpsest/llm"
import { ClaimGraph, Reader, Retrieve, Supersede } from "@palimpsest/palimpsest"
import { Effect, Layer } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  JUDGE_MODEL,
  SPLIT_FILE,
  assertGenerationMatches,
  judge,
  judgeTemplate,
  liveExtractionGeneration,
  readRuntimeConfig,
  renderReaderAb,
  type ReaderAbFile,
  type ReaderAbRow,
  type SplitFile
} from "../src/index.js"

/**
 * `reader-ab [--split dev] [--types single-session-preference,knowledge-update]`
 * `          [--profile full|fast] [--concurrency 6]`
 *
 * #30's last box: the route-specific reader rules, measured against v1's single
 * prompt **on identical packed evidence**.
 *
 * Every other v2 stage changes what the reader sees, so an ablation of the
 * pipeline measures it. This one changes only how the reader is asked, and a
 * pipeline ablation would compare two different packs. So the evidence is fixed
 * and only the prompt varies: retrieve and pack once, then read those exact
 * spans twice — with the route rules and with v1's prompt byte for byte — and
 * judge both with the same official template.
 *
 * The harness asserts the pairing rather than assuming it: both reads report a
 * span hash, and a row whose two hashes differ is refused rather than written,
 * because a paired comparison over unpaired evidence is worse than none.
 *
 * The population is the two routes whose rules the research predicted would
 * matter most — `single-session-preference` (v1's "as few words as the question
 * allows" produces the generic suggestion the judge marks wrong) and
 * `knowledge-update` (the reader has to say which of two values is current).
 *
 * Every call replays from `.cache/llm`, so a second run is $0.00 and identical.
 */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const split = arg("split", "dev")
const dataset = arg("dataset", "s") as DatasetName
const profile = arg("profile", "full") as "full" | "fast"
const concurrency = Number(arg("concurrency", "6"))
const judgeModel = arg("judge", JUDGE_MODEL)
const types = arg("types", "single-session-preference,knowledge-update")
  .split(",")
  .map((one) => one.trim())
  .filter((one) => one !== "")

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
const outDir = resolve(root, arg("out", "results"))

if (split !== "dev" && split !== "test") {
  console.error(`--split must be dev or test, not ${JSON.stringify(split)}`)
  process.exit(2)
}

const splitPath = resolve(root, SPLIT_FILE)
if (!existsSync(splitPath)) {
  console.error(`--split ${split} needs ${SPLIT_FILE}; run \`pnpm splits\` and commit it first`)
  process.exit(2)
}
const splitFile = JSON.parse(readFileSync(splitPath, "utf8")) as SplitFile
// The same refusal `eval` makes, for the same reason: the test half is read
// once, after the dev gate is written down. An A/B is tuning by definition.
if (split === "test" && splitFile.gate === null) {
  console.error(
    `refusing --split test: ${SPLIT_FILE} has no gate record. The reader A/B is a tuning ` +
      "measurement and belongs on dev."
  )
  process.exit(2)
}
try {
  assertGenerationMatches(splitFile)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

const prefix = arg("prefix", splitFile.prefix)
const uidFor = (questionId: string): string =>
  prefix === "" ? questionId : `${prefix}-${questionId}`

const AppLive = Retrieve.Default.pipe(
  Layer.provideMerge(Reader.Default),
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(ClaimGraph.Default),
  Layer.provideMerge(HydraClient.Default),
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
  const population = questions
    .filter((question) => wanted.has(question.questionId))
    .filter((question) => types.includes(question.questionType))
    .sort((a, b) => a.questionId.localeCompare(b.questionId))

  console.log(`split        ${split}`)
  console.log(`types        ${types.join(", ")}`)
  console.log(`questions    ${population.length}`)
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

  // A user with no claims would read as an abstention in both arms and count as
  // a tie, which is a measurement of the ingest rather than of the rules.
  const missing = yield* Effect.forEach(
    population,
    (question) =>
      claimGraph
        .claimCount(uidFor(question.questionId))
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
        const uid = uidFor(question.questionId)
        const questionDate = question.questionDate.raw

        // One retrieval, one pack. Both arms read what this produced.
        const ask = yield* retrieve.ask(uid, question.question, {
          questionDate,
          pipeline: "v2",
          profile
        })
        const plan = ask.plan
        const pack =
          plan === null
            ? undefined
            : {
                route: plan.route,
                slotOf: new Map(Object.entries(plan.slots)),
                protectedKeys: new Set(plan.protectedKeys)
              }

        if (ask.verdict === "ABSENT") {
          // Nothing to read, so nothing to compare. Skipped rather than counted
          // as a tie: a structural abstention says the arms were never asked.
          return null
        }

        const withRoute = yield* reader.read(question.question, questionDate, ask.evidence, {
          ...(pack === undefined ? {} : { pack }),
          route: plan?.route ?? null
        })
        // The *same spans*, re-read with v1's prompt. `readSpans` and not
        // `read`: re-hydrating could produce a different pack if anything
        // downstream of the graph were non-deterministic, and the whole claim of
        // this file is that the two arms saw identical bytes.
        const withoutRoute = yield* reader.readSpans(
          question.question,
          questionDate,
          withRoute.spans,
          {}
        )

        if (withRoute.spanHash !== withoutRoute.spanHash) {
          // Refused, not reported. A paired comparison over unpaired evidence
          // is worse than no comparison, because it looks like one.
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
            `${question.questionType.padEnd(26)} route ${(plan?.route ?? "—").padEnd(17)} ` +
            `${judgedRoute.correct ? "OK " : "   "} vs ${judgedPlain.correct ? "OK " : "   "}`
        )

        return {
          questionId: question.questionId,
          questionType: question.questionType,
          judgeTemplate: judgeTemplate(question),
          route: plan?.route ?? null,
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
        } as ReaderAbRow
      }).pipe(Effect.orDie),
    { concurrency }
  )

  const kept = rows.filter((row) => row !== null) as ReadonlyArray<ReaderAbRow>
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
    rows: kept
  }

  yield* Effect.promise(() => mkdir(outDir, { recursive: true }))
  const jsonPath = resolve(outDir, `reader-ab-${split}.json`)
  yield* Effect.promise(() => writeFile(jsonPath, JSON.stringify(file, null, 2), "utf8"))

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

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
