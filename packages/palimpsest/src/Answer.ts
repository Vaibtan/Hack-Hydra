import type { LanguageModel } from "@effect/ai"
import type { HydraError } from "@palimpsest/hydra"
import type { Llm } from "@palimpsest/llm"
import { Effect } from "effect"
import { CHARS_PER_TOKEN, READER_TOKEN_BUDGET } from "./Pack.js"
import type {
  AnsweredPlan,
  AskOptions,
  AskResult,
  PlanBudget,
  PlanSufficiency,
  RetrievalPlan
} from "./Plan.js"
import type { Granularity, ReadAnswer, ReadOptions, Reader } from "./Reader.js"
import type { Retrieve } from "./Retrieve.js"
import type { AbstentionReason } from "./Scoring.js"
import {
  abstains,
  judgeSufficiency,
  premiseContradiction,
  runsOn,
  skipped,
  type SufficiencyReport
} from "./Sufficiency.js"
import type { Route } from "./Understand.js"

/** An ask whose plan has been through the pack and the sufficiency check. */
export interface AnsweredAsk extends AskResult {
  readonly plan: AnsweredPlan
}

export interface V2Answer {
  readonly ask: AnsweredAsk
  /** The final read; `null` when the verdict was `ABSENT` before reading. */
  readonly read: ReadAnswer | null
  readonly verdict: "ANSWER" | "ABSENT"
  readonly reason: AbstentionReason | null
  readonly sufficiency: SufficiencyReport
  readonly secondPass: boolean
  readonly passes: number
  /** The read's span hash when there was a read, else the ask's claim hash. */
  readonly hash: string
}

export interface AnswerOptions extends AskOptions {
  /** Forces one granularity for every route, for the `span|turn` ablation. */
  readonly granularity?: Granularity
  readonly noSufficiency?: boolean
  /** Drops the route rules block from the reader prompt only, for `--reader-route=off`. */
  readonly noReaderRoute?: boolean
}

const readOptionsFor = (
  route: Route,
  plan: RetrievalPlan,
  options: AnswerOptions
): ReadOptions => ({
  route,
  ...(options.noReaderRoute === true ? { noReaderRoute: true } : {}),
  ...(options.granularity === undefined ? {} : { granularity: options.granularity }),
  slotOf: new Map(Object.entries(plan.slots)),
  protectedKeys: new Set(plan.protectedKeys)
})

const planSufficiency = (
  report: SufficiencyReport,
  read: ReadAnswer | null,
  secondPass: boolean
): PlanSufficiency => ({
  tier: report.skipped ? "skipped" : report.tier,
  missing: report.missing,
  premise: report.premise,
  premiseContradictedBy:
    read === null ? [] : (premiseContradiction(report, read.spans)?.citedIds ?? []),
  secondPass
})

const planBudget = (read: ReadAnswer | null): PlanBudget =>
  read === null || read.pack === null
    ? {
        budget: READER_TOKEN_BUDGET,
        estimatedTokens: 0,
        charsPerToken: CHARS_PER_TOKEN,
        dropped: [],
        overBudget: false
      }
    : {
        budget: READER_TOKEN_BUDGET,
        estimatedTokens: read.pack.estimatedTokens,
        charsPerToken: read.pack.charsPerToken,
        dropped: read.pack.drops.map((drop) => ({
          id: drop.id,
          reason: drop.reason,
          chars: drop.chars
        })),
        overBudget: read.pack.overBudget
      }

interface Outcome {
  readonly ask: AskResult
  readonly read: ReadAnswer | null
  readonly report: SufficiencyReport
  readonly secondPass: boolean
  readonly verdict: "ANSWER" | "ABSENT"
  readonly reason: AbstentionReason | null
}

const assemble = (outcome: Outcome): V2Answer => ({
  ask: {
    ...outcome.ask,
    plan: {
      ...outcome.ask.plan,
      sufficiency: planSufficiency(outcome.report, outcome.read, outcome.secondPass),
      budget: planBudget(outcome.read)
    }
  },
  read: outcome.read,
  verdict: outcome.verdict,
  reason: outcome.reason,
  sufficiency: outcome.report,
  secondPass: outcome.secondPass,
  passes: outcome.secondPass ? 2 : 1,
  hash: outcome.read === null ? outcome.ask.hash : outcome.read.spanHash
})

/** An ask that was never read: the plan completed with a skipped check and an empty budget. */
export const unreadAnswer = (ask: AskResult): V2Answer =>
  assemble({
    ask,
    read: null,
    report: skipped(),
    secondPass: false,
    verdict: ask.verdict,
    reason: ask.reason
  })

/** The whole read path: retrieve, pack, check, at most one refined pass, read. */
export const answerV2 = (
  retrieve: Retrieve,
  reader: Reader,
  uid: string,
  question: string,
  questionDate: string,
  options: AnswerOptions = {}
): Effect.Effect<V2Answer, HydraError, LanguageModel.LanguageModel | Llm> =>
  Effect.gen(function* () {
    const profile = options.profile ?? "full"
    const askOptions = { ...options, questionDate }

    const first = yield* retrieve.ask(uid, question, askOptions)
    if (first.verdict === "ABSENT") return unreadAnswer(first)

    const route = first.plan.route
    const firstRead = yield* reader.read(
      question,
      questionDate,
      first.evidence,
      readOptionsFor(route, first.plan, options)
    )
    const answer = (
      ask: AskResult,
      read: ReadAnswer,
      report: SufficiencyReport,
      secondPass: boolean
    ): V2Answer =>
      assemble({ ask, read, report, secondPass, verdict: "ANSWER", reason: null })
    const contradicted = (
      ask: AskResult,
      read: ReadAnswer,
      report: SufficiencyReport,
      secondPass: boolean
    ): V2Answer =>
      assemble({ ask, read, report, secondPass, verdict: "ABSENT", reason: "CONTRADICTED_PREMISE" })

    if (options.noSufficiency === true || !runsOn(route, firstRead.spans, profile)) {
      return answer(first, firstRead, skipped(), false)
    }

    const judged = yield* judgeSufficiency(question, questionDate, route, firstRead.spans)
    if (premiseContradiction(judged, firstRead.spans) !== null) {
      return contradicted(first, firstRead, judged, false)
    }
    if (judged.tier !== "PARTIAL" || judged.missingTerms.length === 0) {
      return answer(first, firstRead, judged, false)
    }

    const second = yield* retrieve.ask(uid, question, {
      ...askOptions,
      extraTerms: judged.missingTerms
    })
    if (second.verdict === "ABSENT") return answer(first, firstRead, judged, true)

    const secondRead = yield* reader.read(
      question,
      questionDate,
      second.evidence,
      readOptionsFor(route, second.plan, options)
    )
    const rejudged = yield* judgeSufficiency(question, questionDate, route, secondRead.spans)
    if (premiseContradiction(rejudged, secondRead.spans) !== null) {
      return contradicted(second, secondRead, rejudged, true)
    }
    return assemble({
      ask: second,
      read: secondRead,
      report: rejudged,
      secondPass: true,
      verdict: abstains(rejudged) ? "ABSENT" : "ANSWER",
      reason: abstains(rejudged) ? "INSUFFICIENT_EVIDENCE" : null
    })
  })
