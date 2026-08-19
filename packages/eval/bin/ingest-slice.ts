import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetName } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { Llm, LlmLive, loadDotEnv, usageCostUsd } from "@palimpsest/llm"
import { ClaimGraph, Ingest, Supersede, Transcript } from "@palimpsest/palimpsest"
import { Effect, Layer } from "effect"
import { stratifiedSlice } from "../src/index.js"

/**
 * `ingest-slice --slice 20 [--dataset s] [--users 3] [--prefix g2]`
 *
 * Ingests the deterministic stratified slice, so the retrieval gate measures on
 * the same questions every time. Users run concurrently; sessions within a user
 * are written in order. Ingest is idempotent, so re-running is a cheap no-op.
 *
 * `--prefix` re-keys every user, which is how a clean graph is obtained after an
 * extraction-prompt change (the graph is additive and deletes are impractical).
 */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const sliceSize = Number(arg("slice", "20"))
const dataset = arg("dataset", "s") as DatasetName
const userConcurrency = Number(arg("users", "3"))
const prefix = arg("prefix", "")

export const uidFor = (questionId: string, tag: string): string =>
  tag === "" ? questionId : `${tag}-${questionId}`

const AppLive = Ingest.Default.pipe(
  Layer.provideMerge(Transcript.Default),
  Layer.provideMerge(ClaimGraph.Default),
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  const ingest = yield* Ingest
  const llm = yield* Llm
  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  const slice = stratifiedSlice(questions, sliceSize)

  console.log(`dataset    ${dataset}`)
  console.log(`slice      ${slice.length} questions, ${slice.reduce((n, q) => n + q.sessions.length, 0)} sessions`)
  console.log(`prefix     ${prefix === "" ? "(none)" : prefix}`)
  console.log("")

  const started = Date.now()
  let done = 0
  const reportsOrNull = yield* Effect.forEach(
    slice,
    (question) =>
      Effect.gen(function* () {
        const uid = uidFor(question.questionId, prefix)
        // One user's failure must not discard the rest of the run: a slice is
        // an hour of API calls and the cache only helps if the process lives
        // long enough to write it.
        const outcome = yield* ingest.ingestUser(uid, question).pipe(Effect.either)
        done++
        if (outcome._tag === "Left") {
          console.log(`[${String(done).padStart(2)}/${slice.length}] ${uid.padEnd(22)} FAILED  ${outcome.left.message}`)
          return null
        }
        const report = outcome.right
        console.log(
          `[${String(done).padStart(2)}/${slice.length}] ${uid.padEnd(22)} ` +
            `${String(report.stats.sessions).padStart(2)} sessions  ` +
            `${String(report.stats.claims).padStart(5)} claims  ` +
            `${String(report.stats.contestedSlots).padStart(3)} contested  ` +
            `${String(report.supersessions.edges).padStart(3)} supersessions  ` +
            `${question.questionType}`
        )
        return report
      }),
    { concurrency: userConcurrency }
  )

  const reports = reportsOrNull.filter((report) => report !== null)
  const usage = yield* llm.usage
  console.log("")
  console.log(`ingested   ${reports.length}/${slice.length} users`)
  console.log(`claims     ${reports.reduce((n, r) => n + r.stats.claims, 0)}`)
  console.log(`contested  ${reports.reduce((n, r) => n + r.stats.contestedSlots, 0)} slots`)
  console.log(`supersede  ${reports.reduce((n, r) => n + r.supersessions.edges, 0)} edges`)
  console.log(`llm calls  ${usage.calls} live, ${usage.cacheHits} from cache`)
  console.log(`cost       $${usageCostUsd(llm.model, usage).toFixed(4)}`)
  console.log(`wall clock ${((Date.now() - started) / 60_000).toFixed(1)} min`)
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
