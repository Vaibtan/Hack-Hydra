import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetName, type DatasetQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive, loadDotEnv } from "@palimpsest/llm"
import {
  ClaimGraph,
  Retrieve,
  Supersede,
  readUserStats,
  readUserVertices,
  type UserStats
} from "@palimpsest/palimpsest"
import { Effect, Layer, Option } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { benchmarkSlice, SPLIT_FILE, type SplitFile } from "../src/index.js"

/**
 * `step-load --slice 60 [--prefix g3] [--asks 5]`
 *
 * One row of the step-load curve: how big the graph is after this step, and
 * how long a warm ask's HydraDB stages take on it.
 *
 * Both numbers are read **without a store-wide scan**, which is not a detail:
 * `MATCH (n:Token) RETURN count(*)` took 15.8 s of engine time at 27 000
 * Tokens, and the four users being ingested at that moment all died on the
 * engine's 30 s query cap. The size comes from summing each user's own `User`
 * vertex — every count on it was written by the ingest that produced it — and
 * every read here is by id or an `MSpaths` hop from one.
 *
 * `docker stats` is the operator's half; this is the graph's half.
 */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const sliceSize = Number(arg("slice", "20"))
const dataset = arg("dataset", "s") as DatasetName
const prefix = arg("prefix", "g3")
const askCount = Number(arg("asks", "5"))

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

const uidFor = (questionId: string): string =>
  prefix === "" ? questionId : `${prefix}-${questionId}`

const AppLive = Retrieve.Default.pipe(
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(ClaimGraph.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const EMPTY: UserStats = {
  claims: 0,
  entities: 0,
  slots: 0,
  tokens: 0,
  sessions: 0,
  turns: 0,
  supersessions: 0,
  contestedSlots: 0
}

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

const program = Effect.gen(function* () {
  const hydra = yield* HydraClient
  const retrieve = yield* Retrieve
  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  const population = benchmarkSlice(questions, sliceSize)

  // ---- size ------------------------------------------------------------
  const perUser = yield* Effect.forEach(
    population,
    (question: DatasetQuestion) =>
      readUserStats(hydra, uidFor(question.questionId)).pipe(
        Effect.map((stats) => ({ question, stats: Option.getOrNull(stats) }))
      ),
    { concurrency: 8 }
  )
  const present = perUser.filter((row) => row.stats !== null)
  const complete = present.filter((row) => row.stats!.sessions === row.question.sessions.length)
  const total = present.reduce<UserStats>(
    (sum, row) => ({
      claims: sum.claims + row.stats!.claims,
      entities: sum.entities + row.stats!.entities,
      slots: sum.slots + row.stats!.slots,
      tokens: sum.tokens + row.stats!.tokens,
      sessions: sum.sessions + row.stats!.sessions,
      turns: sum.turns + row.stats!.turns,
      supersessions: sum.supersessions + row.stats!.supersessions,
      contestedSlots: sum.contestedSlots + row.stats!.contestedSlots
    }),
    EMPTY
  )

  // Vertices, from the counts the ingest itself wrote. `TurnChunk` is the one
  // label not represented: it exists only for turns over HydraDB's 32 743-byte
  // string cap and nothing counts them, so this is a floor, not an exact count.
  const vertices =
    total.sessions + total.turns + total.claims + total.entities + total.slots + total.tokens +
    present.length

  // **Edges are deliberately not reported.**
  //
  // An earlier version of this file printed a number, and that number went into
  // ops/hydradb/step-load-2026-08.md as a measured graph size. It was wrong by
  // roughly an order of magnitude: it charged two edges per claim, when
  // `ClaimGraph.writeSession` writes one `EVIDENCE`, one `FILLS`, one `MENTIONS`
  // per distinct mentioned entity, **one `HITS` per token** (up to
  // `MAX_TOKENS_PER_CLAIM` = 24) and one `NAMES` per entity-name token, plus
  // `Transcript` writes one `HAS_CHUNK` per spilled chunk.
  //
  // The honest options are to count them — which needs a store-wide scan the
  // engine refuses past 250 000 candidates of a label — or to record them at
  // write time, which `UserStats` does not. So this prints the components it
  // actually knows and leaves the total to whoever adds the counter.

  // ---- warm ask latency -------------------------------------------------
  const splitPath = resolve(workspaceRoot(), SPLIT_FILE)
  const dev: ReadonlyArray<string> = existsSync(splitPath)
    ? (JSON.parse(readFileSync(splitPath, "utf8")) as SplitFile).dev
    : []
  const devSet = new Set(dev)
  const subjects = complete
    .filter((row) => devSet.size === 0 || devSet.has(row.question.questionId))
    .slice(0, askCount)

  const graphMs: Array<number> = []
  const askMs: Array<number> = []
  const coldGraphMs: Array<number> = []
  for (const { question } of subjects) {
    const uid = uidFor(question.questionId)
    // `pnpm warm` touches the root and its fan-out; it does **not** warm the
    // convergence walk, and on this profile that is the whole cost — a cold
    // block is an object-store round trip, not a page fault. So the first ask
    // is measured and reported as the cold number rather than discarded.
    yield* Effect.all(
      [
        readUserVertices(hydra, uid, "HAS_ENTITY"),
        readUserVertices(hydra, uid, "HAS_SLOT"),
        readUserVertices(hydra, uid, "HAS_SESSION")
      ],
      { concurrency: 3 }
    )
    const cold = yield* retrieve.ask(uid, question.question, {
      questionDate: question.questionDate.raw
    })
    coldGraphMs.push(cold.timings.graphMs)
    const warm = yield* retrieve.ask(uid, question.question, {
      questionDate: question.questionDate.raw
    })
    graphMs.push(warm.timings.graphMs)
    askMs.push(warm.timings.askMs)
  }

  console.log(`prefix        ${prefix}`)
  console.log(`population    ${population.length} questions`)
  console.log(`ingested      ${complete.length} complete, ${present.length - complete.length} partial`)
  console.log(`sessions      ${total.sessions}`)
  console.log(`turns         ${total.turns}`)
  console.log(`claims        ${total.claims}`)
  console.log(`entities      ${total.entities}`)
  console.log(`slots         ${total.slots}   (${total.contestedSlots} contested)`)
  console.log(`tokens        ${total.tokens}`)
  console.log(`supersessions ${total.supersessions}`)
  console.log(`vertices      >=${vertices}   (TurnChunk not counted)`)
  console.log(`edges         not derivable from the stored counts - see the comment above`)
  console.log(
    `warm ask      graphMs p50 ${median(graphMs)} ms, askMs p50 ${median(askMs)} ms ` +
      `over ${graphMs.length} dev questions`
  )
  console.log(`cold ask      graphMs p50 ${median(coldGraphMs)} ms (first ask on an unread user)`)
  console.log("")
  console.log(
    `| ${complete.length} | ${total.sessions} | >=${vertices} | ${total.claims} | ` +
      `${median(graphMs)} ms | ${median(askMs)} ms | ${median(coldGraphMs)} ms |`
  )
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
