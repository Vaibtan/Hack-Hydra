import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetName } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { Llm, LlmLive, loadDotEnv, verifyModelsOrExit } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { ClaimGraph } from "../src/ClaimGraph.js"
import { Ingest } from "../src/Ingest.js"
import { Supersede } from "../src/Supersede.js"
import { Transcript } from "../src/Transcript.js"

/** `ingest --uid <question_id> [--dataset s|oracle] [--users N] [--concurrency N] [--reset]` */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const uid = arg("uid", "")
const asUid = arg("as", "")
const dataset = arg("dataset", "s") as DatasetName
const concurrency = Number(arg("concurrency", "4"))
const reset = process.argv.includes("--reset")

const AppLive = Ingest.Default.pipe(
  Layer.provideMerge(Transcript.Default),
  Layer.provideMerge(ClaimGraph.Default),
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  yield* verifyModelsOrExit({ quiet: true })
  const ingest = yield* Ingest
  const llm = yield* Llm
  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)

  const targets = uid === "" ? [] : questions.filter((q) => q.questionId === uid)
  if (targets.length === 0) {
    console.error(`no question with id ${uid} in ${dataset}`)
    return yield* Effect.sync(() => process.exit(2))
  }

  console.log(`model      ${llm.model}`)
  console.log(`dataset    ${dataset}`)
  console.log("")

  const started = Date.now()
  yield* Effect.forEach(
    targets,
    (question) =>
      Effect.gen(function* () {
        const target = asUid === "" ? question.questionId : asUid
        if (reset) yield* ingest.removeUser(target)
        const report = yield* ingest.ingestUser(target, question, {
          onSession: (step) => {
            process.stdout.write(
              `\r  session ${String(step.sessionOrd).padStart(3)}/${question.sessions.length}` +
                `  ${String(step.claims).padStart(4)} claims  ${step.cached ? "cached" : "live  "}   `
            )
          }
        })
        process.stdout.write(`\r${" ".repeat(72)}\r`)

        const s = report.stats
        console.log(`uid        ${target}  (${question.questionType})`)
        console.log(`question   ${question.question}`)
        console.log(
          `graph      ${s.sessions} sessions, ${s.turns} turns, ${s.claims} claims, ` +
            `${s.entities} entities, ${s.slots} slots, ${s.tokens} tokens`
        )
        console.log(`contested  ${s.contestedSlots} slots hold >= 2 claims`)
        console.log(
          `supersede  ${report.supersessions.edges} edges over ` +
            `${report.supersessions.slotsContested} contested slots ` +
            `(${report.supersessions.cachedDecisions} decisions cached); graph holds ${s.supersessions}`
        )
        console.log(
          `dropped    ${report.sessions.reduce((n, x) => n + x.dropped, 0)} spans; ` +
            `${report.sessions.filter((x) => x.cached).length}/${report.sessions.length} sessions from cache`
        )
      }),
    { concurrency }
  )

  const usage = yield* llm.usage
  console.log("")
  console.log(`llm calls  ${usage.calls} live, ${usage.cacheHits} from cache`)
  console.log(`tokens     ${usage.inputTokens} in, ${usage.outputTokens} out`)
  console.log(`cost       $${(yield* llm.costUsd).toFixed(4)}`)
  console.log(`wall clock ${((Date.now() - started) / 1000).toFixed(1)} s`)
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
