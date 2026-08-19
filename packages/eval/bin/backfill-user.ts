import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetName, type DatasetQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { loadDotEnv } from "@palimpsest/llm"
import {
  ClaimGraph,
  linkToUser,
  sessionKey,
  writeUserStats,
  type UserStats
} from "@palimpsest/palimpsest"
import { Effect, Layer } from "effect"
import { stratifiedSlice } from "../src/index.js"

/**
 * `backfill-user --prefix g2 [--slice 20] [--dataset s] [--uid a,b] [--users 2]`
 *
 * Gives an already-ingested user the `User` vertex and the `HAS_ENTITY` /
 * `HAS_SLOT` / `HAS_SESSION` edges that every per-user read now goes through.
 *
 * This is the one place left that runs the store-wide label scans on purpose:
 * a graph written before the `User` vertex existed is the only source for its
 * own entity and slot sets. That costs ~10 s per user at 26 users and still
 * works, which is exactly why the backfill has to happen *before* the next
 * ingest and not after. The alternative — re-keying to a fresh prefix — costs
 * the same wall clock and no LLM spend, but detaches every number in the
 * handoff from the keys it was measured on.
 *
 * Session turn counts come from the dataset file rather than from
 * `(Session)-[:HAS_TURN]->(Turn)`, which is a 19 s join and would be the
 * slowest thing here by an order of magnitude.
 */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const sliceSize = Number(arg("slice", "20"))
const dataset = arg("dataset", "s") as DatasetName
const prefix = arg("prefix", "")
const extraUids = arg("uid", "")
  .split(",")
  .map((uid) => uid.trim())
  .filter((uid) => uid !== "")
const userConcurrency = Number(arg("users", "2"))

const AppLive = ClaimGraph.Default.pipe(
  Layer.provideMerge(HydraClient.Default),
  Layer.provide(NodeHttpClient.layerUndici)
)

interface Target {
  readonly uid: string
  readonly question: DatasetQuestion
}

const program = Effect.gen(function* () {
  const hydra = yield* HydraClient
  const claimGraph = yield* ClaimGraph
  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  const byId = new Map(questions.map((question) => [question.questionId, question]))

  // The prefixed slice, plus any bare uids named on the command line — the demo
  // users were ingested without a prefix and need the same treatment.
  const targets: Array<Target> = [
    ...stratifiedSlice(questions, sliceSize).map((question) => ({
      uid: prefix === "" ? question.questionId : `${prefix}-${question.questionId}`,
      question
    })),
    ...extraUids.flatMap((uid): ReadonlyArray<Target> => {
      const question = byId.get(uid) ?? byId.get(uid.replace(/^.*?-/, ""))
      return question === undefined ? [] : [{ uid, question }]
    })
  ]
  const missingUids = extraUids.filter(
    (uid) => !targets.some((target) => target.uid === uid)
  )

  console.log(`dataset    ${dataset}`)
  console.log(`prefix     ${prefix === "" ? "(none)" : prefix}`)
  console.log(`users      ${targets.length}`)
  if (missingUids.length > 0) console.log(`unknown    ${missingUids.join(", ")}`)
  console.log("")

  const started = Date.now()
  let done = 0

  const results = yield* Effect.forEach(
    targets,
    (target) =>
      Effect.gen(function* () {
        const { uid, question } = target
        const t0 = Date.now()

        const scan = (label: string, property: string) =>
          hydra
            .query(`MATCH (n:${label}) WHERE n.uid = $uid RETURN n.${property} AS k`, { uid })
            .pipe(Effect.map((result) => result.rows.map((row) => String(row["k"]))))

        const ekeys = yield* scan("Entity", "ekey")
        const claims = yield* hydra
          .query("MATCH (n:Claim) WHERE n.uid = $uid RETURN count(*) AS c", { uid })
          .pipe(Effect.map((result) => Number(result.rows[0]?.["c"] ?? 0)))

        if (claims === 0 && ekeys.length === 0) {
          done++
          console.log(`[${String(done).padStart(2)}/${targets.length}] ${uid.padEnd(24)} SKIPPED  no claims in the graph`)
          return null
        }

        const tokens = yield* hydra
          .query("MATCH (n:Token) WHERE n.uid = $uid RETURN count(*) AS c", { uid })
          .pipe(Effect.map((result) => Number(result.rows[0]?.["c"] ?? 0)))
        const slotRows = yield* hydra
          .query(
            "MATCH (n:Slot) WHERE n.uid = $uid RETURN n.skey AS skey, n.n_claims AS n_claims",
            { uid }
          )
          .pipe(
            Effect.map((result) =>
              result.rows.map((row) => ({
                skey: String(row["skey"]),
                nClaims: Number(row["n_claims"] ?? 0)
              }))
            )
          )

        const contested = slotRows.filter((slot) => slot.nClaims >= 2)
        const supersessions = yield* claimGraph.countSupersessions(
          uid,
          contested.map((slot) => slot.skey)
        )

        // Turn counts come from the file, so `readSessions` stops needing the
        // HAS_TURN join. Merging by the same ids leaves every other property.
        yield* hydra.batchMerge(
          "Session",
          question.sessions.map((session) => ({
            key: sessionKey(uid, session.key),
            properties: { n_turns: session.turns.length }
          }))
        )

        yield* linkToUser(hydra, uid, "HAS_ENTITY", "Entity", ekeys)
        yield* linkToUser(hydra, uid, "HAS_SLOT", "Slot", slotRows.map((slot) => slot.skey))
        yield* linkToUser(
          hydra,
          uid,
          "HAS_SESSION",
          "Session",
          question.sessions.map((session) => sessionKey(uid, session.key))
        )

        const stats: UserStats = {
          claims,
          entities: ekeys.length,
          slots: slotRows.length,
          tokens,
          sessions: question.sessions.length,
          turns: question.sessions.reduce((n, session) => n + session.turns.length, 0),
          supersessions,
          contestedSlots: contested.length
        }
        yield* writeUserStats(hydra, uid, stats)

        done++
        console.log(
          `[${String(done).padStart(2)}/${targets.length}] ${uid.padEnd(24)} ` +
            `${String(stats.sessions).padStart(2)} sessions  ` +
            `${String(stats.claims).padStart(5)} claims  ` +
            `${String(stats.entities).padStart(5)} entities  ` +
            `${String(stats.slots).padStart(4)} slots  ` +
            `${String(stats.contestedSlots).padStart(3)} contested  ` +
            `${String(stats.supersessions).padStart(3)} supersessions  ` +
            `${((Date.now() - t0) / 1000).toFixed(1)} s`
        )
        return stats
      }),
    { concurrency: userConcurrency }
  )

  const written = results.filter((stats) => stats !== null)
  console.log("")
  console.log(`backfilled ${written.length}/${targets.length} users`)
  console.log(`claims     ${written.reduce((n, s) => n + s.claims, 0)}`)
  console.log(`entities   ${written.reduce((n, s) => n + s.entities, 0)}`)
  console.log(`wall clock ${((Date.now() - started) / 60_000).toFixed(1)} min`)
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
