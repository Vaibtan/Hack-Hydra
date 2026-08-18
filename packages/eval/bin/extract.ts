import { loadDataset, type DatasetName, type DatasetQuestion } from "@palimpsest/dataset"
import { Llm, LlmLive, loadDotEnv, usageCostUsd } from "@palimpsest/llm"
import { extractSession, mergeEntities, type ExtractedEntity, type SessionExtraction } from "@palimpsest/palimpsest"
import { Effect } from "effect"
import { byType, questionRecall, stratifiedSlice, summarise } from "../src/index.js"

/**
 * `extract --slice 20 [--dataset oracle|s] [--concurrency 6] [--misses]`
 *
 * The day-1 gate: extraction recall against `has_answer`. Every call is cached,
 * so re-running costs nothing and prints the same numbers.
 */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const sliceSize = Number(arg("slice", "20"))
const dataset = arg("dataset", "oracle") as DatasetName
const concurrency = Number(arg("concurrency", "6"))
const showMisses = process.argv.includes("--misses")

const pct = (value: number): string => `${(value * 100).toFixed(1)} %`

const extractQuestion = (question: DatasetQuestion) =>
  Effect.gen(function* () {
    // Sessions run in order because each one is prompted with the entities the
    // earlier ones established — that is what keeps canon keys stable.
    let known: ReadonlyArray<ExtractedEntity> = []
    const extractions: Array<SessionExtraction> = []
    for (const session of question.sessions) {
      const extraction = yield* extractSession(session, known)
      known = mergeEntities(known, extraction.claims)
      extractions.push(extraction)
    }
    return { question, extractions, entities: known }
  })

const program = Effect.gen(function* () {
  const llm = yield* Llm
  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  const slice = stratifiedSlice(questions, sliceSize)

  console.log(`model        ${llm.model}`)
  console.log(`dataset      ${dataset}`)
  console.log(`slice        ${slice.length} questions, ${slice.reduce((n, q) => n + q.sessions.length, 0)} sessions`)
  console.log(`cache        ${llm.cacheDir}`)
  console.log("")

  const started = Date.now()
  const outcomes = yield* Effect.forEach(slice, extractQuestion, { concurrency })
  const elapsed = (Date.now() - started) / 1000

  const results = outcomes.map(({ question, extractions }) => questionRecall(question, extractions))
  const overall = summarise(results)
  const usage = yield* llm.usage

  console.log("extraction recall vs has_answer, by question type")
  console.log("  type                        recall    turns   covered   claims   dropped")
  for (const [type, group] of byType(results)) {
    console.log(
      `  ${type.padEnd(26)}${pct(group.recall).padStart(7)}` +
        `${String(group.answerTurns).padStart(9)}${String(group.coveredTurns).padStart(10)}` +
        `${String(group.claims).padStart(9)}${String(group.dropped).padStart(10)}`
    )
  }
  console.log(
    `  ${"ALL".padEnd(26)}${pct(overall.recall).padStart(7)}` +
      `${String(overall.answerTurns).padStart(9)}${String(overall.coveredTurns).padStart(10)}` +
      `${String(overall.claims).padStart(9)}${String(overall.dropped).padStart(10)}`
  )
  console.log("")
  console.log(`GATE  extraction recall >= 90 %:  ${pct(overall.recall)}  ${overall.recall >= 0.9 ? "PASS" : "FAIL"}`)
  console.log("")

  const spanQuality = outcomes.flatMap((o) => o.extractions).flatMap((e) => e.claims)
  const normalised = spanQuality.filter((c) => c.located === "normalised").length
  const markdown = spanQuality.filter((c) => c.located === "markdown").length
  const withSlot = spanQuality.filter((c) => c.slot !== null).length
  const assistantClaims = spanQuality.filter((c) => c.speaker === "assistant").length
  const dated = spanQuality.filter((c) => c.tEvent > 0).length

  console.log(`claims        ${spanQuality.length}  (${assistantClaims} from assistant turns, ${withSlot} fill a slot, ${dated} dated)`)
  console.log(
    `spans         ${spanQuality.length - normalised - markdown} exact, ${normalised} whitespace-normalised, ` +
      `${markdown} markdown-normalised, ${overall.dropped} dropped`
  )
  console.log(`keywords      ${(spanQuality.reduce((n, c) => n + c.keywords.length, 0) / Math.max(1, spanQuality.length)).toFixed(1)} per claim`)
  console.log(`entities      ${(outcomes.reduce((n, o) => n + o.entities.length, 0) / Math.max(1, outcomes.length)).toFixed(1)} per user`)
  console.log("")
  console.log(`llm calls     ${usage.calls} live, ${usage.cacheHits} from cache`)
  console.log(`tokens        ${usage.inputTokens} in, ${usage.outputTokens} out`)
  console.log(`cost          $${usageCostUsd(llm.model, usage).toFixed(4)}`)
  console.log(`wall clock    ${elapsed.toFixed(1)} s`)

  if (showMisses) {
    console.log("")
    console.log("uncovered answer turns")
    for (const result of results) {
      for (const miss of result.misses) {
        console.log(`  ${result.questionId}  ${miss.sid}#${miss.turnIdx}  (${result.questionType})`)
      }
    }
  }
})

Effect.runPromise(Effect.provide(program, LlmLive()) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
