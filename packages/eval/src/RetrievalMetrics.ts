import type { DatasetQuestion } from "@palimpsest/dataset"
import type { AskResult } from "@palimpsest/palimpsest"

/**
 * Retrieval metrics that need no judge.
 *
 * LongMemEval gives `answer_session_ids` for every answerable question and
 * marks the 30 unanswerable ones with an `_abs` suffix, so both halves of the
 * day-3 gate — did the evidence contain a session that holds the answer, and
 * did we abstain when we shouldn't have — are computable from labels alone.
 */

export interface QuestionRetrieval {
  readonly questionId: string
  readonly questionType: string
  readonly isAbstention: boolean
  readonly verdict: AskResult["verdict"]
  readonly reason: AskResult["reason"]
  /** Distinct sessions the evidence came from. */
  readonly evidenceSessions: ReadonlyArray<string>
  readonly answerSessions: ReadonlyArray<string>
  /** An answer-bearing session appears in the evidence. */
  readonly sessionHit: boolean
  readonly evidence: number
  readonly anchorsAsked: number
  readonly anchorsResolved: number
  readonly topConvergence: number
  readonly latencyMs: number
}

export const scoreQuestion = (
  question: DatasetQuestion,
  result: AskResult,
  latencyMs: number
): QuestionRetrieval => {
  const evidenceSessions = [...new Set(result.evidence.map((claim) => claim.sid))].sort()
  const answerSessions = [...question.answerSessionIds]
  return {
    questionId: question.questionId,
    questionType: question.questionType,
    isAbstention: question.isAbstention,
    verdict: result.verdict,
    reason: result.reason,
    evidenceSessions,
    answerSessions,
    sessionHit: answerSessions.some((sid) => evidenceSessions.includes(sid)),
    evidence: result.evidence.length,
    anchorsAsked: result.receipt.anchorTerms.length,
    anchorsResolved: result.receipt.anchorsResolved.length,
    topConvergence: result.receipt.convergence[0]?.convergence ?? 0,
    latencyMs
  }
}

export interface GateReport {
  readonly answerable: number
  /** Answerable questions whose evidence included an answer-bearing session. */
  readonly sessionRecall: number
  /** Answerable questions we refused to answer. The gate's second half. */
  readonly falseAbstention: number
  readonly abstentionQuestions: number
  /** Of the `_abs` questions, how many we correctly refused. */
  readonly abstentionRecall: number | null
  /** Of everything we refused, how many should have been refused. */
  readonly abstentionPrecision: number | null
  readonly a1: number
  readonly a2: number
  readonly medianLatencyMs: number
}

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export const gateReport = (results: ReadonlyArray<QuestionRetrieval>): GateReport => {
  const answerable = results.filter((r) => !r.isAbstention)
  const abstentions = results.filter((r) => r.isAbstention)
  const refused = results.filter((r) => r.verdict === "ABSENT")

  return {
    answerable: answerable.length,
    sessionRecall:
      answerable.length === 0 ? 0 : answerable.filter((r) => r.sessionHit).length / answerable.length,
    falseAbstention:
      answerable.length === 0
        ? 0
        : answerable.filter((r) => r.verdict === "ABSENT").length / answerable.length,
    abstentionQuestions: abstentions.length,
    abstentionRecall:
      abstentions.length === 0
        ? null
        : abstentions.filter((r) => r.verdict === "ABSENT").length / abstentions.length,
    abstentionPrecision:
      refused.length === 0 ? null : refused.filter((r) => r.isAbstention).length / refused.length,
    a1: results.filter((r) => r.reason === "A1_no_anchors").length,
    a2: results.filter((r) => r.reason === "A2_no_convergence").length,
    medianLatencyMs: median(results.map((r) => r.latencyMs))
  }
}

export const gateByType = (
  results: ReadonlyArray<QuestionRetrieval>
): ReadonlyArray<readonly [string, GateReport]> => {
  const groups = new Map<string, Array<QuestionRetrieval>>()
  for (const result of results) {
    const bucket = groups.get(result.questionType)
    if (bucket === undefined) groups.set(result.questionType, [result])
    else bucket.push(result)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, group]) => [type, gateReport(group)] as const)
}
