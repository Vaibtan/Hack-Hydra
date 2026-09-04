import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetName } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { Llm, LlmLive, loadDotEnv } from "@palimpsest/llm"
import { ClaimGraph, Ingest, Supersede, Transcript, readUserStats } from "@palimpsest/palimpsest"
import { Effect, Layer, Option } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { benchmarkSlice, SPLIT_FILE, type SplitFile } from "../src/index.js"

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
const dataset = arg("dataset", "s") as DatasetName
const userConcurrency = Number(arg("users", "3"))
const prefix = arg("prefix", "")
const skipExisting = process.argv.includes("--skip-existing")
const retries = Number(arg("retries", "1"))
const splitName = arg("split", "")
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
    const file = JSON.parse(readFileSync(path, "utf8")) as SplitFile
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
