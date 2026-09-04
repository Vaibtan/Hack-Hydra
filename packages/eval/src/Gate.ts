import { envelopeVariant, type EvalEnvelope, type EvalRow } from "./Envelope.js"
import { abstentions, answerable, correct, refused } from "./Results.js"
import { median } from "./Stats.js"

export interface Criterion {
  readonly name: string
  readonly measured: number
  readonly bound: number
  readonly comparison: "at least" | "at most"
  readonly passed: boolean
  readonly why: string
}

export interface AdoptionGateReport {
  readonly passed: boolean
  readonly criteria: ReadonlyArray<Criterion>
  readonly numbers: Readonly<Record<string, number | string | boolean | null>>
}

/** The bounds as #22 declared them, before v2 produced a result. */
export const GATE_BOUNDS = {
  minCorrectGain: 3,
  maxTypeRegression: 1,
  maxFalseAbstentionPct: 10,
  maxGraphMsP50: 1500,
  maxReaderTokensP50: 6000
} as const

export const worstTypeRegression = (
  v1: ReadonlyArray<EvalRow>,
  v2: ReadonlyArray<EvalRow>
): { readonly type: string; readonly delta: number } => {
  const byType = (rows: ReadonlyArray<EvalRow>): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const row of rows) {
      if (row.judged) counts.set(row.questionType, (counts.get(row.questionType) ?? 0) + 1)
    }
    return counts
  }
  const before = byType(v1)
  const after = byType(v2)
  const types = [...new Set([...before.keys(), ...after.keys()])].sort()
  let worst = { type: "none", delta: 0 }
  for (const type of types) {
    const delta = (after.get(type) ?? 0) - (before.get(type) ?? 0)
    if (delta < worst.delta) worst = { type, delta }
  }
  return worst
}

export const falseAbstentions = (rows: ReadonlyArray<EvalRow>): number =>
  answerable(rows).filter(refused).length

export const readGate = (
  v1: ReadonlyArray<EvalRow>,
  v2: ReadonlyArray<EvalRow>,
  bounds: typeof GATE_BOUNDS = GATE_BOUNDS
): AdoptionGateReport => {
  const v1Answerable = answerable(v1)
  const v2Answerable = answerable(v2)
  const gain = correct(v2Answerable) - correct(v1Answerable)
  const regression = worstTypeRegression(v1, v2)
  const falsePct =
    v2Answerable.length === 0 ? 0 : (100 * falseAbstentions(v2)) / v2Answerable.length
  const v1AbsCorrect = correct(abstentions(v1))
  const v2AbsCorrect = correct(abstentions(v2))
  const graphMs = v2.flatMap((row) => (row.graphMs === undefined ? [] : [row.graphMs]))
  const readerTokens = v2.map((row) => row.readerInputTokens)

  const criteria: ReadonlyArray<Criterion> = [
    {
      name: "correct gain on answerable",
      measured: gain,
      bound: bounds.minCorrectGain,
      comparison: "at least",
      passed: gain >= bounds.minCorrectGain,
      why: "v2 must win by more than a coin-flip's worth on 54 questions"
    },
    {
      name: "worst per-type regression",
      measured: regression.delta,
      bound: -bounds.maxTypeRegression,
      comparison: "at least",
      passed: regression.delta >= -bounds.maxTypeRegression,
      why: "an aggregate gain must not hide a broken question type"
    },
    {
      name: "false abstention on answerable (%)",
      measured: Number(falsePct.toFixed(1)),
      bound: bounds.maxFalseAbstentionPct,
      comparison: "at most",
      passed: falsePct <= bounds.maxFalseAbstentionPct,
      why: "refusing an answerable question is the expensive failure"
    },
    {
      name: "_abs questions answered correctly",
      measured: v2AbsCorrect,
      bound: v1AbsCorrect,
      comparison: "at least",
      passed: v2AbsCorrect >= v1AbsCorrect,
      why: "abstention accuracy must not be bought with coverage"
    },
    {
      name: "graphMs p50 warm (ms)",
      measured: graphMs.length === 0 ? Number.POSITIVE_INFINITY : Math.round(median(graphMs)),
      bound: bounds.maxGraphMsP50,
      comparison: "at most",
      passed: graphMs.length > 0 && median(graphMs) <= bounds.maxGraphMsP50,
      why: "the index's own latency claim, measured on a warm node"
    },
    {
      name: "reader input tokens p50",
      measured: Math.round(median(readerTokens)),
      bound: bounds.maxReaderTokensP50,
      comparison: "at most",
      passed: median(readerTokens) <= bounds.maxReaderTokensP50,
      why: "the 1/30th-of-full-context claim rests on this"
    }
  ]

  return {
    passed: criteria.every((criterion) => criterion.passed),
    criteria,
    numbers: {
      v1Answerable: v1Answerable.length,
      v2Answerable: v2Answerable.length,
      v1Correct: correct(v1Answerable),
      v2Correct: correct(v2Answerable),
      gain,
      worstTypeRegressed: regression.type,
      worstTypeDelta: regression.delta,
      falseAbstentions: falseAbstentions(v2),
      falseAbstentionPct: Number(falsePct.toFixed(1)),
      v1AbsCorrect,
      v2AbsCorrect,
      absTotal: abstentions(v2).length,
      graphMsP50: graphMs.length === 0 ? null : Math.round(median(graphMs)),
      readerTokensP50: Math.round(median(readerTokens))
    }
  }
}

