import {
  HydraLimitError,
  HydraMemory,
  type DiscoveryInput,
  type HydraError
} from "@palimpsest/hydra"
import { Context, Duration, Effect, Fiber, Layer, Option, Result } from "effect"
import { Llm, readPathModels } from "@palimpsest/llm"
import {
  discoverySeeds,
  emptyArm,
  groupSlotMates,
  probeLabel,
  unionArms,
  withoutConvergence,
  MAX_SLOT_EXPANSION,
  type LiveArm,
  type SlotMateArm
} from "./Arms.js"
import { readTimeoutMs, stopwatch, type Gathered } from "./Gather.js"
import { questionDateInt, unionOptionsFor, type AskOptions, type SnapshotScoringStats } from "./Plan.js"
import {
  SnapshotGraphMismatch,
  type QueryContext,
  type SnapshotScopeViolation
} from "./QueryContext.js"
import { DEFAULT_TOP_K, scoreReached, type ReachedClaim } from "./Scoring.js"
import { SNAPSHOT_GRAPH_FORMAT, snapshotRootKey, snapshotTokenKey } from "./SnapshotGraph.js"
import {
  snapshotReachedRows,
  snapshotSlotFills,
  snapshotSlotIndex,
  snapshotSlotIndexKey,
  snapshotSupersedeFold
} from "./SnapshotRows.js"
import { inPerspective, type PerspectiveCut } from "./TimeScope.js"
import { understand, type Probe, type SubQuestion } from "./Understand.js"

export type SnapshotReadError = HydraError | SnapshotScopeViolation | SnapshotGraphMismatch

const fromResult = <A, E>(result: Result.Result<A, E>): Effect.Effect<A, E> =>
  result._tag === "Failure" ? Effect.fail(result.failure) : Effect.succeed(result.success)

/** Same read ceiling as the legacy lane, typed for snapshot reads. */
export const withSnapshotReadTimeout = <A>(
  stage: string,
  effect: Effect.Effect<A, SnapshotReadError>
): Effect.Effect<A, SnapshotReadError> =>
  Effect.suspend(() => {
    const ceiling = readTimeoutMs()
    return Effect.timeoutOrElse(effect, {
      duration: Duration.millis(ceiling),
      orElse: () =>
        Effect.fail(
          new HydraLimitError({
            reason: `retrieval stage ${stage} exceeded ${ceiling} ms`,
            status: 408,
            query: `<ask:${stage}>`
          })
        )
    })
  })

export type SnapshotStageGuard = <A>(
  stage: string,
  effect: Effect.Effect<A, SnapshotReadError>
) => Effect.Effect<A, SnapshotReadError>

/**
 * Snapshot token convergence: the same HITS/NAMES/MENTIONS fan-out as the
 * legacy lane, with every endpoint pinned to the bound snapshot id.
 */
export const snapshotConvergenceConfig = (
  query: QueryContext,
  terms: ReadonlyArray<string>,
  maxLen: number
): DiscoveryInput => ({
  sourceLabel: "SnapshotToken",
  sourceProperty: "snapshot_token",
  sourceValues: terms.map((stem) => snapshotTokenKey(query.scope, query.snapshot.id, stem)),
  targetLabel: "SnapshotClaim",
  targetProperty: "snapshot_id",
  targetValues: [query.snapshot.id],
  relTypes: ["SNAPSHOT_HITS", "SNAPSHOT_NAMES", "SNAPSHOT_MENTIONS"],
  relDirection: "outgoing",
  maxLen
})

export const SNAPSHOT_SLOT_CLAIMS_WALK = {
  sourceLabel: "SnapshotSlot",
  sourceProperty: "snapshot_slot",
  relTypes: ["SNAPSHOT_FILLS"],
  relDirection: "incoming"
} as const

export const snapshotSlotClaimsConfig = (
  query: QueryContext,
  skeys: ReadonlyArray<string>
): DiscoveryInput => ({
  ...SNAPSHOT_SLOT_CLAIMS_WALK,
  sourceValues: skeys,
  targetLabel: "SnapshotClaim",
  targetProperty: "snapshot_id",
  targetValues: [query.snapshot.id],
  maxLen: 1
})

const snapshotCandidateSlotsConfig = (ckeys: ReadonlyArray<string>): DiscoveryInput => ({
  sourceLabel: "SnapshotClaim",
  sourceProperty: "snapshot_claim",
  sourceValues: ckeys,
  relTypes: ["SNAPSHOT_FILLS"],
  relDirection: "outgoing",
  maxLen: 1
})

