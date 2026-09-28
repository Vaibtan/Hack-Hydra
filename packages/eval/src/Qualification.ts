import { Schema } from "effect"
import type { EvalEnvelope, EvalRow } from "./Envelope.js"
import { abstentions, answerable, correct, refused } from "./Results.js"
import { median } from "./Stats.js"

/** Predeclared bounds for the D5 fresh-dev qualification. */
export const QualificationThresholds = Schema.Struct({
  minimumAnswerableCorrectGain: Schema.Number,
  maximumWorstTypeAccuracyRegressionPercentagePoints: Schema.Number,
  maximumFalseAbstentionPercent: Schema.Number,
  minimumAbstentionCorrect: Schema.Number,
  maximumWarmGraphP50Ms: Schema.Number,
  maximumReaderInputTokensP50: Schema.Number
})
/** Parsed D5 qualification bounds. */
export type QualificationThresholds = typeof QualificationThresholds.Type

/** One pass/fail measurement in the fresh-dev qualification gate. */
export interface QualificationCriterion {
  readonly name: string
  readonly measured: number
  readonly bound: number
  readonly comparison: "at least" | "at most"
  readonly passed: boolean
}

/** Complete result of applying the predeclared D5 thresholds. */
export interface QualificationReport {
  readonly passed: boolean
  readonly criteria: ReadonlyArray<QualificationCriterion>
  readonly numbers: Readonly<Record<string, number | string>>
}

/** Refuse a counted answer artifact that is not the frozen cache-only warm measurement. */
export const countedAnswerRefusals = (
  answer: EvalEnvelope,
  manifestSha256: string | null,
  harnessCommit: string
): ReadonlyArray<string> => [
  ...(answer.freezeManifestSha256 === manifestSha256
    ? []
    : ["candidate answer does not identify this qualification manifest"]),
  ...(answer.codeIdentity === harnessCommit
    ? []
    : ["candidate answer has the wrong harness commit"]),
  ...(answer.pass === "warm" ? [] : ["candidate answer is not the counted warm pass"]),
  ...(answer.llmTrace !== undefined &&
  answer.llmTrace.length > 0 &&
  answer.llmTrace.every((call) => call.cache === "hit")
    ? []
    : ["counted candidate answer is not cache-hit-only"])
]

const percentage = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : (100 * numerator) / denominator

const correctByType = (rows: ReadonlyArray<EvalRow>): ReadonlyMap<string, { readonly correct: number; readonly total: number }> => {
  const counts = new Map<string, { correct: number; total: number }>()
  for (const row of answerable(rows)) {
    const current = counts.get(row.questionType) ?? { correct: 0, total: 0 }
    counts.set(row.questionType, { correct: current.correct + (row.judged ? 1 : 0), total: current.total + 1 })
  }
  return counts
}

const worstTypeRegression = (
  baseline: ReadonlyArray<EvalRow>,
  candidate: ReadonlyArray<EvalRow>
): { readonly type: string; readonly points: number } => {
  const before = correctByType(baseline)
  const after = correctByType(candidate)
  let worst = { type: "none", points: 0 }
  for (const type of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const left = before.get(type) ?? { correct: 0, total: 0 }
    const right = after.get(type) ?? { correct: 0, total: 0 }
    const points = percentage(left.correct, left.total) - percentage(right.correct, right.total)
    if (points > worst.points) worst = { type, points }
  }
  return worst
}

