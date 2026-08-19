import { HydraClient, type HydraError } from "@palimpsest/hydra"
import { Effect, Option } from "effect"
import { userKey } from "./Keys.js"

/**
 * The `User` vertex: one root per history, and the reason every per-user read
 * in this package is an id-keyed read.
 *
 * HydraDB indexes exactly two things: a vertex by `{id: …}`, and the source
 * values `algo.MSpaths` is driven from. Everything else — including
 * `MATCH (n:Label) WHERE n.uid = $uid` — is a full scan of that label's
 * **store-wide** population, at roughly 75 µs per vertex. That is invisible at
 * one user and fatal at a hundred: counting one user's Claims cost 4.4 s at
 * 58 k Claims in the store and would cost ~19 s at the 500-user scale, over the
 * engine's 30 s cap, for a number the ingest already knew.
 *
 * So the numbers `stats` used to scan for are written here at the end of the
 * ingest that produced them, and the vertex sets it used to scan for hang off
 * the user as edges:
 *
 * ```
 * (User)-[:HAS_ENTITY]->(Entity)   (User)-[:HAS_SLOT]->(Slot)   (User)-[:HAS_SESSION]->(Session)
 * ```
 *
 * which `MSpaths` walks from the single source `uid|user` in one indexed round
 * trip. Nothing derived is ever recomputed by joining the store.
 */

export interface UserStats {
  readonly claims: number
  readonly entities: number
  readonly slots: number
  readonly tokens: number
  readonly sessions: number
  readonly turns: number
  readonly supersessions: number
  /** Slots holding ≥ 2 claims — the health metric for whether supersession can fire. */
  readonly contestedSlots: number
}

export const EMPTY_STATS: UserStats = {
  claims: 0,
  entities: 0,
  slots: 0,
  tokens: 0,
  sessions: 0,
  turns: 0,
  supersessions: 0,
  contestedSlots: 0
}

/** The `User` vertex properties, in the order `getById` projects them. */
const COUNT_PROPERTIES = [
  "n_claims",
  "n_entities",
  "n_slots",
  "n_tokens",
  "n_sessions",
  "n_turns",
  "n_supersessions",
  "n_contested"
] as const

/**
 * Users whose root vertex this process has already merged. The merge is
 * idempotent, so this is only about not paying for it once per session of a
 * 50-session ingest.
 */
const ensured = new Set<string>()

/** Merges the root vertex so the `HAS_*` edges have something to point from. */
export const ensureUser = (
  hydra: HydraClient,
  uid: string
): Effect.Effect<void, HydraError> =>
  Effect.gen(function* () {
    if (ensured.has(uid)) return
    yield* hydra.batchMerge("User", [
      { key: userKey(uid), properties: { ukey: userKey(uid), uid } }
    ])
    ensured.add(uid)
  })

/**
 * Writes the counts an ingest already holds in memory. Every one of them was
 * accumulated while writing — nothing is read back and nothing is counted
 * twice.
 */
export const writeUserStats = (
  hydra: HydraClient,
  uid: string,
  stats: UserStats
): Effect.Effect<void, HydraError> =>
  Effect.gen(function* () {
    ensured.add(uid)
    yield* hydra.batchMerge("User", [
      {
        key: userKey(uid),
        properties: {
          ukey: userKey(uid),
          uid,
          n_claims: stats.claims,
          n_entities: stats.entities,
          n_slots: stats.slots,
          n_tokens: stats.tokens,
          n_sessions: stats.sessions,
          n_turns: stats.turns,
          n_supersessions: stats.supersessions,
          n_contested: stats.contestedSlots
        }
      }
    ])
  })

/** The counts, in one ~100 ms read by id. `None` when the user was never indexed. */
export const readUserStats = (
  hydra: HydraClient,
  uid: string
): Effect.Effect<Option.Option<UserStats>, HydraError> =>
  hydra.getById("User", userKey(uid), [...COUNT_PROPERTIES]).pipe(
    Effect.map(
      Option.map((row) => ({
        claims: Number(row["n_claims"] ?? 0),
        entities: Number(row["n_entities"] ?? 0),
        slots: Number(row["n_slots"] ?? 0),
        tokens: Number(row["n_tokens"] ?? 0),
        sessions: Number(row["n_sessions"] ?? 0),
        turns: Number(row["n_turns"] ?? 0),
        supersessions: Number(row["n_supersessions"] ?? 0),
        contestedSlots: Number(row["n_contested"] ?? 0)
      }))
    )
  )

/**
 * Read-modify-write of the counts by id, for the single-session ingest the HTTP
 * API exposes. Two ~100 ms round trips, versus six label scans.
 */
export const bumpUserStats = (
  hydra: HydraClient,
  uid: string,
  delta: Partial<UserStats>
): Effect.Effect<UserStats, HydraError> =>
  Effect.gen(function* () {
    const current = yield* readUserStats(hydra, uid).pipe(
      Effect.map(Option.getOrElse((): UserStats => EMPTY_STATS))
    )
    const next: UserStats = {
      claims: current.claims + (delta.claims ?? 0),
      entities: current.entities + (delta.entities ?? 0),
      slots: current.slots + (delta.slots ?? 0),
      tokens: current.tokens + (delta.tokens ?? 0),
      sessions: current.sessions + (delta.sessions ?? 0),
      turns: current.turns + (delta.turns ?? 0),
      supersessions: current.supersessions + (delta.supersessions ?? 0),
      contestedSlots: current.contestedSlots + (delta.contestedSlots ?? 0)
    }
    yield* writeUserStats(hydra, uid, next)
    return next
  })

export type UserEdge = "HAS_ENTITY" | "HAS_SLOT" | "HAS_SESSION"

/**
 * Hangs a set of the user's vertices off the root. Content-addressed and
 * idempotent like every other write here, so a re-ingest MERGEs the same edge
 * ids over themselves.
 */
export const linkToUser = (
  hydra: HydraClient,
  uid: string,
  relType: UserEdge,
  dstLabel: "Entity" | "Slot" | "Session",
  keys: ReadonlyArray<string>
): Effect.Effect<void, HydraError> =>
  Effect.gen(function* () {
    if (keys.length === 0) return
    yield* ensureUser(hydra, uid)
    yield* hydra.batchRel(
      relType,
      keys.map((key) => ({
        srcLabel: "User",
        srcKey: userKey(uid),
        dstLabel,
        dstKey: key
      }))
    )
  })

/**
 * The vertices of one kind belonging to a user, walked from the root in one
 * `MSpaths` call. The alternative — `MATCH (e:Entity) WHERE e.uid = $uid` —
 * measured 4.9 s at 26 users and scales with the whole store.
 */
export const readUserVertices = (
  hydra: HydraClient,
  uid: string,
  relType: UserEdge
): Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, HydraError> =>
  hydra
    .msPaths({
      // No target selector: one relationship type reaches exactly one label, so
      // naming it would only cost the query a second inlined list.
      sourceLabel: "User",
      sourceProperty: "ukey",
      sourceValues: [userKey(uid)],
      relTypes: [relType],
      relDirection: "outgoing",
      maxLen: 1
    })
    .pipe(
      Effect.map((paths) => {
        const out: Array<Readonly<Record<string, unknown>>> = []
        for (const path of paths) {
          if (path.relationships.length !== 1) continue
          const node = path.nodes[path.nodes.length - 1]
          if (node === undefined) continue
          out.push(node.properties)
        }
        return out
      })
    )
