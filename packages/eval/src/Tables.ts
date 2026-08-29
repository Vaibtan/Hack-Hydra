import type { EvalRow } from "./Results.js"

/**
 * Every table this project publishes, rebuilt from results JSON alone.
 *
 * Until now the tables were rendered inline by `eval.ts`, which meant that
 * re-reading a number required a live graph, a reader and a judge. The JSON was
 * always the artefact; this module makes that true in practice, so `pnpm table`
 * can regenerate a paired comparison from files that were committed months ago.
 *
 * Nothing here is a statistical convenience. The paired test is exact, the
 * interval is the one the 2026-08-20 audit computed by hand, and both are
 * reported next to the raw 2×2 so a reader can redo the arithmetic.
 */

// ---------------------------------------------------------------- error class

/**
 * Where an incorrect answer was lost.
 *
 * Ordered as a funnel: a question that never reached the right session cannot
 * have been lost by the selector, and one the selector dropped cannot have been
 * lost by the reader. `null` means the judge scored the row correct.
 */
export type ErrorClass = "premise" | "retrieval_miss" | "selection" | "packing" | "reader"

/**
 * The funnel is decided from three optional arrays a v2 row records
 * (`unionSessions`, `keptSessions`, `budgetDroppedSessions`).
 *
 * v1 rows carry none of them, and the classifier says so rather than guessing:
 * without a candidate union there is no way to tell a retrieval miss from a
 * selection loss, so a v1 row that reached the answer session is `reader`.
 */

const hits = (
  answerSessions: ReadonlyArray<string>,
  candidate: ReadonlyArray<string> | undefined
): boolean | null =>
  candidate === undefined ? null : answerSessions.some((sid) => candidate.includes(sid))

export const errorClass = (row: EvalRow): ErrorClass | null => {
  if (row.judged) return null
  // An `_abs` question has no answer session to reach, so the only way to be
  // wrong is to have answered a question whose premise the memory does not
  // support.
  if (row.isAbstention) return "premise"

  const inUnion = hits(row.answerSessions, row.unionSessions)
  if (inUnion === false) return "retrieval_miss"
  // v1: no union recorded. `sessionHit` is the same question asked of the
  // evidence that survived, which is the strongest statement the row supports.
  if (inUnion === null && !row.sessionHit) return "retrieval_miss"

  if (hits(row.answerSessions, row.budgetDroppedSessions) === true) return "packing"
  if (hits(row.answerSessions, row.keptSessions) === false) return "selection"
  return "reader"
}

export const ERROR_CLASSES: ReadonlyArray<ErrorClass> = [
  "retrieval_miss",
  "selection",
  "packing",
  "reader",
  "premise"
]

export interface ErrorClassCounts {
  readonly system: string
  readonly wrong: number
  readonly counts: Readonly<Record<ErrorClass, number>>
}

export const errorClasses = (
  system: string,
  rows: ReadonlyArray<EvalRow>
): ErrorClassCounts => {
  const counts = { retrieval_miss: 0, selection: 0, packing: 0, reader: 0, premise: 0 }
  let wrong = 0
  for (const row of rows) {
    const cls = errorClass(row)
    if (cls === null) continue
    wrong++
    counts[cls]++
  }
  return { system, wrong, counts }
}

// ------------------------------------------------------------------- McNemar

const factorialLog: Array<number> = [0]
const logFactorial = (n: number): number => {
  for (let i = factorialLog.length; i <= n; i++) factorialLog[i] = factorialLog[i - 1]! + Math.log(i)
  return factorialLog[n]!
}

/** `C(n, k)` via log-gamma, so `n = 140` does not overflow a double. */
const binomialPmfHalf = (n: number, k: number): number =>
  Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k) - n * Math.LN2)

export interface PairedTable {
  /** Correct in both systems. */
  readonly both: number
  /** Correct in the left system only. */
  readonly leftOnly: number
  /** Correct in the right system only. */
  readonly rightOnly: number
  readonly neither: number
  readonly n: number
}

export interface PairedResult extends PairedTable {
  /** Exact two-sided McNemar/binomial p over the discordant pairs. */
  readonly p: number
  /** left − right, in percentage points. */
  readonly differencePoints: number
  readonly ciLowPoints: number
  readonly ciHighPoints: number
}

/**
 * The exact two-sided McNemar test.
 *
 * Only the discordant pairs inform it: under the null each is a fair coin, so
 * `p = 2 · P(Binomial(b + c, ½) ≤ min(b, c))`, clamped at 1. No continuity
 * correction and no chi-square approximation — with eight discordant pairs the
 * approximation is not defensible, and the exact form is one line.
 */
