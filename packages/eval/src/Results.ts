import type { JudgeTemplate } from "./Judge.js"

/**
 * One row per question per system, and the per-type table built from them.
 *
 * Every column the tickets ask for is derivable from a row, so the JSON is the
 * artefact and the Markdown is a rendering of it — a table can be rebuilt
 * without re-running anything, and two runs diff line for line.
 */

/**
 * The systems the harness knows how to run.
 *
 * A closed list, checked at startup. `--system palimsest` used to fall through
 * the `else` in `runOne` and be measured as full context, which produces a
 * plausible table for a system nobody ran.
 */
export const SYSTEM_NAMES = [
  "palimpsest",
  "palimpsest-v2",
  "palimpsest-premise",
  "oracle-session",
  "bm25",
  "fullctx"
] as const

export type SystemName = (typeof SYSTEM_NAMES)[number]

export const isSystemName = (value: string): value is SystemName =>
  SYSTEM_NAMES.some((name) => name === value)

export interface EvalRow {
  readonly system: SystemName
  readonly questionId: string
  readonly questionType: string
  readonly isAbstention: boolean
  /** `ABSENT` only ever comes from Palimpsest; the baselines always read. */
  readonly verdict: "ANSWER" | "ABSENT"
  /** `A1_no_anchors` / `A2_no_convergence`, or null. */
  readonly reason: string | null
  readonly answer: string
  /** The reader said `NOT_IN_MEMORY`, or its premise check failed. */
  readonly notInMemory: boolean
  readonly premiseSupported: boolean | null
  readonly premiseNote: string
  readonly judged: boolean
  readonly judgeTemplate: JudgeTemplate
  readonly judgeReply: string
  readonly judgeModel: string
  readonly evidenceSessions: ReadonlyArray<string>
  readonly answerSessions: ReadonlyArray<string>
  readonly sessionHit: boolean
  readonly evidence: number
  readonly anchorsAsked: number
  readonly anchorsReachingClaims: number
  readonly readerInputTokens: number
  readonly readerOutputTokens: number
  /** B2 only: sessions the context window could not hold. */
  readonly sessionsDropped: number
  readonly latencyMs: number
  readonly hash: string

  // ---- v2 --------------------------------------------------------------
  // Optional, and read defensively everywhere, so a results file written
  // before Retrieval v2 still renders every table it always did.

  /** The primary route the Understand stage chose, or null for v1. */
  readonly route?: string | null
  /** Independent flags that each gated a stage (`wants_count`, `has_time_ref`, …). */
  readonly flags?: ReadonlyArray<string>
  /** Wall time in the HydraDB stages alone — arms, edges, hydration. */
  readonly graphMs?: number
  /** Wall time of the whole ask, LLM stages included. */
  readonly askMs?: number
  readonly stageTimingsMs?: Readonly<Record<string, number>>
  /** `EXACT` / `INFERRABLE` / `PARTIAL`, or `skipped`. */
  readonly sufficiencyTier?: string | null
  /**
   * What the check said was missing, in the question's own words. Present only
   * when it said something: a `PARTIAL` count in a table says the stage fired,
   * and only this says on what — which is the difference between "sufficiency
   * abstained 6 times" and a diagnosis.
   */
  readonly sufficiencyMissing?: string
  /** The premise the check named, when it named one. */
  readonly sufficiencyPremise?: string
  readonly secondPass?: boolean
  /** The listwise selector failed and the deterministic top-25 was used. */
  readonly selectorFallback?: boolean
  /** v1's claim-key hash, kept beside the span hash for continuity. */
  readonly claimHash?: string
  /** Sessions reached by any candidate arm, before selection. */
  readonly unionSessions?: ReadonlyArray<string>
  /** Sessions the selector kept. */
  readonly keptSessions?: ReadonlyArray<string>
  /** Sessions the selector kept and the token budget then dropped. */
  readonly budgetDroppedSessions?: ReadonlyArray<string>
  /** `span` or `turn` — how much of each turn the reader was shown. */
  readonly granularity?: string
  /** The chars/4 estimate of the packed excerpts, beside the provider's count. */
  readonly estimatedTokens?: number
  /** The v2 stages this row ran with switched off, for an ablation table. */
  readonly ablations?: ReadonlyArray<string>
  /** The reader's first answer cited nothing that exists and it was asked again. */
  readonly recited?: boolean
  /** Derived; `pnpm table` recomputes it rather than trusting the file. */
  readonly errorClass?: string | null
}

