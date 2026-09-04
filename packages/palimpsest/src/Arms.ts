import {
  HydraClient,
  renderMsPathsQuery,
  type HydraError,
  type HydraPath,
  type MsPathsConfig
} from "@palimpsest/hydra"
import { Effect } from "effect"
import { claimKind, slotKey, tokenKey } from "./Keys.js"
import { middleEntityNames, reachedRows, slotFills } from "./Rows.js"
import { scoreReached, type ReachedClaim } from "./Scoring.js"
import { stems } from "./Tokenize.js"
import type { Probe, SubQuestion } from "./Understand.js"

/** The kinds of arm, in the order the union cap prefers them. */
export const ARM_PRIORITY = ["probe", "subQuestion", "convergence", "discovery", "slotMate"] as const

export type ArmKind = (typeof ARM_PRIORITY)[number]

export interface ArmResult {
  readonly kind: ArmKind
  readonly label: string
  readonly claims: ReadonlyArray<ReachedClaim>
}

export interface Candidate extends ReachedClaim {
  /** Every arm that reached this claim, in the order the arms were declared. */
  readonly arms: ReadonlyArray<string>
  /** The best (lowest-index) arm kind that reached it. */
  readonly kind: ArmKind
}

export const UNION_CAP = 120

/** Per walking arm, applied inside `unionArms` after the as-of cut. */
export const ARM_CAP = 60

const CAPPED_KINDS: ReadonlyArray<ArmKind> = ["convergence", "subQuestion", "discovery"]

export interface UnionReport {
  readonly candidates: ReadonlyArray<Candidate>
  readonly dropped: ReadonlyArray<Candidate>
  /** Per-arm counts after the as-of cut, before the union cap. */
  readonly counts: Readonly<Record<string, number>>
}

const priorityOf = (kind: ArmKind): number => ARM_PRIORITY.indexOf(kind)

/** Unions the arms by claim key: as-of cut, then the arm cap, then the union cap. */
export const unionArms = (
  arms: ReadonlyArray<ArmResult>,
  options: { readonly asOf?: number; readonly cap?: number; readonly armCap?: number } = {}
): UnionReport => {
  const cap = options.cap ?? UNION_CAP
  const armCap = options.armCap ?? ARM_CAP
  const merged = new Map<string, Candidate>()
  const counts: Record<string, number> = {}

  for (const arm of arms) {
    const visible =
      options.asOf === undefined
        ? arm.claims
        : arm.claims.filter((claim) => claim.sessionOrd <= options.asOf!)
    const capped = CAPPED_KINDS.includes(arm.kind)
      ? [...visible]
          .sort(
            (a, b) =>
              b.convergence - a.convergence || b.score - a.score || a.ckey.localeCompare(b.ckey)
          )
          .slice(0, armCap)
      : visible
    counts[arm.label] = (counts[arm.label] ?? 0) + capped.length

    for (const claim of capped) {
      const existing = merged.get(claim.ckey)
      if (existing === undefined) {
        merged.set(claim.ckey, { ...claim, arms: [arm.label], kind: arm.kind })
        continue
      }
      merged.set(claim.ckey, {
        ...existing,
        anchors: existing.anchors.length >= claim.anchors.length ? existing.anchors : claim.anchors,
        convergence: Math.max(existing.convergence, claim.convergence),
        score: Math.max(existing.score, claim.score),
        hops: Math.min(existing.hops, claim.hops),
        arms: existing.arms.includes(arm.label) ? existing.arms : [...existing.arms, arm.label],
        kind: priorityOf(arm.kind) < priorityOf(existing.kind) ? arm.kind : existing.kind
      })
    }
  }

  const ordered = [...merged.values()].sort(
    (a, b) =>
      priorityOf(a.kind) - priorityOf(b.kind) ||
      b.convergence - a.convergence ||
      b.score - a.score ||
      b.tEvent - a.tEvent ||
      a.ckey.localeCompare(b.ckey)
  )

  return {
    candidates: ordered.slice(0, cap),
    dropped: ordered.slice(cap),
    counts
  }
}


export const convergenceConfig = (
  uid: string,
  terms: ReadonlyArray<string>,
  maxLen: number
): MsPathsConfig => ({
  sourceLabel: "Token",
  sourceProperty: "tkey",
  sourceValues: terms.map((stem) => tokenKey(uid, stem)),
  targetLabel: "Claim",
  targetProperty: "kind",
  targetValues: [claimKind(uid)],
  relTypes: ["HITS", "NAMES", "MENTIONS"],
  relDirection: "outgoing",
  maxLen
})

