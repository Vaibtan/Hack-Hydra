import type { JudgeTemplate } from "./Judge.js"

/**
 * The reader-route A/B, and the table it renders.
 *
 * #30 changed one thing about the reader: a route-specific rules block appended
 * to the system prompt. Every other v2 stage changes *what the reader sees*, so
 * their contribution is measurable from an ablation of the pipeline. This one
 * changes only *how it is asked*, and an ablation of the whole pipeline would
 * measure it against a different pack.
 *
 * So the A/B fixes the evidence and varies only the prompt: the same packed
 * excerpts, in the same order, read twice — once with the route rules and once
 * with v1's single prompt, byte for byte — and judged by the same official
 * template. The pairing is what makes a 25-question comparison worth reporting
 * at all: both arms answered the same question from the same bytes, so a
 * difference is the rules and nothing else.
 *
 * The population is the two routes whose rules the research predicted would
 * matter most: `single-session-preference`, where v1's "as few words as the
 * question allows" produces a generic suggestion the judge marks wrong, and
 * `knowledge-update`, where the reader has to say which of two values is
 * current.
 */

export interface ReaderAbRow {
  readonly questionId: string
  readonly questionType: string
  readonly judgeTemplate: JudgeTemplate
  /** The route the Understand stage chose; the rules block that arm A appended. */
  readonly route: string | null
  /**
   * The excerpts both arms read. Identical by construction — asserted, not
   * assumed, by comparing the span hash of the two reads.
   */
  readonly spanHash: string
  readonly excerpts: number
  readonly withRoute: ReaderAbArm
  readonly withoutRoute: ReaderAbArm
}

export interface ReaderAbArm {
  readonly answer: string
  readonly correct: boolean
  readonly judgeReply: string
  readonly notInMemory: boolean
  /** The first answer cited nothing that exists and the reader was asked again. */
  readonly recited: boolean
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface ReaderAbFile {
  readonly kind: "reader-ab"
  readonly split: string
  readonly prefix: string
  readonly profile: string
  readonly readerModel: string
  readonly judgeModel: string
  readonly extractionGeneration: string
  readonly runtimeConfig?: unknown
  readonly questionTypes: ReadonlyArray<string>
  readonly rows: ReadonlyArray<ReaderAbRow>
}

export interface ReaderAbSummary {
  readonly type: string
  readonly n: number
  readonly withRoute: number
  readonly withoutRoute: number
  /** Both arms right, route-only, no-route-only, both wrong. */
  readonly both: number
  readonly routeOnly: number
  readonly plainOnly: number
  readonly neither: number
  readonly routeTokensP50: number
  readonly plainTokensP50: number
}

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

const summariseOne = (type: string, rows: ReadonlyArray<ReaderAbRow>): ReaderAbSummary => ({
  type,
  n: rows.length,
  withRoute: rows.filter((row) => row.withRoute.correct).length,
  withoutRoute: rows.filter((row) => row.withoutRoute.correct).length,
  both: rows.filter((row) => row.withRoute.correct && row.withoutRoute.correct).length,
  routeOnly: rows.filter((row) => row.withRoute.correct && !row.withoutRoute.correct).length,
  plainOnly: rows.filter((row) => !row.withRoute.correct && row.withoutRoute.correct).length,
  neither: rows.filter((row) => !row.withRoute.correct && !row.withoutRoute.correct).length,
  routeTokensP50: median(rows.map((row) => row.withRoute.outputTokens)),
  plainTokensP50: median(rows.map((row) => row.withoutRoute.outputTokens))
})

/** Per question type, then the total. */
export const summariseReaderAb = (
  rows: ReadonlyArray<ReaderAbRow>
): ReadonlyArray<ReaderAbSummary> => {
  const types = [...new Set(rows.map((row) => row.questionType))].sort()
  return [
    ...types.map((type) => summariseOne(type, rows.filter((row) => row.questionType === type))),
    summariseOne("ALL", rows)
  ]
}

/**
 * Every row where the two arms disagreed.
 *
 * The counts alone cannot say whether the rules helped or the reader got lucky
 * on four questions, and on a population this size that distinction is the
 * whole finding — so the disagreements are printed in full and the reader of
 * the table can look at them.
 */
export const disagreements = (rows: ReadonlyArray<ReaderAbRow>): ReadonlyArray<ReaderAbRow> =>
  rows.filter((row) => row.withRoute.correct !== row.withoutRoute.correct)

const truncate = (text: string, at: number): string =>
  text.length <= at ? text : `${text.slice(0, at - 1)}…`

/** Markdown-safe: a pipe in an answer would otherwise split the cell. */
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n+/g, " ")

export const renderReaderAb = (file: ReaderAbFile): string => {
  if (file.rows.length === 0) {
    return "_No reader A/B rows. Run `pnpm reader-ab --split dev`._"
  }
  const summaries = summariseReaderAb(file.rows)
  const lines = [
    "| question type | n | with route | without route | both | route only | plain only | neither | out tok p50 route/plain |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|"
  ]
  for (const row of summaries) {
    lines.push(
      `| ${row.type === "ALL" ? "**ALL**" : row.type} | ${row.n} | ${row.withRoute} | ` +
        `${row.withoutRoute} | ${row.both} | ${row.routeOnly} | ${row.plainOnly} | ` +
        `${row.neither} | ${row.routeTokensP50} / ${row.plainTokensP50} |`
    )
  }

  const differed = disagreements(file.rows)
  const detail =
    differed.length === 0
      ? [
          "",
          "The two arms agreed on every question. The rules block changed no judged answer on " +
            `these ${file.rows.length}.`
        ]
      : [
          "",
          `The ${differed.length} question${differed.length === 1 ? "" : "s"} the arms disagreed ` +
            "on, in full, because a count this small cannot distinguish a rule that works from a " +
            "reader that got lucky:",
          "",
          "| question | route | won | with route | without route |",
          "|---|---|---|---|---|"
        ].concat(
          differed.map(
            (row) =>
              `| ${row.questionId} | ${row.route ?? "—"} | ` +
              `${row.withRoute.correct ? "route" : "plain"} | ` +
              `${cell(truncate(row.withRoute.answer, 90))} | ` +
              `${cell(truncate(row.withoutRoute.answer, 90))} |`
          )
        )

  return [
    ...lines,
    "",
    "Both arms read the **same packed excerpts**, in the same order — the span hash is recorded " +
      "per row and the harness refuses to write a row whose two reads disagree about it — so a " +
      "difference here is the rules block and nothing else.",
    ...detail
  ].join("\n")
}