export const snapshotEvidenceConfig = (ckeys: ReadonlyArray<string>): DiscoveryInput => ({
  sourceLabel: "SnapshotClaim",
  sourceProperty: "snapshot_claim",
  sourceValues: ckeys,
  relTypes: ["SNAPSHOT_EVIDENCE"],
  relDirection: "outgoing",
  maxLen: 1
})

export const snapshotEdgesConfig = (
  query: QueryContext,
  ckeys: ReadonlyArray<string>
): DiscoveryInput => ({
  sourceLabel: "SnapshotClaim",
  sourceProperty: "snapshot_claim",
  sourceValues: ckeys,
  targetLabel: "SnapshotClaim",
  targetProperty: "snapshot_id",
  targetValues: [query.snapshot.id],
  relTypes: ["SNAPSHOT_SUPERSEDED_BY"],
  relDirection: "outgoing",
  maxLen: 1
})

/** Every slot of the bound snapshot: the constant `snapshot_id` selector returns all pairs. */
export const snapshotSlotIndexConfig = (query: QueryContext): DiscoveryInput => ({
  sourceLabel: "SnapshotRoot",
  sourceProperty: "snapshot_root",
  sourceValues: [snapshotRootKey(query.scope, query.snapshot.id)],
  targetLabel: "SnapshotSlot",
  targetProperty: "snapshot_id",
  targetValues: [query.snapshot.id],
  relTypes: ["SNAPSHOT_HAS_SLOT"],
  relDirection: "outgoing",
  maxLen: 1
})

export const snapshotWalkArm = (
  hydra: HydraMemory,
  query: QueryContext,
  kind: LiveArm["kind"],
  label: string,
  config: DiscoveryInput,
  total: number,
  score: (claim: ReachedClaim) => ReachedClaim = (claim) => claim
): Effect.Effect<LiveArm, SnapshotReadError> =>
  Effect.flatMap(hydra.discoverPaths(config), ({ paths, plan }) =>
    Effect.map(fromResult(snapshotReachedRows(paths, query)), (rows) => {
      const diagnostic = hydra.describeExecutionPlan(plan)
      return {
        kind,
        label,
        claims: scoreReached(rows, total).map(score),
        query: diagnostic.queryText,
        plan: diagnostic,
        paths: paths.length,
        rawPaths: paths,
        timedOut: false
      }
    }))

export const snapshotConvergenceArm = (
  hydra: HydraMemory,
  query: QueryContext,
  terms: ReadonlyArray<string>,
  total: number,
  maxLen: number
): Effect.Effect<LiveArm, SnapshotReadError> =>
  // Always walks: empty terms short-circuit inside the adapter, which still
  // returns the receipt plan the query never ran.
  snapshotWalkArm(
    hydra,
    query,
    "convergence",
    "convergence",
    snapshotConvergenceConfig(query, terms, maxLen),
    total
  )

export const snapshotSubQuestionArm = (
  hydra: HydraMemory,
  query: QueryContext,
  sub: SubQuestion,
  index: number,
  total: number,
  maxLen: number
): Effect.Effect<LiveArm, SnapshotReadError> =>
  sub.terms.length === 0
    ? Effect.succeed(emptyArm("subQuestion", `sub:${index}`))
    : snapshotWalkArm(
      hydra,
      query,
      "subQuestion",
      `sub:${index}`,
      snapshotConvergenceConfig(query, sub.terms, maxLen),
      total
    )

/** A probe whose slot is absent from the snapshot reads as an empty arm, like the legacy lane. */
export const snapshotProbeArm = (
  hydra: HydraMemory,
  query: QueryContext,
  probe: Probe,
  slotKey: string | null,
  total: number
): Effect.Effect<LiveArm, SnapshotReadError> =>
  slotKey === null
    ? Effect.succeed(emptyArm("probe", probeLabel(probe)))
    : snapshotWalkArm(
      hydra,
      query,
      "probe",
      probeLabel(probe),
      snapshotSlotClaimsConfig(query, [slotKey]),
      total,
      withoutConvergence
    )

export const snapshotDiscoveryArm = (
  hydra: HydraMemory,
  query: QueryContext,
  seeds: ReadonlyArray<string>,
  total: number,
  maxLen: number
): Effect.Effect<LiveArm, SnapshotReadError> =>
  seeds.length === 0
    ? Effect.succeed(emptyArm("discovery", "discovery"))
    : snapshotWalkArm(
      hydra,
      query,
      "discovery",
      "discovery",
      snapshotConvergenceConfig(query, seeds, maxLen),
      total
    )

