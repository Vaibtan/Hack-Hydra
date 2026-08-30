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

export type UserEdge = "HAS_ENTITY" | "HAS_SLOT" | "HAS_SESSION" | "HAS_SOURCE_REVISION"

/**
 * Hangs a set of the user's vertices off the root. Content-addressed and
 * idempotent like every other write here, so a re-ingest MERGEs the same edge
 * ids over themselves.
 */
export const linkToUser = (
  hydra: HydraClient,
  uid: string,
  relType: UserEdge,
  dstLabel: "Entity" | "Slot" | "Session" | "SourceSession",
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

/**
 * What a warm reached, per level.
 *
 * Counts rather than nothing, because a warm that silently touched nothing is
 * indistinguishable from one that worked — which is exactly how the first
 * version of this went unnoticed.
 */
export interface WarmReport {
  readonly entities: number
  readonly slots: number
  readonly sessions: number
  readonly tokens: number
  readonly slotClaims: number
  readonly turns: number
  /** Non-zero only under `deep`. */
  readonly hitClaims: number
  readonly ms: number
}

/** Every key at the far end of a one-hop walk, best-effort. */
const warmHop = (
  hydra: HydraClient,
  source: {
    readonly label: string
    readonly property: string
    readonly values: ReadonlyArray<string>
  },
  relType: string,
  direction: "outgoing" | "incoming",
  targetProperty: string
): Effect.Effect<ReadonlyArray<string>> => {
  if (source.values.length === 0) return Effect.succeed([])
  return hydra
    .msPaths({
      sourceLabel: source.label,
      sourceProperty: source.property,
      sourceValues: [...source.values],
      relTypes: [relType],
      relDirection: direction,
      maxLen: 1
    })
    .pipe(
      Effect.map((paths) => {
        const keys = new Set<string>()
        for (const path of paths) {
          const node = path.nodes[path.nodes.length - 1]
          const key = String(node?.properties[targetProperty] ?? "")
          if (key !== "") keys.add(key)
        }
        return [...keys] as ReadonlyArray<string>
      }),
      // A warm exists to make the *next* read faster. Failing it must never be
      // able to fail the thing it was warming for, so a level that could not be
      // read reports zero and the ask that follows pays what it would have paid
      // anyway.
      Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<string>))
    )
}

/**
 * Reads the blocks an ask will read, before the ask.
 *
 * On this runtime a cold block is an HTTP GET to the object store rather than a
 * page fault — the read cache is off while ingesting — and a first ask measured
 * 11 397 ms of `graphMs` against a warm 68 ms.
 *
 * **The first version of this touched the wrong thing.** It walked the `User`
 * root's `HAS_ENTITY` / `HAS_SLOT` / `HAS_SESSION` fan-out and stopped, and the
 * ops note recorded the consequence honestly: it did not move the cold number,
 * because the cold cost is the convergence walk `Token -HITS-> Claim` and
 * nothing there touched a Token.
 *
 * There is no `User -HAS_TOKEN-> Token` edge to walk: a Token is linked to
 * Claims by `HITS` and to Entities by `NAMES`, and to nothing else. So Tokens
 * are reached the only way that is not a store-wide label scan — **backwards
 * along `NAMES` from the entity keys the fan-out just returned**. That is a
 * subset of the user's Tokens, and it is the useful subset: a question's anchors
 * are the words it uses for the things it asks about, which are the entities.
 *
 * Levels, in the order an ask reads them:
 *
 * 1. `User` -> Entity / Slot / Session
 * 2. Entity <-`NAMES`- Token · Slot <-`FILLS`- Claim (Query 2's shape) ·
 *    Session -`HAS_TURN`-> Turn (what hydration reads)
 * 3. `deep` only: Token -`HITS`-> Claim, the convergence walk itself
 *
 * `deep` is off by default because it is that user's whole inverted index
 * rather than one question's slice of it — tens of thousands of paths and many
 * cursor pages on a 2 000-claim user, where a real question walks from five to
 * fifteen anchors. Whether it buys anything is a measurement.
 *
 * Reads only, so warming twice is free and warming the wrong user is harmless.
 */
export const warmUser = (
  hydra: HydraClient,
  uid: string,
  options: { readonly deep?: boolean } = {}
): Effect.Effect<Option.Option<WarmReport>, HydraError> =>
  Effect.gen(function* () {
    const started = Date.now()
    const stats = yield* readUserStats(hydra, uid)
    if (Option.isNone(stats)) return Option.none()

    const [entities, slots, sessions] = yield* Effect.all(
      [
        readUserVertices(hydra, uid, "HAS_ENTITY"),
        readUserVertices(hydra, uid, "HAS_SLOT"),
        readUserVertices(hydra, uid, "HAS_SESSION")
      ],
      { concurrency: 3 }
    )
    const keysOf = (
      rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
      property: string
    ): ReadonlyArray<string> =>
      rows.map((row) => String(row[property] ?? "")).filter((key) => key !== "")

    const [tokens, slotClaims, turns] = yield* Effect.all(
      [
        warmHop(
          hydra,
          { label: "Entity", property: "ekey", values: keysOf(entities, "ekey") },
          "NAMES",
          "incoming",
          "tkey"
        ),
        warmHop(
          hydra,
          { label: "Slot", property: "skey", values: keysOf(slots, "skey") },
          "FILLS",
          "incoming",
          "ckey"
        ),
        warmHop(
          hydra,
          { label: "Session", property: "sess", values: keysOf(sessions, "sess") },
          "HAS_TURN",
          "outgoing",
          "turn"
        )
      ],
      { concurrency: 3 }
    )

    const hitClaims =
      options.deep === true
        ? yield* warmHop(
            hydra,
            { label: "Token", property: "tkey", values: tokens },
            "HITS",
            "outgoing",
            "ckey"
          )
        : []

    return Option.some({
      entities: entities.length,
      slots: slots.length,
      sessions: sessions.length,
      tokens: tokens.length,
      slotClaims: slotClaims.length,
      turns: turns.length,
      hitClaims: hitClaims.length,
      ms: Date.now() - started
    })
  })
