import type { EvalRow } from "./Results.js"

/**
 * The adoption gate: whether v2 replaces v1, decided once, on dev, from numbers.
 *
 * Every criterion here was written down in #22 *before* v2 produced a single
 * result. That is the whole value of the thing — a gate chosen after seeing the
 * numbers is not a gate, it is a description of the numbers. So this module
 * takes two dev result sets and a threshold table and returns a pass or a fail
 * with every criterion's measured value beside its bound, whichever way it went.
 *
 * It is deliberately unable to be partially satisfied. `passed` is the
 * conjunction; a run that clears five of six criteria has not passed, and the
 * report says which one it did not.
 */

export interface Criterion {
  readonly name: string
  /** What was measured, in the unit the bound is stated in. */
  readonly measured: number
  readonly bound: number
  readonly comparison: "at least" | "at most"
  readonly passed: boolean
  /** Why this criterion exists, carried into the record so it is never lost. */
  readonly why: string
}

export interface AdoptionGateReport {
  readonly passed: boolean
  readonly criteria: ReadonlyArray<Criterion>
  /** Every number the criteria were computed from, for the split file's record. */
  readonly numbers: Readonly<Record<string, number | string | boolean | null>>
}

/** The bounds, as #22 declared them. */
export const GATE_BOUNDS = {
  /** v2 must win by more than a coin-flip's worth on 54 answerable questions. */
  minCorrectGain: 3,
  /** No question type may get worse by more than one question. */
  maxTypeRegression: 1,
  /** Refusing an answerable question is the expensive failure. */
  maxFalseAbstentionPct: 10,
  /** The index's own latency claim, warm. */
  maxGraphMsP50: 1500,
  /** The "1/30th of full context" claim rests on this. */
  maxReaderTokensP50: 6000
} as const

const p50 = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

const answerable = (rows: ReadonlyArray<EvalRow>): ReadonlyArray<EvalRow> =>
  rows.filter((row) => !row.isAbstention)

const abstentions = (rows: ReadonlyArray<EvalRow>): ReadonlyArray<EvalRow> =>
  rows.filter((row) => row.isAbstention)

const correct = (rows: ReadonlyArray<EvalRow>): number => rows.filter((row) => row.judged).length

/**
 * The worst per-type regression, as a count of questions.
 *
 * Per type and not overall, because a system that gains four on multi-session
 * and loses three on knowledge-update has gained one — and has also broken the
 * feature the graph exists for. The gate refuses to let an aggregate hide that.
 */
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

/**
 * A refusal on a question that has an answer.
 *
 * Both structural abstention and the reader's own `NOT_IN_MEMORY` count. From
 * the asker's side they are the same event — the system declined — and a gate
 * that counted only one of them could be passed by moving refusals from one
 * mechanism to the other.
 */
export const falseAbstentions = (rows: ReadonlyArray<EvalRow>): number =>
  answerable(rows).filter((row) => row.verdict === "ABSENT" || row.notInMemory).length

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

  // Warm rows only. A first-touch row is cold by construction -- 26.5 s versus
  // 68 ms measured on this runtime -- and the latency claim is about a warm
  // node, so the gate is read from a second pass. A results file with no
  // `graphMs` at all fails this criterion rather than skipping it: an
  // unmeasured bound is not a satisfied one.
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
      measured: graphMs.length === 0 ? Number.POSITIVE_INFINITY : Math.round(p50(graphMs)),
      bound: bounds.maxGraphMsP50,
      comparison: "at most",
      passed: graphMs.length > 0 && p50(graphMs) <= bounds.maxGraphMsP50,
      why: "the index's own latency claim, measured on a warm node"
    },
    {
      name: "reader input tokens p50",
      measured: Math.round(p50(readerTokens)),
      bound: bounds.maxReaderTokensP50,
      comparison: "at most",
      passed: p50(readerTokens) <= bounds.maxReaderTokensP50,
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
      graphMsP50: graphMs.length === 0 ? null : Math.round(p50(graphMs)),
      readerTokensP50: Math.round(p50(readerTokens))
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
    lines.push(
      `| ${criterion.name} | ${measured} | ${bound} | ${criterion.passed ? "✓" : "✗"} | ${criterion.why} |`
    )
  }
  if (!report.passed) {
    const failed = report.criteria.filter((criterion) => !criterion.passed).map((c) => c.name)
    lines.push("", `Failed: ${failed.join(", ")}. The test split stays unread.`)
  }
  return lines.join("\n")
}

// -------------------------------------------------------- reading it safely

/**
 * The envelope fields a gate reads across two results files.
 *
 * A subset of the real envelope, because these guards are about whether two
 * files describe **one measurement**, and nothing else about them matters here.
 */
export interface GateEnvelope {
  readonly split?: unknown
  readonly prefix?: unknown
  readonly dataset?: unknown
  readonly extractionGeneration?: unknown
  readonly ablations?: ReadonlyArray<string>
}

/**
 * Why this pair of results files cannot be gated on, or an empty list.
 *
 * Every one of these is a way to read a gate that looks like a comparison and
 * is not, and none of them shows up in the numbers the gate prints: two files
 * from different graphs produce a perfectly plausible table. So the check is a
 * refusal rather than a warning.
 *
 * Lived inline in `bin/gate.ts` until #22's review, which is why it had no
 * tests — and the gate is the one thing in this project that is read once.
 */
export const gateRefusals = (
  v1: GateEnvelope,
  v2: GateEnvelope
): ReadonlyArray<string> => {
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
  const ablations = v2.ablations ?? []
  if (ablations.length > 0) {
    refusals.push(
      `the v2 results are an ablation run (${ablations.join(", ")}) — ` +
        "the gate is read on the full pipeline"
    )
  }
  return refusals
}

/**
 * Why an existing gate record may not be overwritten, or null.
 *
 * The record is the whole of "we did not tune on test": a gate that can be
 * re-read until it passes is not a gate. Overwriting is possible — by deleting
 * the record by hand, in a commit that says why — and that is deliberately not
 * a flag.
 */
export const overwriteRefusal = (existing: { readonly readAt: string } | null): string | null =>
  existing === null
    ? null
    : `the split file already carries a gate record, read at ${existing.readAt}. ` +
      "The gate is read once. Delete the record by hand if it must be re-read, and say " +
      "in the commit message why."
