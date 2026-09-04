import { renderMsPathsQuery } from "@palimpsest/hydra"
import type { ReadPathModels } from "@palimpsest/llm"
import { createHash } from "node:crypto"
import {
  convergenceConfig,
  unionArms,
  type ArmKind,
  type Candidate,
  type LiveArm,
  type UnionReport
} from "./Arms.js"
import type { Gathered } from "./Gather.js"
import type { BudgetDropReason } from "./Pack.js"
import { shortId, type DropReason, type SelectionReport } from "./Select.js"
import {
  convergenceThreshold,
  rank,
  type AbstentionReason,
  type AsOfLabelled
} from "./Scoring.js"
import { applyTimeScope, intervalSentence, type DayInterval, type TimeScopeReport } from "./TimeScope.js"
import type { Route, Understood } from "./Understand.js"

/** What every stage of the read decided and on what; a judge re-derives the evidence set from this. */
export interface RetrievalPlan {
  readonly route: Route
  /** `model`, or `cue:<name>` when a deterministic cue overrode the model. */
  readonly routeReason: string
  readonly flags: Understood["flags"]
  readonly subQuestions: ReadonlyArray<string>
  readonly probes: ReadonlyArray<string>
  /** Non-empty only on a refined second pass: the terms sufficiency asked for. */
  readonly extraTerms: ReadonlyArray<string>
  readonly arms: ReadonlyArray<PlanArm>
  readonly union: { readonly candidates: number; readonly dropped: number }
  readonly timeScope: {
    readonly phrase: string | null
    readonly interval: readonly [number, number] | null
    readonly inScope: number
    readonly outOfScope: number
    readonly applied: boolean
  }
  readonly selection: {
    readonly kept: ReadonlyArray<string>
    readonly dropped: ReadonlyArray<{ readonly id: string; readonly reason: DropReason }>
    readonly reasons: Readonly<Record<string, string>>
    readonly fallback: boolean
  }
  readonly intervalSentence: string | null
  /** Which Slot each surviving candidate fills. */
  readonly slots: Readonly<Record<string, string>>
  /** Kept claims the budget may never drop: the probe hits. */
  readonly protectedKeys: ReadonlyArray<string>
  /** Every session any arm reached, before selection. */
  readonly unionSessions: ReadonlyArray<string>
  readonly ablations: Ablations
}

export interface PlanArm {
  readonly label: string
  readonly kind: ArmKind
  readonly claims: number
  readonly paths: number
  readonly query: string | null
  readonly timedOut: boolean
}

/** A plan that has been through the pack and the sufficiency check; only `answerV2` produces one. */
export type AnsweredPlan = RetrievalPlan & {
  readonly sufficiency: PlanSufficiency
  readonly budget: PlanBudget
}

export interface PlanBudget {
  readonly budget: number
  readonly estimatedTokens: number
  readonly charsPerToken: number
  readonly dropped: ReadonlyArray<{
    readonly id: string
    readonly reason: BudgetDropReason
    readonly chars: number
  }>
  /** The pack exceeds the budget and nothing left in it may be dropped. */
  readonly overBudget: boolean
}

export interface PlanSufficiency {
  /** `skipped` when the check did not run, which `SufficiencyReport` reports as `EXACT`. */
  readonly tier: "EXACT" | "INFERRABLE" | "PARTIAL" | "skipped"
  readonly missing: string
  readonly premise: string
  /** Excerpt ids the check cited, after the CURRENT-and-in-pack verification. */
  readonly premiseContradictedBy: ReadonlyArray<string>
  readonly secondPass: boolean
}