/** The `Slot <-FILLS- Claim` walk every Slot read shares: probes, slot-mates and the warm. */
export const SLOT_CLAIMS_WALK = {
  sourceLabel: "Slot",
  sourceProperty: "skey",
  relTypes: ["FILLS"],
  relDirection: "incoming"
} as const

export const slotClaimsConfig = (uid: string, skeys: ReadonlyArray<string>): MsPathsConfig => ({
  ...SLOT_CLAIMS_WALK,
  sourceValues: skeys,
  targetLabel: "Claim",
  targetProperty: "kind",
  targetValues: [claimKind(uid)],
  maxLen: 1
})

const candidateSlotsConfig = (ckeys: ReadonlyArray<string>): MsPathsConfig => ({
  sourceLabel: "Claim",
  sourceProperty: "ckey",
  sourceValues: ckeys,
  relTypes: ["FILLS"],
  relDirection: "outgoing",
  maxLen: 1
})

/** One arm's read, with the query it ran for the receipt. `rawPaths` never leaves memory. */
export interface LiveArm extends ArmResult {
  readonly query: string | null
  readonly paths: number
  readonly rawPaths: ReadonlyArray<HydraPath>
  /** The arm exceeded its read ceiling and was reported empty rather than thrown. */
  readonly timedOut: boolean
}

export const emptyArm = (kind: ArmKind, label: string, timedOut = false): LiveArm => ({
  kind,
  label,
  claims: [],
  query: null,
  paths: 0,
  rawPaths: [],
  timedOut
})

/** Scored with zero anchors: the claim was named or pulled in by its Slot, not converged on. */
export const withoutConvergence = (claim: ReachedClaim): ReachedClaim => ({
  ...claim,
  anchors: [],
  convergence: 0,
  score: 0
})

export const walkArm = (
  hydra: HydraClient,
  kind: ArmKind,
  label: string,
  config: MsPathsConfig,
  total: number,
  score: (claim: ReachedClaim) => ReachedClaim = (claim) => claim
): Effect.Effect<LiveArm, HydraError> =>
  Effect.map(hydra.msPaths(config), (paths) => ({
    kind,
    label,
    claims: scoreReached(reachedRows(paths), total).map(score),
    query: renderMsPathsQuery(config).query,
    paths: paths.length,
    rawPaths: paths,
    timedOut: false
  }))

export const convergenceArm = (
  hydra: HydraClient,
  uid: string,
  terms: ReadonlyArray<string>,
  total: number,
  maxLen: number
): Effect.Effect<LiveArm, HydraError> =>
  terms.length === 0
    ? Effect.succeed(emptyArm("convergence", "convergence"))
    : walkArm(hydra, "convergence", "convergence", convergenceConfig(uid, terms, maxLen), total)

export const subQuestionArm = (
  hydra: HydraClient,
  uid: string,
  sub: SubQuestion,
  index: number,
  total: number,
  maxLen: number
): Effect.Effect<LiveArm, HydraError> =>
  sub.terms.length === 0
    ? Effect.succeed(emptyArm("subQuestion", `sub:${index}`))
    : walkArm(hydra, "subQuestion", `sub:${index}`, convergenceConfig(uid, sub.terms, maxLen), total)

export const probeLabel = (probe: Probe): string => `probe:${probe.entityCanon}|${probe.attr}`

export const probeArm = (
  hydra: HydraClient,
  uid: string,
  probe: Probe,
  total: number
): Effect.Effect<LiveArm, HydraError> =>
  walkArm(
    hydra,
    "probe",
    probeLabel(probe),
    slotClaimsConfig(uid, [slotKey(uid, probe.entityCanon, probe.attr)]),
    total,
    withoutConvergence
  )

export const MAX_DISCOVERY_SEEDS = 20

/** Terms the question did not supply, ranked by rarity within the top candidates. */
export const discoverySeeds = (
  paths: ReadonlyArray<HydraPath>,
  top: ReadonlyArray<ReachedClaim>,
  alreadyAnchors: ReadonlySet<string>
): ReadonlyArray<string> => {
  const seeds = new Map<string, number>()

  for (const name of middleEntityNames(paths)) {
    for (const s of stems(name)) {
      if (!alreadyAnchors.has(s)) seeds.set(s, 0)
    }
  }

  const frequency = new Map<string, number>()
  for (const claim of top) {
    for (const s of new Set(stems(claim.text))) {
      if (alreadyAnchors.has(s)) continue
      frequency.set(s, (frequency.get(s) ?? 0) + 1)
    }
  }
  for (const [term, n] of frequency) {
    if (!seeds.has(term)) seeds.set(term, n)
  }

  return [...seeds.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_DISCOVERY_SEEDS)
    .map(([term]) => term)
}