/** Two reads (`slotKeys`, `slotClaims`); a `HydraLimitError` in either degrades like the legacy lane. */
export const snapshotSlotMateArm = (
  hydra: HydraMemory,
  query: QueryContext,
  candidates: ReadonlyArray<ReachedClaim>,
  alreadyReached: ReadonlySet<string>,
  total: number,
  guard: SnapshotStageGuard
): Effect.Effect<SlotMateArm, SnapshotReadError> =>
  Effect.gen(function* () {
    const expansion = yield* Effect.result(
      Effect.gen(function* () {
        const fills = yield* guard(
          "slotKeys",
          candidates.length === 0
            ? Effect.succeed([])
            : Effect.flatMap(
              hydra.discoverPaths(snapshotCandidateSlotsConfig(candidates.map((claim) => claim.ckey))),
              ({ paths }) => fromResult(snapshotSlotFills(paths, query))
            )
        )
        const skeys = [...new Set(fills.map((fill) => fill.skey))].sort()
        const candidateSlotOf = new Map(
          fills.filter((fill) => fill.ckey !== "").map((fill) => [fill.ckey, fill.skey] as const)
        )
        const config = snapshotSlotClaimsConfig(query, skeys)
        const slotClaims = yield* guard("slotClaims", hydra.discoverPaths(config))
        const paths = slotClaims.paths
        const parsed = snapshotSlotFills(paths, query)
        if (Result.isFailure(parsed)) return yield* Effect.fail(parsed.failure)
        const slotOf = new Map(
          parsed.success
            .filter((fill) => fill.ckey !== "")
            .map((fill) => [fill.ckey, fill.skey] as const)
        )
        const rows = snapshotReachedRows(paths, query)
        if (Result.isFailure(rows)) return yield* Effect.fail(rows.failure)
        const arm: LiveArm = {
          kind: "slotMate",
          label: "slotMate",
          claims: scoreReached(rows.success, total).map(withoutConvergence),
          query: skeys.length === 0 ? null : hydra.describeExecutionPlan(slotClaims.plan).queryText,
          plan: skeys.length === 0 ? null : hydra.describeExecutionPlan(slotClaims.plan),
          paths: paths.length,
          rawPaths: [],
          timedOut: false
        }
        return { candidateSlotOf, arm, slotOf }
      })
    )
    if (expansion._tag === "Failure") {
      if (expansion.failure._tag !== "HydraLimitError") return yield* Effect.fail(expansion.failure)
      return { ...emptyArm("slotMate", "slotMate", true), slotOf: new Map<string, string>() }
    }
    const { candidateSlotOf, arm, slotOf } = expansion.success
    const grouped = groupSlotMates(arm.claims, slotOf, alreadyReached, MAX_SLOT_EXPANSION)
    const eligible = arm.claims.filter((claim) => !alreadyReached.has(claim.ckey)).length
    return {
      ...arm,
      claims: grouped,
      slotOf: new Map([...candidateSlotOf, ...slotOf]),
      capped: eligible > grouped.length
    }
  })

export const snapshotSupersessionEdges = (
  hydra: HydraMemory,
  query: QueryContext,
  ckeys: ReadonlyArray<string>,
  asOf?: number
): Effect.Effect<
  ReadonlyMap<string, { readonly newer: string; readonly atSession: number }>,
  SnapshotReadError
> =>
  ckeys.length === 0
    ? Effect.succeed(new Map<string, { readonly newer: string; readonly atSession: number }>())
    : Effect.flatMap(hydra.discoverPaths(snapshotEdgesConfig(query, ckeys)), ({ paths }) =>
      fromResult(snapshotSupersedeFold(paths, query, asOf)))

/** The `(entityCanon, attr)` probe lookup over one `SNAPSHOT_HAS_SLOT` walk, loaded lazily per request. */
export const loadSnapshotSlotIndex = (
  hydra: HydraMemory,
  query: QueryContext
): Effect.Effect<ReadonlyMap<string, string>, SnapshotReadError> =>
  Effect.flatMap(hydra.discoverPaths(snapshotSlotIndexConfig(query)), ({ paths }) =>
    fromResult(snapshotSlotIndex(paths, query)))

export const resolveSnapshotProbeSlot = (
  index: ReadonlyMap<string, string>,
  probe: Probe
): string | null => index.get(snapshotSlotIndexKey(probe.entityCanon, probe.attr)) ?? null

export interface SnapshotClaimStats {
  readonly totalClaims: number
}