/** Apply the immutable D5 thresholds to exact-upstream-scored v1 and v2 dev rows. */
export const readQualification = (
  baseline: ReadonlyArray<EvalRow>,
  candidate: ReadonlyArray<EvalRow>,
  thresholds: QualificationThresholds
): QualificationReport => {
  const baselineAnswerable = answerable(baseline)
  const candidateAnswerable = answerable(candidate)
  const gain = correct(candidateAnswerable) - correct(baselineAnswerable)
  const regression = worstTypeRegression(baseline, candidate)
  const falseAbstentionPercent = percentage(candidateAnswerable.filter(refused).length, candidateAnswerable.length)
  const abstentionCorrect = correct(abstentions(candidate))
  const graphMsP50 = median(candidate.flatMap((row) => row.graphMs === undefined ? [] : [row.graphMs]))
  const readerTokensP50 = median(candidate.map((row) => row.readerInputTokens))
  const criteria: ReadonlyArray<QualificationCriterion> = [
    { name: "answerable correct gain", measured: gain, bound: thresholds.minimumAnswerableCorrectGain, comparison: "at least", passed: gain >= thresholds.minimumAnswerableCorrectGain },
    { name: "worst type accuracy regression (percentage points)", measured: regression.points, bound: thresholds.maximumWorstTypeAccuracyRegressionPercentagePoints, comparison: "at most", passed: regression.points <= thresholds.maximumWorstTypeAccuracyRegressionPercentagePoints },
    { name: "false abstention on answerable (%)", measured: falseAbstentionPercent, bound: thresholds.maximumFalseAbstentionPercent, comparison: "at most", passed: falseAbstentionPercent <= thresholds.maximumFalseAbstentionPercent },
    { name: "abstention questions correct", measured: abstentionCorrect, bound: thresholds.minimumAbstentionCorrect, comparison: "at least", passed: abstentionCorrect >= thresholds.minimumAbstentionCorrect },
    { name: "warm graph p50 (ms)", measured: graphMsP50, bound: thresholds.maximumWarmGraphP50Ms, comparison: "at most", passed: graphMsP50 <= thresholds.maximumWarmGraphP50Ms },
    { name: "reader input tokens p50", measured: readerTokensP50, bound: thresholds.maximumReaderInputTokensP50, comparison: "at most", passed: readerTokensP50 <= thresholds.maximumReaderInputTokensP50 }
  ]
  return {
    passed: criteria.every((criterion) => criterion.passed),
    criteria,
    numbers: {
      baselineAnswerableCorrect: correct(baselineAnswerable),
      candidateAnswerableCorrect: correct(candidateAnswerable),
      answerableCorrectGain: gain,
      worstType: regression.type,
      worstTypeAccuracyRegressionPercentagePoints: regression.points,
      falseAbstentionPercent,
      abstentionCorrect,
      graphMsP50,
      readerInputTokensP50: readerTokensP50
    }
  }
}

const duplicateIds = (rows: ReadonlyArray<EvalRow>): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.questionId)) repeated.add(row.questionId)
    else seen.add(row.questionId)
  }
  return [...repeated].sort()
}

/** Reject incomparable or non-upstream-scored envelopes before the D5 gate is read. */
export const qualificationRefusals = (
  baseline: EvalEnvelope,
  candidate: EvalEnvelope,
  expectedRows: number
): ReadonlyArray<string> => {
  const refusals: Array<string> = []
  for (const field of ["split", "prefix", "dataset", "extractionGeneration"] as const) {
    if (baseline[field] !== candidate[field]) {
      refusals.push(`baseline and candidate disagree on ${field}`)
    }
  }
  for (const [label, envelope] of [["baseline", baseline], ["candidate", candidate]] as const) {
    if (envelope.rows.length !== expectedRows) refusals.push(`${label} has ${envelope.rows.length} rows, expected ${expectedRows}`)
    const repeated = duplicateIds(envelope.rows)
    if (repeated.length > 0) refusals.push(`${label} repeats question ids: ${repeated.join(", ")}`)
    if (
      envelope.scoringProtocol?.endpoint !== "chat-completions" ||
      envelope.scoringProtocol.model !== "gpt-4o-2024-08-06" ||
      envelope.scoringProtocol.temperature !== 0 ||
      envelope.scoringProtocol.maxTokens !== 10 ||
      envelope.scoringProtocol.n !== 1 ||
      envelope.scoringProtocol.parser !== "case-insensitive-yes-substring"
    ) {
      refusals.push(`${label} is not scored by the exact upstream protocol`)
    }
    if (envelope.scoreSource === undefined) refusals.push(`${label} does not identify its immutable answer source`)
    if (envelope.rows.some((row) => row.judgeResolvedModel !== "gpt-4o-2024-08-06")) {
      refusals.push(`${label} has rows without the pinned provider-resolved judge model`)
    }
  }
  if (candidate.pass !== "warm") refusals.push("candidate is not the counted warm pass")
  if (candidate.rows.some((row) => row.graphMs === undefined)) refusals.push("candidate has rows without graphMs")
  const baselineById = new Map(baseline.rows.map((row) => [row.questionId, row] as const))
  for (const row of candidate.rows) {
    const before = baselineById.get(row.questionId)
    if (before === undefined) refusals.push(`candidate adds question ${row.questionId}`)
    else if (before.questionType !== row.questionType || before.isAbstention !== row.isAbstention) {
      refusals.push(`question contract differs for ${row.questionId}`)
    }
  }
  const candidateIds = new Set(candidate.rows.map((row) => row.questionId))
  for (const row of baseline.rows) if (!candidateIds.has(row.questionId)) refusals.push(`candidate lacks question ${row.questionId}`)
  return refusals
}
