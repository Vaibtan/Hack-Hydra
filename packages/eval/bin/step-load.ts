import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, parseDatasetName, type DatasetQuestion } from "@palimpsest/dataset"
import { HydraMemory, HydraMemoryLive, type MemoryProperties } from "@palimpsest/hydra"
import { LlmLive, loadDotEnv } from "@palimpsest/llm"
import {
  claimKind,
  ClaimGraph,
  LegacyG3Adapter,
  Supersede,
  Transcript,
  readUserStats,
  readUserVertices,
  type UserStats
} from "@palimpsest/palimpsest"
import { Effect, Layer, Option, Schema } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { benchmarkSlice, readRuntimeConfig, SPLIT_FILE, SplitFile } from "../src/index.js"

/** `step-load --slice 60 [--prefix g3] [--asks 5] [--edges N]` — one row of the step-load curve, with no store-wide scan. */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const sliceSize = Number(arg("slice", "20"))
const dataset = parseDatasetName(arg("dataset", "s"))
const prefix = arg("prefix", "g3")
const askCount = Number(arg("asks", "5"))
// Edge sample size; see docs/design-rationale.md ("Edge sampling"). Never while an ingest runs.
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

const AppLive = LegacyG3Adapter.layer.pipe(
  Layer.provideMerge(Supersede.layer),
  Layer.provideMerge(Transcript.layer),
  Layer.provideMerge(ClaimGraph.layer),
  Layer.provideMerge(HydraMemoryLive),
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

const countEdges = (
  hydra: HydraMemory,
  uid: string
): Effect.Effect<Readonly<Record<string, number>>, never> =>
  Effect.gen(function* () {
    const fromClaims = (relType: string) =>
      hydra
        .discoverPaths({
          sourceLabel: "Claim",
          sourceProperty: "kind",
          sourceValues: [claimKind(uid)],
          relTypes: [relType],
          relDirection: "outgoing",
          maxLen: 1
        })
        .pipe(
          Effect.map(({ paths }) => paths.length),
          Effect.catch(() => Effect.succeed(-1))
        )

    const evidence = yield* fromClaims("EVIDENCE")
    const mentions = yield* fromClaims("MENTIONS")
    const fills = yield* fromClaims("FILLS")
    const hits = yield* fromClaims("HITS")

    const entities = yield* readUserVertices(hydra, uid, "HAS_ENTITY").pipe(
      Effect.catch(() => Effect.succeed(new Array<MemoryProperties>()))
    )
    const entityKeys = entities
      .map((row) => String(row["ekey"] ?? ""))
      .filter((key) => key !== "")
    const names =
      entityKeys.length === 0
        ? 0
        : yield* hydra
            .discoverPaths({
              sourceLabel: "Entity",
              sourceProperty: "ekey",
              sourceValues: entityKeys,
              relTypes: ["NAMES"],
              relDirection: "incoming",
              maxLen: 1
            })
            .pipe(
              Effect.map(({ paths }) => paths.length),
              Effect.catch(() => Effect.succeed(-1))
            )

    return { EVIDENCE: evidence, MENTIONS: mentions, FILLS: fills, HITS: hits, NAMES: names }
  })

const program = Effect.gen(function* () {
  const hydra = yield* HydraMemory
  const legacy = yield* LegacyG3Adapter
  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  const population = benchmarkSlice(questions, sliceSize)

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

  const vertices =
    total.sessions + total.turns + total.claims + total.entities + total.slots + total.tokens +
    present.length

  const splitPath = resolve(workspaceRoot(), SPLIT_FILE)
  const dev: ReadonlyArray<string> = existsSync(splitPath)
    ? Schema.decodeUnknownSync(SplitFile)(JSON.parse(readFileSync(splitPath, "utf8"))).dev
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
    yield* Effect.all(
      [
        readUserVertices(hydra, uid, "HAS_ENTITY"),
        readUserVertices(hydra, uid, "HAS_SLOT"),
        readUserVertices(hydra, uid, "HAS_SESSION")
      ],
      { concurrency: 3 }
    )
    const cold = yield* legacy.retrieve.ask(uid, question.question, {
      questionDate: question.questionDate.raw
    })
    coldGraphMs.push(cold.timings.graphMs)
    const warm = yield* legacy.retrieve.ask(uid, question.question, {
      questionDate: question.questionDate.raw
    })
    graphMs.push(warm.timings.graphMs)
    askMs.push(warm.timings.askMs)
  }

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

Effect.runPromise(Effect.provide(program, AppLive)).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