/**
 * The snapshot's claim denominator, verified against the bound manifest
 * record. A missing or disagreeing root fails the request: the graph is not
 * the snapshot the request bound to.
 */
export const readSnapshotClaimStats = (
  hydra: HydraMemory,
  query: QueryContext
): Effect.Effect<SnapshotClaimStats, SnapshotReadError> =>
  Effect.flatMap(
    hydra.resolveNode({
      label: "SnapshotRoot",
      key: snapshotRootKey(query.scope, query.snapshot.id),
      properties: ["snapshot_id", "graph_format", "source_revisions_hash", "n_revisions", "n_claims"]
    }),
    (found) => {
      const rootKey = snapshotRootKey(query.scope, query.snapshot.id)
      if (Option.isNone(found)) {
        return Effect.fail(
          new SnapshotGraphMismatch({
            snapshotId: query.snapshot.id,
            reason: "missingRoot",
            detail: rootKey
          })
        )
      }
      const row = found.value.properties
      if (String(row["snapshot_id"] ?? "") !== query.snapshot.id) {
        return Effect.fail(
          new SnapshotGraphMismatch({
            snapshotId: query.snapshot.id,
            reason: "rootMismatch",
            detail: rootKey
          })
        )
      }
      if (String(row["graph_format"] ?? "") !== SNAPSHOT_GRAPH_FORMAT) {
        return Effect.fail(
          new SnapshotGraphMismatch({
            snapshotId: query.snapshot.id,
            reason: "graphFormatMismatch",
            detail: rootKey
          })
        )
      }
      if (String(row["source_revisions_hash"] ?? "") !== query.snapshot.sourceRevisionsHash) {
        return Effect.fail(
          new SnapshotGraphMismatch({
            snapshotId: query.snapshot.id,
            reason: "revisionsHashMismatch",
            detail: rootKey
          })
        )
      }
      const counts = query.record.counts
      if (counts === null || Number(row["n_revisions"] ?? -1) !== counts.sourceRevisions) {
        return Effect.fail(
          new SnapshotGraphMismatch({
            snapshotId: query.snapshot.id,
            reason: "countsMismatch",
            detail: rootKey
          })
        )
      }
      return Effect.succeed({ totalClaims: Number(row["n_claims"] ?? 0) })
    }
  )

/** A legacy-shaped gather bound to one snapshot: every arm reads the same `query`. */
export interface SnapshotGathered extends Gathered {
  readonly query: QueryContext
  /** The verified idf denominator, bound to the bound snapshot before any arm ran. */
  readonly stats: SnapshotScoringStats
  /** Arm claims dropped by the perspective cut before any union, traversal, or cap. */
  readonly perspectiveFiltered: number
}

/**
 * Snapshot gather: the same arm fan-out as the legacy lane, with the claim
 * denominator verified against the bound manifest record and probes resolved
 * through the snapshot's slots. Timeout degradation matches the legacy lane;
 * scope and graph-mismatch failures always propagate.
 */