/** Everything a judge needs to re-run the read by hand and get the same paths. */
export interface Receipt {
  readonly question: string
  readonly uid: string
  readonly profile: AskProfile
  readonly asOf: number | null
  readonly anchorTerms: ReadonlyArray<string>
  /** Anchors that reached at least one Claim; a Token with no HITS edge counts as reaching nothing. */
  readonly anchorsReachingClaims: ReadonlyArray<string>
  readonly anchorsReachingNothing: ReadonlyArray<string>
  readonly historical: boolean
  readonly wantsCount: boolean
  readonly timeRef: string | null
  readonly convergenceThreshold: number
  /** The idf denominator: the whole-history claim count, not the as-of count. */
  readonly totalClaims: number
  readonly query1: string
  readonly query1Params: Record<string, string | number>
  readonly query1Paths: number
  readonly query2: string | null
  readonly query2Paths: number
  readonly models: ReadPathModels
  readonly convergence: ReadonlyArray<{
    readonly ckey: string
    readonly convergence: number
    readonly score: number
    readonly anchors: ReadonlyArray<string>
  }>
}

export interface AskResult {
  readonly verdict: "ANSWER" | "ABSENT"
  readonly reason: AbstentionReason | null
  readonly evidence: ReadonlyArray<AsOfLabelled>
  readonly receipt: Receipt
  /** sha256 over the sorted evidence claim keys. */
  readonly hash: string
  readonly timings: AskTimings
  readonly plan: RetrievalPlan
}

/** `graphMs` is HydraDB alone, from the understand call's return to the last read; `askMs` is everything. */
export interface AskTimings {
  readonly askMs: number
  readonly graphMs: number
  /** Per-stage wall time. Concurrent stages overlap, so these do not sum to `graphMs`. */
  readonly stages: Readonly<Record<string, number>>
}

/** `fast` drops the sufficiency check and its second pass. */
export type AskProfile = "full" | "fast"

export interface AskOptions {
  /** The question's own date, verbatim; part of the understand cache key. */
  readonly questionDate?: string
  readonly asOf?: number
  readonly historical?: boolean
  readonly topK?: number
  readonly maxLen?: number
  readonly profile?: AskProfile
  readonly ablations?: Ablations
  /** Extra anchor terms for the refined second pass. */
  readonly extraTerms?: ReadonlyArray<string>
}

/** Each switches off exactly one stage; off means skipped, not run and ignored. */
export interface Ablations {
  readonly noDecompose?: boolean
  readonly noDiscovery?: boolean
  readonly noTimeScope?: boolean
  readonly noSelect?: boolean
}

/** `2023/04/10 (Mon) 17:50` to `20230410`; zero when there is no date. */
export const questionDateInt = (raw?: string): number => {
  if (raw === undefined) return 0
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(raw.trim())
  if (match === null) return 0
  return Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3])
}

export const determinismHash = (ckeys: ReadonlyArray<string>): string =>
  createHash("sha256").update([...ckeys].sort().join("\n"), "utf8").digest("hex")

export const unionOptionsFor = (asOf: number | undefined): { readonly asOf?: number } =>
  asOf === undefined ? {} : { asOf }

/** The pure half of an ask: what the arms returned, unioned, scoped and judged for a verdict. */
export interface Planned {
  readonly arms: ReadonlyArray<LiveArm>
  readonly union: UnionReport
  readonly interval: DayInterval | null
  readonly scoped: TimeScopeReport<Candidate>
  readonly resolved: ReadonlySet<string>
  readonly threshold: number
  /** Candidates that can carry a verdict: probe and sub-question hits, or convergence at the threshold. */
  readonly grounded: ReadonlyArray<Candidate>
  readonly receipt: Receipt
  readonly plan: Omit<RetrievalPlan, "protectedKeys" | "selection">
}

/** What `planFromArms` needs of a gather; `Gathered` satisfies it. */
export type PlanInput = Pick<
  Gathered,
  | "uid"
  | "question"
  | "understood"
  | "terms"
  | "extraTerms"
  | "total"
  | "historical"
  | "profile"
  | "maxLen"
  | "topK"
  | "questionDate"
  | "asOf"
  | "ablations"
  | "models"
  | "reaching"
  | "discovery"
  | "slotMate"
>