export const discoveryArm = (
  hydra: HydraClient,
  uid: string,
  seeds: ReadonlyArray<string>,
  total: number,
  maxLen: number
): Effect.Effect<LiveArm, HydraError> =>
  seeds.length === 0
    ? Effect.succeed(emptyArm("discovery", "discovery"))
    : walkArm(hydra, "discovery", "discovery", convergenceConfig(uid, seeds, maxLen), total)


export const MAX_SLOT_EXPANSION = 40

export const MAX_SLOT_MATES_PER_SLOT = 5

/** Newest first, skipping what an arm already reached, at most five per Slot and `overallCap` overall. */
export const groupSlotMates = (
  claims: ReadonlyArray<ReachedClaim>,
  slotOf: ReadonlyMap<string, string>,
  alreadyReached: ReadonlySet<string>,
  overallCap: number
): ReadonlyArray<ReachedClaim> => {
  const newestFirst = (a: ReachedClaim, b: ReachedClaim): number =>
    b.sessionOrd - a.sessionOrd || a.ckey.localeCompare(b.ckey)
  const perSlot = new Map<string, Array<ReachedClaim>>()
  for (const claim of [...claims].sort(newestFirst)) {
    if (alreadyReached.has(claim.ckey)) continue
    const slot = slotOf.get(claim.ckey) ?? ""
    const bucket = perSlot.get(slot) ?? []
    if (bucket.length >= MAX_SLOT_MATES_PER_SLOT) continue
    bucket.push(claim)
    perSlot.set(slot, bucket)
  }
  return [...perSlot.values()].flat().sort(newestFirst).slice(0, overallCap)
}

export interface SlotMateArm extends LiveArm {
  /** Which Slot each claim fills: every candidate the `FILLS` walk resolved, plus every slot-mate read. */
  readonly slotOf: ReadonlyMap<string, string>
}

/** Wraps one stage's read: the caller's timing and read ceiling. */
export type StageGuard = <A>(
  stage: string,
  effect: Effect.Effect<A, HydraError>
) => Effect.Effect<A, HydraError>

/** Two reads (`slotKeys`, `slotClaims`); a `HydraLimitError` in either degrades to an empty arm marked `timedOut`. */
export const slotMateArm = (
  hydra: HydraClient,
  uid: string,
  candidates: ReadonlyArray<ReachedClaim>,
  alreadyReached: ReadonlySet<string>,
  total: number,
  guard: StageGuard
): Effect.Effect<SlotMateArm, HydraError> =>
  Effect.gen(function* () {
    const expansion = yield* Effect.either(
      Effect.gen(function* () {
        const fills = yield* guard(
          "slotKeys",
          candidates.length === 0
            ? Effect.succeed([])
            : Effect.map(
                hydra.msPaths(candidateSlotsConfig(candidates.map((claim) => claim.ckey))),
                slotFills
              )
        )
        const skeys = [...new Set(fills.map((fill) => fill.skey))].sort()
        const candidateSlotOf = new Map(
          fills.filter((fill) => fill.ckey !== "").map((fill) => [fill.ckey, fill.skey] as const)
        )
        const config = slotClaimsConfig(uid, skeys)
        const paths = yield* guard(
          "slotClaims",
          skeys.length === 0 ? Effect.succeed([]) : hydra.msPaths(config)
        )
        const slotOf = new Map(
          slotFills(paths)
            .filter((fill) => fill.ckey !== "")
            .map((fill) => [fill.ckey, fill.skey] as const)
        )
        const arm: LiveArm = {
          kind: "slotMate",
          label: "slotMate",
          claims: scoreReached(reachedRows(paths), total).map(withoutConvergence),
          query: skeys.length === 0 ? null : renderMsPathsQuery(config).query,
          paths: paths.length,
          rawPaths: [],
          timedOut: false
        }
        return { candidateSlotOf, arm, slotOf }
      })
    )
    if (expansion._tag === "Left") {
      if (expansion.left._tag !== "HydraLimitError") return yield* Effect.fail(expansion.left)
      return { ...emptyArm("slotMate", "slotMate", true), slotOf: new Map<string, string>() }
    }
    const { candidateSlotOf, arm, slotOf } = expansion.right
    return {
      ...arm,
      claims: groupSlotMates(arm.claims, slotOf, alreadyReached, MAX_SLOT_EXPANSION),
      slotOf: new Map([...candidateSlotOf, ...slotOf])
    }
  })