export const gatherInSnapshot = (
  hydra: HydraMemory,
  query: QueryContext,
  question: string,
  options: AskOptions
): Effect.Effect<SnapshotGathered, SnapshotReadError, Llm> =>
  Effect.gen(function* () {
    const askStarted = Date.now()
    const models = readPathModels((yield* Llm).model)
    const clock = stopwatch()
    const { timed } = clock

    const profile = options.profile ?? "full"
    const maxLen = options.maxLen ?? 2
    const topK = options.topK ?? DEFAULT_TOP_K
    const questionDate = questionDateInt(options.questionDate)
    const asOf = options.asOf ?? query.asOf

    const statsFiber = yield* Effect.forkChild(timed("snapshotStats", readSnapshotClaimStats(hydra, query)))
    const understood = yield* timed(
      "understand",
      understand(question, questionDate, options.questionDate)
    )
    const graphStarted = Date.now()
    const total = (yield* Fiber.join(statsFiber)).totalClaims

    const historical = options.historical ?? understood.historical
    const ablations = options.ablations ?? {}
    const extraTerms = options.extraTerms ?? []
    const terms =
      extraTerms.length === 0
        ? understood.terms
        : [...new Set([...understood.terms, ...extraTerms])].sort()
    const subQuestions = ablations.noDecompose === true ? [] : understood.subQuestions
    const unionOptions = unionOptionsFor(asOf)
    const cut: PerspectiveCut = {
      perspective: query.perspective,
      interval:
        questionDate > 0 && ablations.noTimeScope !== true ? understood.timeInterval : null,
      questionDate,
      ...(asOf !== undefined && { asOf })
    }
    let perspectiveFiltered = 0
    const cutArm = <A extends LiveArm>(arm: A): A => {
      const kept = arm.claims.filter((claim) => inPerspective(claim, cut))
      perspectiveFiltered += arm.claims.length - kept.length
      return kept.length === arm.claims.length ? arm : { ...arm, claims: kept }
    }

    const guard: SnapshotStageGuard = (stage, effect) =>
      timed(stage, withSnapshotReadTimeout(stage, effect))
    const runArm = (
      label: string,
      kind: LiveArm["kind"],
      effect: Effect.Effect<LiveArm, SnapshotReadError>,
      optional: boolean
    ): Effect.Effect<LiveArm, SnapshotReadError> =>
      optional
        ? Effect.catchTag(guard(label, effect), "HydraLimitError", () =>
          Effect.succeed(emptyArm(kind, label, true)))
        : guard(label, effect)

    const slotIndex =
      understood.probes.length === 0
        ? undefined
        : yield* guard("slotIndex", loadSnapshotSlotIndex(hydra, query))

    const reaching = (yield* Effect.all(
      [
        runArm(
          "convergence",
          "convergence",
          snapshotConvergenceArm(hydra, query, terms, total, maxLen),
          false
        ),
        ...subQuestions.map((sub, index) =>
          runArm(
            `sub:${index}`,
            "subQuestion",
            snapshotSubQuestionArm(hydra, query, sub, index, total, maxLen),
            true
          ))
        ,
        ...understood.probes.map((probe) =>
          runArm(
            probeLabel(probe),
            "probe",
            snapshotProbeArm(
              hydra,
              query,
              probe,
              slotIndex === undefined ? null : resolveSnapshotProbeSlot(slotIndex, probe),
              total
            ),
            true
          ))
      ],
      { concurrency: 4 }
    )).map(cutArm)

    const convergence = reaching[0]!
    const firstPass = unionArms(reaching, unionOptions)
    const seeds =
      ablations.noDiscovery === true
        ? []
        : discoverySeeds(convergence.rawPaths, firstPass.candidates.slice(0, 10), new Set(terms))
    const discovered = yield* runArm(
      "discovery",
      "discovery",
      snapshotDiscoveryArm(hydra, query, seeds, total, maxLen),
      true
    )
    const discovery = cutArm(discovered)

    const secondPass = unionArms([...reaching, discovery], unionOptions)
    const slotMate = yield* snapshotSlotMateArm(
      hydra,
      query,
      secondPass.candidates.slice(0, topK),
      new Set(secondPass.candidates.map((candidate) => candidate.ckey)),
      total,
      guard
    )

    const union = unionArms([...reaching, discovery, slotMate], unionOptions)
    const edges = yield* guard(
      "edges",
      snapshotSupersessionEdges(
        hydra,
        query,
        union.candidates.map((candidate) => candidate.ckey),
        asOf
      )
    )
    const graphMs = Date.now() - graphStarted

    return {
      uid: query.scope.uid,
      query1Plan: convergence.plan,
      question,
      understood,
      terms,
      extraTerms,
      total,
      historical,
      profile,
      maxLen,
      topK,
      questionDate,
      asOf,
      ablations,
      models,
      reaching,
      discovery,
      slotMate,
      edges,
      graphMs,
      askStarted,
      clock,
      query,
      stats: { snapshotId: query.snapshot.id, totalClaims: total },
      perspectiveFiltered
    }
  })

/** Domain-shaped snapshot search capability used by the retrieval application service. */
export interface SnapshotSearchService {
  readonly gather: (
    query: QueryContext,
    question: string,
    options: AskOptions
  ) => Effect.Effect<SnapshotGathered, SnapshotReadError, Llm>
}

/**
 * Snapshot retrieval adapter. Hydra labels, relationship walks, decoded paths,
 * execution plans, bounds, and row validation remain behind this service.
 */
export class SnapshotSearch extends Context.Service<SnapshotSearch, SnapshotSearchService>()(
  "palimpsest/SnapshotSearch"
) {
  static readonly layer: Layer.Layer<SnapshotSearch, never, HydraMemory> = Layer.effect(
    SnapshotSearch,
    Effect.gen(function* () {
      const hydra = yield* HydraMemory
      return SnapshotSearch.of({
        gather: Effect.fn("SnapshotSearch.gather")(function* (
          query: QueryContext,
          question: string,
          options: AskOptions
        ) {
          return yield* gatherInSnapshot(hydra, query, question, options)
        })
      })
    })
  )
}
