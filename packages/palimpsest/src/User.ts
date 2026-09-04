import { HydraClient, type HydraError } from "@palimpsest/hydra"
import { Effect, Option } from "effect"
import { userKey } from "./Keys.js"

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

const ensured = new Set<string>()

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

export const readUserVertices = (
  hydra: HydraClient,
  uid: string,
  relType: UserEdge
): Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, HydraError> =>
  hydra
    .msPaths({
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

export interface WarmReport {
  readonly entities: number
  readonly slots: number
  readonly sessions: number
  readonly tokens: number
  readonly slotClaims: number
  readonly turns: number
  /** Non-zero only under `deep`. */
  readonly hitClaims: number
  /** Walks that failed. Reported, never swallowed into a zero. */
  readonly failed: number
  /** The budget ran out before every walk was made. */
  readonly truncated: boolean
  readonly ms: number
}

export const WARM_SOURCES_PER_WALK = 200

export const WARM_BUDGET_MS = 15_000

const warmHop = (
  hydra: HydraClient,
  source: {
    readonly label: string
    readonly property: string
    readonly values: ReadonlyArray<string>
  },
  relType: string,
  direction: "outgoing" | "incoming",
  targetProperty: string,
  deadline: number
): Effect.Effect<{
  readonly keys: ReadonlyArray<string>
  readonly failed: number
  readonly truncated: boolean
}> =>
  Effect.gen(function* () {
    const keys = new Set<string>()
    let failed = 0
    let truncated = false
    for (let at = 0; at < source.values.length; at += WARM_SOURCES_PER_WALK) {
      if (Date.now() >= deadline) {
        truncated = true
        break
      }
      const batch = source.values.slice(at, at + WARM_SOURCES_PER_WALK)
      const outcome = yield* Effect.either(
        hydra.msPaths({
          sourceLabel: source.label,
          sourceProperty: source.property,
          sourceValues: batch,
          relTypes: [relType],
          relDirection: direction,
          maxLen: 1
        })
      )
      if (outcome._tag === "Left") {
        failed++
        continue
      }
      for (const path of outcome.right) {
        const node = path.nodes[path.nodes.length - 1]
        const key = String(node?.properties[targetProperty] ?? "")
        if (key !== "") keys.add(key)
      }
    }
    return { keys: [...keys] as ReadonlyArray<string>, failed, truncated }
  })

export const warmUser = (
  hydra: HydraClient,
  uid: string,
  options: { readonly deep?: boolean; readonly budgetMs?: number } = {}
): Effect.Effect<Option.Option<WarmReport>, HydraError> =>
  Effect.gen(function* () {
    const started = Date.now()
    const deadline = started + (options.budgetMs ?? WARM_BUDGET_MS)
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

    const [turns, slotClaims, tokens] = yield* Effect.all(
      [
        warmHop(
          hydra,
          { label: "Session", property: "sess", values: keysOf(sessions, "sess") },
          "HAS_TURN",
          "outgoing",
          "turn",
          deadline
        ),
        warmHop(
          hydra,
          { label: "Slot", property: "skey", values: keysOf(slots, "skey") },
          "FILLS",
          "incoming",
          "ckey",
          deadline
        ),
        warmHop(
          hydra,
          { label: "Entity", property: "ekey", values: keysOf(entities, "ekey") },
          "NAMES",
          "incoming",
          "tkey",
          deadline
        )
      ],
      { concurrency: 3 }
    )

    const hitClaims =
      options.deep === true
        ? yield* warmHop(
            hydra,
            { label: "Token", property: "tkey", values: tokens.keys },
            "HITS",
            "outgoing",
            "ckey",
            deadline
          )
        : { keys: [] as ReadonlyArray<string>, failed: 0, truncated: false }

    return Option.some({
      entities: entities.length,
      slots: slots.length,
      sessions: sessions.length,
      tokens: tokens.keys.length,
      slotClaims: slotClaims.keys.length,
      turns: turns.keys.length,
      hitClaims: hitClaims.keys.length,
      failed: turns.failed + slotClaims.failed + tokens.failed + hitClaims.failed,
      truncated:
        turns.truncated || slotClaims.truncated || tokens.truncated || hitClaims.truncated,
      ms: Date.now() - started
    })
  })
