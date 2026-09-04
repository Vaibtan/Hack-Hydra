import type { DatasetQuestion } from "@palimpsest/dataset"
import type { HydratedSpan, V2Answer } from "@palimpsest/palimpsest"
import type { EvalRow, SystemName } from "./Envelope.js"
import type { Judgement } from "./Judge.js"
import { errorClass } from "./Tables.js"

export interface BaselineRead {
  readonly answer: string
  readonly notInMemory: boolean
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface BaselineOutcome {
  readonly kind: "baseline"
  readonly spans: ReadonlyArray<HydratedSpan>
  readonly sessionsDropped: number
  readonly hash: string
  readonly read: BaselineRead
}

export interface V2Outcome {
  readonly kind: "v2"
  readonly answered: V2Answer
  readonly ablations: ReadonlyArray<string>
}

export type SystemOutcome = BaselineOutcome | V2Outcome

/** One fixed wording per structural reason, so the abstention column measures the verdict and not the phrasing. */
export const absentResponse = (reason: V2Answer["reason"]): string =>
  `I don't have that in my memory. ` +
  (reason === "A1_no_anchors"
    ? "None of the question's search terms exist in this user's memory at all."
    : reason === "INSUFFICIENT_EVIDENCE"
      ? "The memory holds some of what the question needs and, after searching again for the rest, not all of it."
      : reason === "CONTRADICTED_PREMISE"
        ? "The question assumes something the memory contradicts."
        : "Search terms exist but no stored claim was reached by enough of them to answer.")

export const responseOf = (outcome: SystemOutcome): string => {
  if (outcome.kind === "baseline") return outcome.read.answer
  const { answered } = outcome
  if (answered.read === null) return absentResponse(answered.ask.reason)
  return answered.verdict === "ABSENT" ? absentResponse(answered.reason) : answered.read.answer
}

const sessionsOf = (spans: ReadonlyArray<HydratedSpan>): ReadonlyArray<string> =>
  [...new Set(spans.map((span) => span.sid))].sort()

const common = (
  system: SystemName,
  question: DatasetQuestion,
  spans: ReadonlyArray<HydratedSpan>,
  judgement: Judgement,
  latencyMs: number
) => {
  const evidenceSessions = sessionsOf(spans)
  return {
    system,
    questionId: question.questionId,
    questionType: question.questionType,
    isAbstention: question.isAbstention,
    premiseSupported: null,
    judged: judgement.correct,
    judgeTemplate: judgement.template,
    judgeReply: judgement.reply,
    judgeModel: judgement.model,
    evidenceSessions,
    answerSessions: [...question.answerSessionIds],
    sessionHit: question.answerSessionIds.some((sid) => evidenceSessions.includes(sid)),
    evidence: spans.length,
    latencyMs
  }
}

const withErrorClass = (row: EvalRow): EvalRow => ({ ...row, errorClass: errorClass(row) })

export const rowFromBaseline = (
  system: SystemName,
  question: DatasetQuestion,
  outcome: BaselineOutcome,
  judgement: Judgement,
  latencyMs: number
): EvalRow =>
  withErrorClass({
    ...common(system, question, outcome.spans, judgement, latencyMs),
    verdict: "ANSWER",
    reason: null,
    answer: outcome.read.answer,
    notInMemory: outcome.read.notInMemory,
    premiseNote: "",
    anchorsAsked: 0,
    anchorsReachingClaims: 0,
    readerInputTokens: outcome.read.inputTokens,
    readerOutputTokens: outcome.read.outputTokens,
    sessionsDropped: outcome.sessionsDropped,
    hash: outcome.hash,
    route: null
  })

/** HydraDB time of the ask plus the read's hydration, and nothing else. */
export const graphMsOf = (answered: V2Answer): number =>
  answered.ask.timings.graphMs + (answered.read?.hydrateMs ?? 0)

export const rowFromV2 = (
  question: DatasetQuestion,
  outcome: V2Outcome,
  judgement: Judgement,
  latencyMs: number
): EvalRow => {
  const { answered } = outcome
  const { ask, read } = answered
  const plan = ask.plan
  const base = common("palimpsest-v2", question, read?.spans ?? [], judgement, latencyMs)
  return withErrorClass({
    ...base,
    verdict: answered.verdict,
    reason: answered.reason,
    answer: responseOf(outcome),
    notInMemory: read === null || answered.verdict === "ABSENT" || read.notInMemory,
    premiseNote: read === null ? "" : answered.sufficiency.premise,
    anchorsAsked: ask.receipt.anchorTerms.length,
    anchorsReachingClaims: ask.receipt.anchorsReachingClaims.length,
    readerInputTokens: read?.inputTokens ?? 0,
    readerOutputTokens: read?.outputTokens ?? 0,
    sessionsDropped: 0,
    hash: answered.hash,
    route: plan.route,
    askMs: ask.timings.askMs,
    graphMs: graphMsOf(answered),
    stageTimingsMs:
      read === null
        ? { ...ask.timings.stages }
        : { ...ask.timings.stages, hydrate: read.hydrateMs, read: read.readMs },
    claimHash: ask.hash,
    flags: Object.entries(plan.flags)
      .filter(([, on]) => on === true)
      .map(([name]) => name)
      .sort(),
    selectorFallback: plan.selection.fallback,
    unionSessions: plan.unionSessions,
    sufficiencyTier: plan.sufficiency.tier,
    ...(plan.sufficiency.missing === "" ? {} : { sufficiencyMissing: plan.sufficiency.missing }),
    ...(plan.sufficiency.premise === "" ? {} : { sufficiencyPremise: plan.sufficiency.premise }),
    secondPass: answered.secondPass,
    ...(read === null
      ? {}
      : {
          budgetDroppedSessions: read.pack === null ? [] : sessionsOf(read.pack.dropped),
          ...(plan.budget.dropped.length === 0
            ? {}
            : { budgetDropIds: plan.budget.dropped.map((drop) => drop.id) }),
          ...(plan.budget.overBudget ? { overBudget: true } : {}),
          granularity: read.granularity,
          estimatedTokens: plan.budget.estimatedTokens,
          recited: read.recited
        }),
    keptSessions: base.evidenceSessions,
    ablations: outcome.ablations
  })
}
