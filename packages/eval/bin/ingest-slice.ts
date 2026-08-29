import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetName } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { Llm, LlmLive, loadDotEnv } from "@palimpsest/llm"
import { ClaimGraph, Ingest, Supersede, Transcript, readUserStats } from "@palimpsest/palimpsest"
import { Effect, Layer, Option } from "effect"
import { benchmarkSlice } from "../src/index.js"

/**
 * `ingest-slice --slice 20 [--dataset s] [--users 3] [--prefix g2] [--skip-existing]`
 *
 * Ingests the deterministic stratified slice, so the retrieval gate measures on
 * the same questions every time. Users run concurrently; sessions within a user
 * are written in order. Ingest is idempotent, so re-running is a cheap no-op.
 *
 * `--prefix` re-keys every user, which is how a clean graph is obtained after an
 * extraction-prompt change (the graph is additive and deletes are impractical).
 *
 * `--skip-existing` is what makes a *step load* — 20, then 60, then 200 — cost
 * only the users each step adds. Idempotent is not the same as free: every
 * earlier user's ~4 000 vertices and ~12 000 edges would be re-`MERGE`d, which
 * is minutes of writes per step and pointless load on the node the step is
 * meant to be measuring. The check is one ~100 ms read by id of the `User`
 * root: a user whose stored `n_sessions` already equals the question's session
 * count finished its ingest, because the counts are written last.
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
const skipExisting = process.argv.includes("--skip-existing")
/**
 * How many times a user may be re-attempted after a *capacity* failure.
 *
 * A 30 s runtime refusal or a lost writer lease is a statement about the node
 * at that moment, not about the user, and the whole user is lost to it — tens
 * of correct writes and, on a cache miss, real money. `ingestUser` is
 * idempotent, so a retry re-`MERGE`s what landed and continues; the pause is
 * there so the retry does not join the same pile-up that caused the refusal.
 * Parse, schema and identity failures are not retried: those are the same
 * answer every time.
 */
const retries = Number(arg("retries", "1"))
const RETRY_PAUSE_MS = 30_000

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
  const hydra = yield* HydraClient
  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  const slice = benchmarkSlice(questions, sliceSize)

  console.log(`dataset    ${dataset}`)
  console.log(`slice      ${slice.length} questions, ${slice.reduce((n, q) => n + q.sessions.length, 0)} sessions`)
  console.log(`prefix     ${prefix === "" ? "(none)" : prefix}`)
  console.log(`existing   ${skipExisting ? "skipped" : "re-merged"}`)
  console.log("")

  const started = Date.now()
  let done = 0
  let skipped = 0
  const reportsOrNull = yield* Effect.forEach(
    slice,
    (question) =>
      Effect.gen(function* () {
        const uid = uidFor(question.questionId, prefix)
        if (skipExisting) {
          // Not wrapped in `either`: a failed read by id means the node is
          // unavailable or read-only, and pushing 200 users through that is
          // worse than stopping.
          const stored = yield* readUserStats(hydra, uid)
          if (Option.isSome(stored) && stored.value.sessions === question.sessions.length) {
            done++
            skipped++
            console.log(
              `[${String(done).padStart(3)}/${slice.length}] ${uid.padEnd(22)} ` +
                `${String(stored.value.sessions).padStart(2)} sessions  already ingested`
            )
            return null
          }
        }
        // One user's failure must not discard the rest of the run: a slice is
        // an hour of API calls and the cache only helps if the process lives
        // long enough to write it.
        let outcome = yield* ingest.ingestUser(uid, question).pipe(Effect.either)
        for (let attempt = 0; attempt < retries && outcome._tag === "Left"; attempt++) {
          const tag = outcome.left._tag
          if (tag !== "HydraLimitError" && tag !== "HydraUnavailable" && tag !== "HydraEngineError") {
            break
          }
          console.log(
            `     ${uid.padEnd(22)} retrying after ${outcome.left.message.slice(0, 80)}`
          )
          yield* Effect.sleep(RETRY_PAUSE_MS)
          outcome = yield* ingest.ingestUser(uid, question).pipe(Effect.either)
        }
        done++
        if (outcome._tag === "Left") {
          // The statement, not just the message: a 30 s runtime refusal is
          // useless without knowing which read or write hit it, and the error
          // has carried the query all along.
          const failure = outcome.left as { message: string; query?: string }
          console.log(
            `[${String(done).padStart(3)}/${slice.length}] ${uid.padEnd(22)} FAILED  ${failure.message}` +
              (failure.query === undefined ? "" : `
${" ".repeat(10)}query: ${failure.query.slice(0, 300)}`)
          )
          return null
        }
        const report = outcome.right
        console.log(
          `[${String(done).padStart(3)}/${slice.length}] ${uid.padEnd(22)} ` +
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
  console.log(`ingested   ${reports.length} users this run`)
  console.log(`skipped    ${skipped} already present`)
  console.log(`failed     ${slice.length - reports.length - skipped} users`)
  console.log(`claims     ${reports.reduce((n, r) => n + r.stats.claims, 0)}`)
  console.log(`contested  ${reports.reduce((n, r) => n + r.stats.contestedSlots, 0)} slots`)
  console.log(`supersede  ${reports.reduce((n, r) => n + r.supersessions.edges, 0)} edges`)
  console.log(`llm calls  ${usage.calls} live, ${usage.cacheHits} from cache`)
  console.log(`cost       $${(yield* llm.costUsd).toFixed(4)}`)
  console.log(`wall clock ${((Date.now() - started) / 60_000).toFixed(1)} min`)
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
