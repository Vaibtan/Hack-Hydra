import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetName, type DatasetQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive, loadDotEnv } from "@palimpsest/llm"
import {
  claimKind,
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
import { benchmarkSlice, readRuntimeConfig, SPLIT_FILE, type SplitFile } from "../src/index.js"

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
/**
 * How many users to count edges on. Zero — off — by default.
 *
 * #23's box asks for edge counts and the honest options were always two: a
 * store-wide scan, which this engine refuses past 250 000 candidates of a
 * label, or a counter at write time, which `UserStats` does not keep and which
 * cannot be added mid-population without half the users having it. This is the
 * third: **count them exactly, on a sample, from source-driven `MSpaths` walks**
 * — the same read shape the product path uses, driven from keys the user's own
 * root already yields, and therefore indexed rather than scanned.
 *
 * It is a sample because it is not cheap: `HITS` alone is up to
 * `MAX_TOKENS_PER_CLAIM` = 24 paths per claim, which is tens of thousands of
 * rows and dozens of cursor pages for one user. Five users is minutes; two
 * hundred would be an hour of read load for a number that is a constant times
 * the claim count.
 *
 * **Never while an ingest is running.** Not because it scans a label — it does
 * not — but because it is real read load on a node whose object store is
 * already the bottleneck.
 */
const edgeSample = Number(arg("edges", "0"))

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

/**
 * One user's edges, counted exactly.
 *
 * Every walk is source-driven — from the user's `Claim.kind` constant, from the
 * entity keys the root yields, from the session keys it yields — so every one
 * is an indexed read and none of them is a label scan. `HAS_ENTITY`,
 * `HAS_SLOT`, `HAS_SESSION`, `HAS_TURN` and `SUPERSEDED_BY` are not walked at
 * all: the ingest wrote one per Entity, Slot, Session, Turn and supersession
 * respectively, and `UserStats` already holds those counts.
 *
 * `HAS_CHUNK` is the one edge nothing knows, because a chunk exists only for a
 * turn over HydraDB's 32 743-byte string cap. It is walked from the turn keys.
 */
const countEdges = (
  hydra: HydraClient,
  uid: string
): Effect.Effect<Readonly<Record<string, number>>, never> =>
  Effect.gen(function* () {
    const fromClaims = (relType: string) =>
      hydra
        .msPaths({
          sourceLabel: "Claim",
          sourceProperty: "kind",
          sourceValues: [claimKind(uid)],
          relTypes: [relType],
          relDirection: "outgoing",
          maxLen: 1
        })
        .pipe(
          Effect.map((paths) => paths.length),
          Effect.catchAll(() => Effect.succeed(-1))
        )

    // Sequential, not concurrent: this engine degrades under read concurrency
    // (6.0 -> 3.8 -> 2.9 statements/s at 3 -> 4 -> 8 writers, and reads behave
    // the same way), and nothing is waiting on this number.
    const evidence = yield* fromClaims("EVIDENCE")
    const mentions = yield* fromClaims("MENTIONS")
    const fills = yield* fromClaims("FILLS")
    const hits = yield* fromClaims("HITS")

    const entities = yield* readUserVertices(hydra, uid, "HAS_ENTITY").pipe(
      Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<Readonly<Record<string, unknown>>>))
    )
    const entityKeys = entities
      .map((row) => String(row["ekey"] ?? ""))
      .filter((key) => key !== "")
    const names =
      entityKeys.length === 0
        ? 0
        : yield* hydra
            .msPaths({
              sourceLabel: "Entity",
              sourceProperty: "ekey",
              sourceValues: entityKeys,
              relTypes: ["NAMES"],
              relDirection: "incoming",
              maxLen: 1
            })
            .pipe(
              Effect.map((paths) => paths.length),
              Effect.catchAll(() => Effect.succeed(-1))
            )

    return { EVIDENCE: evidence, MENTIONS: mentions, FILLS: fills, HITS: hits, NAMES: names }
  })

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

  // **Edges are counted on a sample, or not at all.**
  //
  // An earlier version of this file printed a formula, and that number went into
  // ops/hydradb/step-load-2026-08.md as a measured graph size. It was wrong by
  // roughly an order of magnitude: it charged two edges per claim, when
  // `ClaimGraph.writeSession` writes one `EVIDENCE`, one `FILLS`, one `MENTIONS`
  // per distinct mentioned entity, **one `HITS` per token** (up to
  // `MAX_TOKENS_PER_CLAIM` = 24) and one `NAMES` per entity-name token, plus
  // `Transcript` writes one `HAS_CHUNK` per spilled chunk.
  //
  // Two options were considered and rejected: a store-wide scan, which the
  // engine refuses past 250 000 candidates of a label, and a write-time counter
  // on `UserStats`, which cannot be added part-way through a population without
  // half the users having it. `--edges N` is the third — count them exactly on
  // N users with source-driven `MSpaths` walks, which are indexed reads, and
  // report the population total as `ratio x claims`, labelled as the
  // extrapolation it is.

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

  // Which runtime this row was measured on. A step-load row taken with the read
  // cache off (the ingest phase) and one taken with it on (the eval phase) are
  // not the same measurement — 11 397 ms cold against 68 ms warm — so the row
  // carries the hash of the configuration it came from.
  const runtimeConfig = readRuntimeConfig()
  console.log(`prefix        ${prefix}`)
  console.log(
    runtimeConfig.sha256 === null
      ? `runtime       (unavailable: ${runtimeConfig.reason})`
      : `runtime       ${runtimeConfig.sha256}
` +
        `              read-cache ${runtimeConfig.readCacheEnabled ? "on" : "off"}, ` +
        `query-cap ${runtimeConfig.queryRuntimeMs} ms, ` +
        `mem-limit ${(runtimeConfig.memoryLimitBytes / 1024 ** 3).toFixed(1)} GiB`
  )
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

  // ---- edges, on a sample -----------------------------------------------
  let edgeLine = "edges         not counted (pass --edges N to sample N users)"
  let edgeTableCell = "not counted"
  if (edgeSample > 0) {
    const sample = complete.slice(0, edgeSample)
    const counted = yield* Effect.forEach(
      sample,
      (row) =>
        countEdges(hydra, uidFor(row.question.questionId)).pipe(
          Effect.map((edges) => ({ row, edges }))
        ),
      { concurrency: 1 }
    )
    let perClaim = 0
    let sampledClaims = 0
    let sampledEdges = 0
    for (const { row, edges } of counted) {
      // The per-user edges the walks did not have to make: the ingest wrote one
      // per Entity, Slot, Session, Turn and supersession.
      const known =
        row.stats!.entities +
        row.stats!.slots +
        row.stats!.sessions +
        row.stats!.turns +
        row.stats!.supersessions
      const walked = Object.values(edges).reduce((n, v) => n + Math.max(0, v), 0)
      const refused = Object.entries(edges).filter(([, v]) => v < 0)
      sampledClaims += row.stats!.claims
      sampledEdges += known + walked
      console.log(
        `  edges ${uidFor(row.question.questionId).padEnd(22)} ` +
          `${String(known + walked).padStart(7)} total  ` +
          Object.entries(edges)
            .map(([name, n]) => `${name} ${n < 0 ? "refused" : n}`)
            .join("  ") +
          `  root+turns+supersede ${known}` +
          (refused.length === 0 ? "" : `  (${refused.length} walk(s) refused)`)
      )
    }
    perClaim = sampledClaims === 0 ? 0 : sampledEdges / sampledClaims
    // Extrapolated and labelled as such. The ratio is the measurement; the
    // population total is the ratio times a claim count, and saying otherwise
    // would repeat the mistake the corrected table above records.
    const estimate = Math.round(perClaim * total.claims)
    edgeLine =
      `edges         ${sampledEdges} exact over ${sample.length} user(s) ` +
      `(${perClaim.toFixed(2)} per claim); ~${estimate} across the population, extrapolated`
    edgeTableCell = `~${estimate} (${perClaim.toFixed(2)}/claim, ${sample.length}-user sample)`
  }
  console.log(edgeLine)
  console.log(
    `warm ask      graphMs p50 ${median(graphMs)} ms, askMs p50 ${median(askMs)} ms ` +
      `over ${graphMs.length} dev questions`
  )
  console.log(`cold ask      graphMs p50 ${median(coldGraphMs)} ms (first ask on an unread user)`)
  console.log("")
  console.log(
    `| ${complete.length} | ${total.sessions} | >=${vertices} | ${edgeTableCell} | ${total.claims} | ` +
      `${median(graphMs)} ms | ${median(askMs)} ms | ${median(coldGraphMs)} ms |`
  )
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
