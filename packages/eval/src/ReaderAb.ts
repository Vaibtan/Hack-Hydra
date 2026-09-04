import type { JudgeTemplate } from "./Judge.js"
import { median } from "./Stats.js"

export interface ReaderAbRow {
  readonly questionId: string
  readonly questionType: string
  readonly judgeTemplate: JudgeTemplate
  readonly route: string | null
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
  readonly recited: boolean
  readonly inputTokens: number
  readonly outputTokens: number
}

/** Both arms read identical packed excerpts; only the reader prompt differs. */
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
  readonly batch?: { readonly index: number; readonly count: number }
  readonly rows: ReadonlyArray<ReaderAbRow>
}

export interface ReaderAbSummary {
  readonly type: string
  readonly n: number
  readonly withRoute: number
  readonly withoutRoute: number
  readonly both: number
  readonly routeOnly: number
  readonly plainOnly: number
  readonly neither: number
  readonly routeTokensP50: number
  readonly plainTokensP50: number
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

export const summariseReaderAb = (
  rows: ReadonlyArray<ReaderAbRow>
): ReadonlyArray<ReaderAbSummary> => {
  const types = [...new Set(rows.map((row) => row.questionType))].sort()
  return [
    ...types.map((type) => summariseOne(type, rows.filter((row) => row.questionType === type))),
    summariseOne("ALL", rows)
  ]
}

export const disagreements = (rows: ReadonlyArray<ReaderAbRow>): ReadonlyArray<ReaderAbRow> =>
  rows.filter((row) => row.withRoute.correct !== row.withoutRoute.correct)

const truncate = (text: string, at: number): string =>
  text.length <= at ? text : `${text.slice(0, at - 1)}…`

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
