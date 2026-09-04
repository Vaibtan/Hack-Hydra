import type { EvalRow } from "./Envelope.js"
import { answerable, correct } from "./Results.js"
import { quantile } from "./Stats.js"

export type ErrorClass = "premise" | "retrieval_miss" | "selection" | "packing" | "reader"

const hits = (
  answerSessions: ReadonlyArray<string>,
  candidate: ReadonlyArray<string> | undefined
): boolean | null =>
  candidate === undefined ? null : answerSessions.some((sid) => candidate.includes(sid))

export const errorClass = (row: EvalRow): ErrorClass | null => {
  if (row.judged) return null
  if (row.isAbstention) return "premise"

  const inUnion = hits(row.answerSessions, row.unionSessions)
  if (inUnion === false) return "retrieval_miss"
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

const factorialLog: Array<number> = [0]

const logFactorial = (n: number): number => {
  for (let i = factorialLog.length; i <= n; i++) factorialLog[i] = factorialLog[i - 1]! + Math.log(i)
  return factorialLog[n]!
}

const binomialPmfHalf = (n: number, k: number): number =>
  Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k) - n * Math.LN2)

export interface PairedTable {
  readonly both: number
  readonly leftOnly: number
  readonly rightOnly: number
  readonly neither: number
  readonly n: number
}

export interface PairedResult extends PairedTable {
  readonly p: number
  readonly differencePoints: number
  readonly ciLowPoints: number
  readonly ciHighPoints: number
}

export const mcnemarExact = (leftOnly: number, rightOnly: number): number => {
  const discordant = leftOnly + rightOnly
  if (discordant === 0) return 1
  const smaller = Math.min(leftOnly, rightOnly)
  let tail = 0
  for (let k = 0; k <= smaller; k++) tail += binomialPmfHalf(discordant, k)
  return Math.min(1, 2 * tail)
}

const Z95 = 1.959963984540054

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

export const renderLatency = (
  bySystem: ReadonlyArray<readonly [string, ReadonlyArray<EvalRow>]>
): string => {
  const cell = (values: ReadonlyArray<number>, q: number, unit: "ms" | "tok"): string => {
    if (values.length === 0) return "—"
    const v = quantile(values, q)
    if (unit === "tok") return Math.round(v).toLocaleString("en-US")
    return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`
  }
  const lines = [
    "| system | graphMs p50 | graphMs p90 | askMs p50 | askMs p90 | reader tokens p50 | p90 |",
    "|---|---:|---:|---:|---:|---:|---:|"
  ]
  for (const [system, rows] of bySystem) {
    const graph = rows.flatMap((row) => (row.graphMs === undefined ? [] : [row.graphMs]))
    const ask = rows.flatMap((row) => (row.askMs === undefined ? [] : [row.askMs]))
    const tokens = rows.map((row) => row.readerInputTokens)
    lines.push(
      `| ${system} | ${cell(graph, 0.5, "ms")} | ${cell(graph, 0.9, "ms")} | ` +
        `${cell(ask, 0.5, "ms")} | ${cell(ask, 0.9, "ms")} | ` +
        `${cell(tokens, 0.5, "tok")} | ${cell(tokens, 0.9, "tok")} |`
    )
  }
  return lines.join("\n")
}

export interface AblationRow {
  readonly ablations: ReadonlyArray<string>
  readonly rows: ReadonlyArray<EvalRow>
}

export const renderAblations = (
  full: ReadonlyArray<EvalRow>,
  ablations: ReadonlyArray<AblationRow>
): string => {
  const base = correct(answerable(full))
  const n = answerable(full).length
  if (ablations.length === 0) {
    return "_No ablation runs in this directory._"
  }

  const lines = [
    `| stage switched off | correct of ${n} | vs full | latency p50 |`,
    "|---|---:|---:|---:|"
  ]
  const askP50 = (rows: ReadonlyArray<EvalRow>): string => {
    const ask = rows.flatMap((row) => (row.askMs === undefined ? [] : [row.askMs]))
    if (ask.length === 0) return "—"
    const v = quantile(ask, 0.5)
    return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`
  }
  lines.push(`| _none (full plan)_ | ${base} | — | ${askP50(full)} |`)
  for (const ablation of [...ablations].sort((a, b) =>
    a.ablations.join().localeCompare(b.ablations.join())
  )) {
    const got = correct(answerable(ablation.rows))
    const delta = got - base
    lines.push(
      `| ${ablation.ablations.join(" + ")} | ${got} | ${delta > 0 ? "+" : ""}${delta} | ` +
        `${askP50(ablation.rows)} |`
    )
  }
  return lines.join("\n")
}
