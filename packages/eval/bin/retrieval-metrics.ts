import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetName } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { Llm, LlmLive, loadDotEnv, usageCostUsd } from "@palimpsest/llm"
import { ClaimGraph, Retrieve, Supersede } from "@palimpsest/palimpsest"
import { Effect, Layer } from "effect"
import { gateByType, gateReport, scoreQuestion, stratifiedSlice } from "../src/index.js"

/**
 * `retrieval-metrics --slice 20 [--prefix g2] [--max-len 2] [--top-k 25] [--misses]`
 *
 * The day-3 gate: SessionRecall@K ≥ 85 % and false-abstention ≤ 10 % on the
 * answerable questions of the slice, plus abstention precision/recall on the
 * `_abs` ones. Every anchor call is cached, so a re-run is free and prints the
 * same numbers.
 */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const sliceSize = Number(arg("slice", "20"))
const dataset = arg("dataset", "s") as DatasetName
const prefix = arg("prefix", "g2")
const maxLen = Number(arg("max-len", "2"))
const topK = Number(arg("top-k", "25"))
const concurrency = Number(arg("concurrency", "4"))
const showMisses = process.argv.includes("--misses")

const uidFor = (questionId: string): string =>
  prefix === "" ? questionId : `${prefix}-${questionId}`

const pct = (value: number | null): string =>
  value === null ? "   n/a" : `${(value * 100).toFixed(1)} %`

const AppLive = Retrieve.Default.pipe(
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(ClaimGraph.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  const retrieve = yield* Retrieve
  const claimGraph = yield* ClaimGraph
  const llm = yield* Llm
  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  const slice = stratifiedSlice(questions, sliceSize)

  // A user with no claims would score as A1_no_anchors and be counted as a
  // false abstention — a missing ingest quietly reported as a retrieval
  // failure. Refuse to measure rather than publish a wrong number.
  const missing = yield* Effect.forEach(
    slice,
    (question) =>
      claimGraph
        .claimCount(uidFor(question.questionId))
        .pipe(Effect.map((claims) => (claims === 0 ? question.questionId : null))),
    { concurrency: 4 }
  )
  const notIngested = missing.filter((id) => id !== null)
  if (notIngested.length > 0) {
    console.error(`${notIngested.length} of ${slice.length} users have no claims in the graph:`)
    console.error(`  ${notIngested.join(", ")}`)
    console.error(`Run: pnpm ingest-slice --slice ${sliceSize} --dataset ${dataset} --prefix ${prefix}`)
    return yield* Effect.sync(() => process.exit(2))
  }

  console.log(`dataset      ${dataset}`)
  console.log(`slice        ${slice.length} questions   prefix ${prefix || "(none)"}`)
  console.log(`config       maxLen ${maxLen}, top-K ${topK}`)
  console.log("")

  const started = Date.now()
  const results = yield* Effect.forEach(
    slice,
    (question) =>
      Effect.gen(function* () {
        const t0 = Date.now()
        const result = yield* retrieve.ask(uidFor(question.questionId), question.question, {
          maxLen,
          topK
        })
        return scoreQuestion(question, result, Date.now() - t0)
      }),
    { concurrency }
  )
  const elapsed = (Date.now() - started) / 1000

  const overall = gateReport(results)

  console.log("by question type")
  console.log("  type                        n   SessionRecall   false-abst")
  for (const [type, group] of gateByType(results)) {
    console.log(
      `  ${type.padEnd(26)}${String(group.answerable).padStart(2)}` +
        `${pct(group.sessionRecall).padStart(16)}${pct(group.falseAbstention).padStart(13)}`
    )
  }
  console.log("")
  console.log(`answerable questions        ${overall.answerable}`)
  console.log(`SessionRecall@${topK}             ${pct(overall.sessionRecall)}`)
  console.log(`false-abstention rate       ${pct(overall.falseAbstention)}`)
  console.log(`abstention questions        ${overall.abstentionQuestions}`)
  console.log(`abstention recall           ${pct(overall.abstentionRecall)}`)
  console.log(`abstention precision        ${pct(overall.abstentionPrecision)}`)
  console.log(`ABSENT reasons              A1 ${overall.a1}, A2 ${overall.a2}`)
  console.log(`median latency              ${(overall.medianLatencyMs / 1000).toFixed(2)} s`)
  console.log("")

  const recallPass = overall.sessionRecall >= 0.85
  const abstPass = overall.falseAbstention <= 0.1
  console.log(`GATE  SessionRecall@${topK} >= 85 %:   ${pct(overall.sessionRecall)}  ${recallPass ? "PASS" : "FAIL"}`)
  console.log(`GATE  false-abstention <= 10 %:  ${pct(overall.falseAbstention)}  ${abstPass ? "PASS" : "FAIL"}`)
  console.log("")

  const usage = yield* llm.usage
  console.log(`anchors      ${(results.reduce((n, r) => n + r.anchorsResolved, 0) / results.length).toFixed(1)} resolved of ${(results.reduce((n, r) => n + r.anchorsAsked, 0) / results.length).toFixed(1)} asked, per question`)
  console.log(`evidence     ${(results.reduce((n, r) => n + r.evidence, 0) / results.length).toFixed(1)} claims per question`)
  console.log(`llm calls    ${usage.calls} live, ${usage.cacheHits} from cache`)
  console.log(`cost         $${usageCostUsd(llm.model, usage).toFixed(4)}`)
  console.log(`wall clock   ${elapsed.toFixed(1)} s`)

  if (showMisses) {
    console.log("")
    console.log("questions whose evidence missed every answer session")
    for (const result of results) {
      if (result.isAbstention || result.sessionHit) continue
      console.log(
        `  ${result.questionId}  ${result.questionType}  verdict ${result.verdict}` +
          `${result.reason === null ? "" : ` (${result.reason})`}  ` +
          `anchors ${result.anchorsResolved}/${result.anchorsAsked}  topconv ${result.topConvergence}`
      )
      console.log(`    wanted   ${result.answerSessions.join(", ")}`)
      console.log(`    got      ${result.evidenceSessions.slice(0, 6).join(", ")}`)
    }
  }
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