export interface TypeSummary {
  readonly type: string
  readonly n: number
  /** `_abs` questions the judge scored as a correct refusal. */
  readonly abstentionAccuracy: number | null
  /** Answerable questions the judge scored correct. */
  readonly accuracy: number | null
  /** Answerable questions the system refused — structurally or in the reader. */
  readonly falseAbstention: number | null
  /** Answerable questions whose evidence held an answer-bearing session. */
  readonly sessionRecall: number | null
  readonly readerTokensP50: number
  readonly latencyP50: number
  /** ABSENT verdicts carrying an A1 or A2 receipt. */
  readonly a1: number
  readonly a2: number
}

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator

/**
 * A refusal, counted the same way for every system: the structural verdict, or
 * the reader declining. A baseline has no structural verdict, so for B1 and B2
 * this is purely the reader — which is the honest comparison, since that is the
 * only abstention they can express.
 */
export const refused = (row: EvalRow): boolean => row.verdict === "ABSENT" || row.notInMemory

export const summarise = (rows: ReadonlyArray<EvalRow>, type: string): TypeSummary => {
  const answerable = rows.filter((row) => !row.isAbstention)
  const abstention = rows.filter((row) => row.isAbstention)
  const withEvidence = answerable.filter((row) => row.answerSessions.length > 0)

  return {
    type,
    n: rows.length,
    abstentionAccuracy: ratio(abstention.filter((row) => row.judged).length, abstention.length),
    accuracy: ratio(answerable.filter((row) => row.judged).length, answerable.length),
    falseAbstention: ratio(answerable.filter(refused).length, answerable.length),
    sessionRecall: ratio(withEvidence.filter((row) => row.sessionHit).length, withEvidence.length),
    readerTokensP50: median(rows.map((row) => row.readerInputTokens)),
    latencyP50: median(rows.map((row) => row.latencyMs)),
    a1: rows.filter((row) => row.reason === "A1_no_anchors").length,
    a2: rows.filter((row) => row.reason === "A2_no_convergence").length
  }
}

export const summariseByType = (rows: ReadonlyArray<EvalRow>): ReadonlyArray<TypeSummary> => {
  const groups = new Map<string, Array<EvalRow>>()
  for (const row of rows) {
    const bucket = groups.get(row.questionType)
    if (bucket === undefined) groups.set(row.questionType, [row])
    else bucket.push(row)
  }
  return [
    ...[...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, group]) => summarise(group, type)),
    summarise(rows, "ALL")
  ]
}

const pct = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)} %`

const num = (value: number): string =>
  value >= 1000 ? Math.round(value).toLocaleString("en-US") : value.toFixed(0)

/**
 * The per-type table, abstention column first as #13 asks. One block per
 * system, so the three are read against each other row by row.
 */
export const renderTable = (
  bySystem: ReadonlyArray<readonly [SystemName, ReadonlyArray<EvalRow>]>
): string => {
  const out: Array<string> = []
  for (const [system, rows] of bySystem) {
    out.push(`### ${system}`, "")
    out.push(
      "| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
    )
    for (const s of summariseByType(rows)) {
      const label = s.type === "ALL" ? "**ALL**" : s.type
      out.push(
        `| ${label} | ${s.n} | ${pct(s.abstentionAccuracy)} | ${pct(s.accuracy)} | ` +
          `${pct(s.falseAbstention)} | ${pct(s.sessionRecall)} | ${num(s.readerTokensP50)} | ` +
          `${(s.latencyP50 / 1000).toFixed(2)} s | ${s.a1} | ${s.a2} |`
      )
    }
    out.push("")
  }
  return out.join("\n")
}
