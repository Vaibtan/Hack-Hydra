import type { DatasetQuestion } from "@palimpsest/dataset"
import type { SessionExtraction } from "@palimpsest/palimpsest"

/**
 * Extraction recall, the day-1 gate.
 *
 * LongMemEval labels every answer-bearing turn with `has_answer`, so recall can
 * be measured without a judge: what fraction of those turns does at least one
 * extracted Claim's Span point into? A turn no Claim points at is a turn the
 * memory can never surface, whatever the retrieval does — so this number is the
 * ceiling on everything downstream.
 */

export interface TurnCoverage {
  readonly sid: string
  readonly turnIdx: number
  readonly covered: boolean
}

export interface QuestionRecall {
  readonly questionId: string
  readonly questionType: string
  readonly answerTurns: number
  readonly coveredTurns: number
  /** `null` when the question has no answer-bearing turns (the `_abs` ones). */
  readonly recall: number | null
  readonly claims: number
  readonly dropped: number
  readonly misses: ReadonlyArray<TurnCoverage>
}

export const questionRecall = (
  question: DatasetQuestion,
  extractions: ReadonlyArray<SessionExtraction>
): QuestionRecall => {
  const coveredBySid = new Map<string, Set<number>>()
  let claims = 0
  let dropped = 0
  for (const extraction of extractions) {
    const turns = coveredBySid.get(extraction.sid) ?? new Set<number>()
    for (const claim of extraction.claims) turns.add(claim.span.turnIdx)
    coveredBySid.set(extraction.sid, turns)
    claims += extraction.claims.length
    dropped += extraction.dropped.length
  }

  const coverage: Array<TurnCoverage> = []
  for (const session of question.sessions) {
    for (const turn of session.turns) {
      if (!turn.hasAnswer) continue
      coverage.push({
        sid: session.sid,
        turnIdx: turn.turnIdx,
        covered: coveredBySid.get(session.sid)?.has(turn.turnIdx) === true
      })
    }
  }

  const coveredTurns = coverage.filter((c) => c.covered).length
  return {
    questionId: question.questionId,
    questionType: question.questionType,
    answerTurns: coverage.length,
    coveredTurns,
    recall: coverage.length === 0 ? null : coveredTurns / coverage.length,
    claims,
    dropped,
    misses: coverage.filter((c) => !c.covered)
  }
}

export interface RecallSummary {
  readonly answerTurns: number
  readonly coveredTurns: number
  readonly recall: number
  readonly claims: number
  readonly dropped: number
}

/**
 * Micro-averaged over turns, not averaged over questions — a question with 12
 * answer turns should weigh twelve times as much as one with a single turn.
 */
export const summarise = (results: ReadonlyArray<QuestionRecall>): RecallSummary => {
  const answerTurns = results.reduce((n, r) => n + r.answerTurns, 0)
  const coveredTurns = results.reduce((n, r) => n + r.coveredTurns, 0)
  return {
    answerTurns,
    coveredTurns,
    recall: answerTurns === 0 ? 1 : coveredTurns / answerTurns,
    claims: results.reduce((n, r) => n + r.claims, 0),
    dropped: results.reduce((n, r) => n + r.dropped, 0)
  }
}

export const byType = (
  results: ReadonlyArray<QuestionRecall>
): ReadonlyArray<readonly [string, RecallSummary]> => {
  const groups = new Map<string, Array<QuestionRecall>>()
  for (const result of results) {
    const bucket = groups.get(result.questionType)
    if (bucket === undefined) groups.set(result.questionType, [result])
    else bucket.push(result)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, group]) => [type, summarise(group)] as const)
}