export const mcnemarExact = (leftOnly: number, rightOnly: number): number => {
  const discordant = leftOnly + rightOnly
  if (discordant === 0) return 1
  const smaller = Math.min(leftOnly, rightOnly)
  let tail = 0
  for (let k = 0; k <= smaller; k++) tail += binomialPmfHalf(discordant, k)
  return Math.min(1, 2 * tail)
}

/** 95 % two-sided normal quantile. */
const Z95 = 1.959963984540054

/**
 * A 95 % interval for the paired difference, from the per-question differences
 * themselves.
 *
 * Each question contributes `+1` (left only), `−1` (right only) or `0`, so the
 * paired difference is their mean and the interval is `mean ± z · s/√n` with
 * the sample standard deviation. This reproduces the audit's hand-computed
 * −6.61 to +14.02 points for the 38/5/3/8 table, which is the point: the number
 * in the writeup and the number this function prints have to be the same number.
 */
export const pairedDifferenceCi = (
  table: PairedTable
): { readonly points: number; readonly lowPoints: number; readonly highPoints: number } => {
  const { leftOnly, rightOnly, n } = table
  if (n === 0) return { points: 0, lowPoints: 0, highPoints: 0 }
  const mean = (leftOnly - rightOnly) / n
  if (n < 2) return { points: mean * 100, lowPoints: mean * 100, highPoints: mean * 100 }
  const sumSquares = leftOnly + rightOnly
  const variance = (sumSquares - n * mean * mean) / (n - 1)
  const halfWidth = Z95 * Math.sqrt(Math.max(0, variance) / n)
  return {
    points: mean * 100,
    lowPoints: (mean - halfWidth) * 100,
    highPoints: (mean + halfWidth) * 100
  }
}

/**
 * Pairs two systems on the questions both ran, answerable only.
 *
 * `_abs` questions are excluded because "correct" means the opposite thing for
 * them — mixing the two would make the paired difference uninterpretable. The
 * abstention column stays in the per-type table where it belongs.
 */
export const pairedTable = (
  left: ReadonlyArray<EvalRow>,
  right: ReadonlyArray<EvalRow>
): PairedTable => {
  const rightById = new Map(right.filter((row) => !row.isAbstention).map((row) => [row.questionId, row]))
  let both = 0
  let leftOnly = 0
  let rightOnly = 0
  let neither = 0
  for (const row of left) {
    if (row.isAbstention) continue
    const other = rightById.get(row.questionId)
    if (other === undefined) continue
    if (row.judged && other.judged) both++
    else if (row.judged) leftOnly++
    else if (other.judged) rightOnly++
    else neither++
  }
  return { both, leftOnly, rightOnly, neither, n: both + leftOnly + rightOnly + neither }
}

export const paired = (
  left: ReadonlyArray<EvalRow>,
  right: ReadonlyArray<EvalRow>
): PairedResult => {
  const table = pairedTable(left, right)
  const ci = pairedDifferenceCi(table)
  return {
    ...table,
    p: mcnemarExact(table.leftOnly, table.rightOnly),
    differencePoints: ci.points,
    ciLowPoints: ci.lowPoints,
    ciHighPoints: ci.highPoints
  }
}

// ------------------------------------------------------------------ rendering

const points = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`

export const renderPaired = (
  leftName: string,
  rightName: string,
  result: PairedResult
): string =>
  [
    `**${leftName}** vs **${rightName}** — ${result.n} answerable questions both systems answered`,
    "",
    "| outcome | questions |",
    "|---|---:|",
    `| both correct | ${result.both} |`,
    `| ${leftName} only | ${result.leftOnly} |`,
    `| ${rightName} only | ${result.rightOnly} |`,
    `| both wrong | ${result.neither} |`,
    "",
    `Paired difference **${points(result.differencePoints)} pp** ` +
      `(95 % CI ${points(result.ciLowPoints)} to ${points(result.ciHighPoints)}), ` +
      `exact two-sided McNemar **p = ${result.p.toFixed(7)}** over ` +
      `${result.leftOnly + result.rightOnly} discordant pairs.`
  ].join("\n")

export const renderErrorClasses = (
  bySystem: ReadonlyArray<ErrorClassCounts>
): string => {
  const out = [
    "| system | wrong | retrieval miss | selection | packing | reader | premise |",
    "|---|---:|---:|---:|---:|---:|---:|"
  ]
  for (const row of bySystem) {
    out.push(
      `| ${row.system} | ${row.wrong} | ${row.counts.retrieval_miss} | ${row.counts.selection} | ` +
        `${row.counts.packing} | ${row.counts.reader} | ${row.counts.premise} |`
    )
  }
  return out.join("\n")
}
