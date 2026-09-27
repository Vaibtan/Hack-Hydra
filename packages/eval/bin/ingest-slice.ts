import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, parseDatasetName } from "@palimpsest/dataset"
import { HydraMemory, HydraMemoryLive } from "@palimpsest/hydra"
import { Llm, LlmLive, loadDotEnv } from "@palimpsest/llm"
import { ClaimGraph, Ingest, Supersede, Transcript, readUserStats } from "@palimpsest/palimpsest"
import { Effect, Layer, Option, Schema } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { benchmarkSlice, SPLIT_FILE, SplitFile } from "../src/index.js"

/** `ingest-slice --slice 20 [--dataset s] [--users 3] [--prefix g2] [--skip-existing] [--split dev|test] [--retries 1]` */
loadDotEnv()

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

const sliceSize = Number(arg("slice", "20"))
const dataset = parseDatasetName(arg("dataset", "s"))
const userConcurrency = Number(arg("users", "3"))
const prefix = arg("prefix", "")
const skipExisting = process.argv.includes("--skip-existing")
const retries = Number(arg("retries", "1"))
const splitName = arg("split", "")
const stopFile = arg("stop-file", "")
const RETRY_PAUSE_MS = 30_000

export const uidFor = (questionId: string, tag: string): string =>
  tag === "" ? questionId : `${tag}-${questionId}`

const AppLive = Ingest.layer.pipe(
  Layer.provideMerge(Transcript.layer),
  Layer.provideMerge(ClaimGraph.layer),
  Layer.provideMerge(Supersede.layer),
  Layer.provideMerge(HydraMemoryLive),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  const ingest = yield* Ingest
  const llm = yield* Llm
  const hydra = yield* HydraMemory
  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  const population = benchmarkSlice(questions, sliceSize)
  let slice = population
  if (splitName !== "") {
    if (splitName !== "dev" && splitName !== "test") {
      console.error(`--split must be dev or test, not ${JSON.stringify(splitName)}`)
      return yield* Effect.sync(() => process.exit(2))
    }
    const path = resolve(workspaceRoot(), SPLIT_FILE)
    if (!existsSync(path)) {
      console.error(`--split ${splitName} needs ${SPLIT_FILE}; run \`pnpm splits\` first`)
      return yield* Effect.sync(() => process.exit(2))
    }
    const file = Schema.decodeUnknownSync(SplitFile)(JSON.parse(readFileSync(path, "utf8")))
    const wanted = new Set(splitName === "dev" ? file.dev : file.test)
    slice = population.filter((question) => wanted.has(question.questionId))
    if (slice.length !== wanted.size) {
      console.error(
        `${SPLIT_FILE} names ${wanted.size} ${splitName} questions but benchmarkSlice(${sliceSize}) ` +
          `holds ${slice.length} of them`
      )
      return yield* Effect.sync(() => process.exit(2))
    }
  }

  console.log(`dataset    ${dataset}`)
  console.log(`split      ${splitName === "" ? "(whole population)" : splitName}`)
  console.log(`slice      ${slice.length} questions, ${slice.reduce((n, q) => n + q.sessions.length, 0)} sessions`)
  console.log(`prefix     ${prefix === "" ? "(none)" : prefix}`)
  console.log(`existing   ${skipExisting ? "skipped" : "re-merged"}`)
  console.log("")

  const started = Date.now()
  let done = 0
  let skipped = 0
  let deferred = 0
  const reportsOrNull = yield* Effect.forEach(
    slice,
    (question) =>
      Effect.gen(function* () {
        const uid = uidFor(question.questionId, prefix)
        if (skipExisting) {
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
        if (stopFile !== "" && existsSync(stopFile)) {
          done++
          deferred++
          console.log(`[${String(done).padStart(3)}/${slice.length}] ${uid.padEnd(22)} deferred: stop requested`)
          return null
        }
        let outcome = yield* ingest.ingestUser(uid, question).pipe(Effect.result)
        for (let attempt = 0; attempt < retries && outcome._tag === "Failure"; attempt++) {
          const tag = outcome.failure._tag
          if (tag !== "HydraLimitError" && tag !== "HydraUnavailable" && tag !== "HydraEngineError") {
            break
          }
          console.log(
            `     ${uid.padEnd(22)} retrying after ${outcome.failure.message.slice(0, 80)}`
          )
          yield* Effect.sleep(RETRY_PAUSE_MS)
          outcome = yield* ingest.ingestUser(uid, question).pipe(Effect.result)
        }
        done++
        if (outcome._tag === "Failure") {
          const failure = outcome.failure
          const query = Schema.is(Schema.Struct({ query: Schema.String }))(failure)
            ? failure.query
            : undefined
          console.log(
            `[${String(done).padStart(3)}/${slice.length}] ${uid.padEnd(22)} FAILED  ${failure.message}` +
              (query === undefined ? "" : `
${" ".repeat(10)}query: ${query.slice(0, 300)}`)
          )
          return null
        }
        const report = outcome.success
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
  console.log(`deferred   ${deferred} users (stop file present)`)
  console.log(`failed     ${slice.length - reports.length - skipped - deferred} users`)
  console.log(`claims     ${reports.reduce((n, r) => n + r.stats.claims, 0)}`)
  console.log(`contested  ${reports.reduce((n, r) => n + r.stats.contestedSlots, 0)} slots`)
  console.log(`supersede  ${reports.reduce((n, r) => n + r.supersessions.edges, 0)} edges`)
  console.log(`llm calls  ${usage.calls} live, ${usage.cacheHits} from cache`)
  console.log(`cost       $${(yield* llm.costUsd).toFixed(4)}`)
  console.log(`wall clock ${((Date.now() - started) / 60_000).toFixed(1)} min`)
})

Effect.runPromise(Effect.provide(program, AppLive)).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
