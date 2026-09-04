import type { EvalRow, SystemName } from "./Envelope.js"
import { median, pct, ratio } from "./Stats.js"

export interface TypeSummary {
  readonly type: string
  readonly n: number
  readonly abstentionAccuracy: number | null
  readonly accuracy: number | null
  readonly falseAbstention: number | null
  readonly sessionRecall: number | null
  readonly readerTokensP50: number
  readonly latencyP50: number
  readonly a1: number
  readonly a2: number
}

/** A structural ABSENT or the reader declining; for a baseline only the latter exists. */
export const refused = (row: EvalRow): boolean => row.verdict === "ABSENT" || row.notInMemory

export const answerable = (rows: ReadonlyArray<EvalRow>): ReadonlyArray<EvalRow> =>
  rows.filter((row) => !row.isAbstention)

export const abstentions = (rows: ReadonlyArray<EvalRow>): ReadonlyArray<EvalRow> =>
  rows.filter((row) => row.isAbstention)

export const correct = (rows: ReadonlyArray<EvalRow>): number => rows.filter((row) => row.judged).length

export const summarise = (rows: ReadonlyArray<EvalRow>, type: string): TypeSummary => {
  const answered = answerable(rows)
  const abstained = abstentions(rows)
  const withEvidence = answered.filter((row) => row.answerSessions.length > 0)
  return {
    type,
    n: rows.length,
    abstentionAccuracy: ratio(correct(abstained), abstained.length),
    accuracy: ratio(correct(answered), answered.length),
    falseAbstention: ratio(answered.filter(refused).length, answered.length),
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

const num = (value: number): string =>
  value >= 1000 ? Math.round(value).toLocaleString("en-US") : value.toFixed(0)

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

/** The immediate per-type table `eval` writes; `pnpm table` rebuilds the full document later. */
export const renderRunTable = (input: {
  readonly population: string
  readonly dataset: string
  readonly prefix: string
  readonly profile: string
  readonly readerModel: string
  readonly judgeModel: string
  readonly measured: number
  readonly requested: number
  readonly bySystem: ReadonlyArray<readonly [SystemName, ReadonlyArray<EvalRow>]>
}): string =>
  [
    `# LongMemEval — ${input.measured}-question ${input.population}`,
    "",
    `Dataset \`longmemeval_${input.dataset}\`, prefix \`${input.prefix}\`, profile \`${input.profile}\`. Reader ` +
      `\`${input.readerModel}\`, judge \`${input.judgeModel}\` with the official LongMemEval templates. Every ` +
      "number replays from `.cache/llm` for $0.00.",
    ...(input.measured === input.requested
      ? []
      : [
          "",
          `> **Partial ${input.population}.** ${input.measured} of a requested ${input.requested} questions. ` +
            `The other ${input.requested - input.measured} users are not indexed in this graph, so they are ` +
            `excluded rather than counted as retrieval failures. Every column below is over the ${input.measured} that are.`
        ]),
    "",
    renderTable(input.bySystem)
  ].join("\n")