export const renderGate = (report: AdoptionGateReport): string => {
  const lines = [
    `# Adoption gate — ${report.passed ? "PASSED" : "FAILED"}`,
    "",
    "Every bound below was written down in #22 before v2 produced a result.",
    "",
    "| criterion | measured | bound | | why |",
    "|---|---:|---:|:-:|---|"
  ]
  for (const criterion of report.criteria) {
    const bound = `${criterion.comparison === "at least" ? "≥" : "≤"} ${criterion.bound}`
    const measured = Number.isFinite(criterion.measured) ? String(criterion.measured) : "not measured"
    const boundary =
      criterion.name === "_abs questions answered correctly" && criterion.measured === criterion.bound
        ? " (at the boundary)"
        : ""
    lines.push(
      `| ${criterion.name} | ${measured}${boundary} | ${bound} | ${criterion.passed ? "✓" : "✗"} | ${criterion.why} |`
    )
  }
  if (!report.passed) {
    const failed = report.criteria.filter((criterion) => !criterion.passed).map((c) => c.name)
    lines.push("", `Failed: ${failed.join(", ")}. The test split stays unread.`)
  }
  return lines.join("\n")
}

export type GateEnvelope = Pick<
  EvalEnvelope,
  "split" | "prefix" | "dataset" | "extractionGeneration" | "ablations" | "variant" | "granularity" | "pass"
>

/** Why this pair of results files cannot be gated on, or an empty list. */
export const gateRefusals = (v1: GateEnvelope, v2: GateEnvelope): ReadonlyArray<string> => {
  const refusals: Array<string> = []
  for (const field of ["split", "prefix", "extractionGeneration", "dataset"] as const) {
    if (v1[field] !== v2[field]) {
      refusals.push(
        `the two results files disagree on \`${field}\`: ` +
          `${JSON.stringify(v1[field])} vs ${JSON.stringify(v2[field])} — ` +
          "a gate read across two populations is not a comparison"
      )
    }
  }
  if (v2.split !== "dev") {
    refusals.push(
      `the gate is read on dev, not ${JSON.stringify(v2.split)} — the test half is read once, ` +
        "after the gate is written down"
    )
  }
  const variant = envelopeVariant(v2)
  if (variant.length > 0) {
    refusals.push(
      `the v2 results are a variant run (${variant.join(", ")}) — the gate is read on the full pipeline`
    )
  }
  if (v2.pass === "cold") {
    refusals.push("the v2 results are a cold pass — the gate reads warm latency from the second pass")
  }
  return refusals
}

/** Why an existing gate record may not be overwritten, or null; deleting it by hand is the only way. */
export const overwriteRefusal = (existing: { readonly readAt: string } | null): string | null =>
  existing === null
    ? null
    : `the split file already carries a gate record, read at ${existing.readAt}. ` +
      "The gate is read once. Delete the record by hand if it must be re-read, and say " +
      "in the commit message why."