export const planFromArms = (gathered: PlanInput): Planned => {
  const { understood, terms, reaching, discovery, slotMate, topK, maxLen, uid } = gathered
  const arms: ReadonlyArray<LiveArm> = [...reaching, discovery, slotMate]
  const union = unionArms(arms, unionOptionsFor(gathered.asOf))
  const convergence = reaching[0]!

  const interval =
    gathered.questionDate > 0 && gathered.ablations.noTimeScope !== true
      ? understood.timeInterval
      : null
  const scoped = applyTimeScope(union.candidates, interval)

  const resolved = new Set(
    reaching.flatMap((arm) => arm.claims).flatMap((claim) => claim.anchors)
  )
  const threshold = convergenceThreshold(resolved.size)
  const grounded = scoped.claims.filter(
    (candidate) =>
      candidate.kind === "probe" ||
      candidate.kind === "subQuestion" ||
      candidate.convergence >= threshold
  )

  const rendered = renderMsPathsQuery(convergenceConfig(uid, terms, maxLen))
  const receipt: Receipt = {
    question: gathered.question,
    uid,
    profile: gathered.profile,
    asOf: gathered.asOf ?? null,
    anchorTerms: terms,
    anchorsReachingClaims: [...resolved].sort(),
    anchorsReachingNothing: terms.filter((stem) => !resolved.has(stem)),
    historical: gathered.historical,
    wantsCount: understood.flags.wantsCount,
    timeRef: understood.timeRef,
    convergenceThreshold: threshold,
    totalClaims: gathered.total,
    query1: convergence.query ?? rendered.query,
    query1Params: rendered.parameters,
    query1Paths: convergence.paths,
    query2: slotMate.query,
    query2Paths: slotMate.paths,
    models: gathered.models,
    convergence: rank(union.candidates)
      .slice(0, topK)
      .map((claim) => ({
        ckey: claim.ckey,
        convergence: claim.convergence,
        score: Number(claim.score.toFixed(4)),
        anchors: claim.anchors
      }))
  }

  const plan: Planned["plan"] = {
    route: understood.route,
    routeReason: understood.routeReason,
    flags: understood.flags,
    subQuestions: understood.subQuestions.map((sub) => sub.question),
    probes: understood.probes.map((probe) => `${probe.entityCanon}|${probe.attr}`),
    extraTerms: gathered.extraTerms,
    arms: arms.map((arm) => ({
      label: arm.label,
      kind: arm.kind,
      claims: arm.claims.length,
      paths: arm.paths,
      query: arm.query,
      timedOut: arm.timedOut
    })),
    union: { candidates: union.candidates.length, dropped: union.dropped.length },
    timeScope: {
      phrase: understood.timeRef,
      interval: interval === null ? null : ([interval.start, interval.end] as const),
      inScope: scoped.inScope,
      outOfScope: scoped.outOfScope,
      applied: scoped.applied
    },
    intervalSentence: interval === null ? null : intervalSentence(interval),
    slots: Object.fromEntries(
      union.candidates.flatMap((candidate) => {
        const slot = slotMate.slotOf.get(candidate.ckey)
        return slot === undefined ? [] : [[candidate.ckey, slot] as const]
      })
    ),
    unionSessions: [...new Set(union.candidates.map((candidate) => candidate.sid))].sort(),
    ablations: gathered.ablations
  }

  return { arms, union, interval, scoped, resolved, threshold, grounded, receipt, plan }
}

export const abstentionReason = (planned: Planned): AbstentionReason =>
  planned.resolved.size === 0 ? "A1_no_anchors" : "A2_no_convergence"

export const selectionRow = (
  applied: SelectionReport,
  reasons: Readonly<Record<string, string>>
): RetrievalPlan["selection"] => ({
  kept: applied.kept.map((candidate) => shortId(candidate.ckey)),
  dropped: applied.dropped.map((drop) => ({
    id: shortId(drop.candidate.ckey),
    reason: drop.reason
  })),
  reasons,
  fallback: applied.fallback
})

export const emptySelection: RetrievalPlan["selection"] = {
  kept: [],
  dropped: [],
  reasons: {},
  fallback: false
}
