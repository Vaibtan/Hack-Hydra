import { Schema } from "effect"
import { median } from "./Stats.js"

export const ReaderAbArm = Schema.Struct({
  answer: Schema.String,
  correct: Schema.Boolean,
  judgeReply: Schema.String,
  notInMemory: Schema.Boolean,
  recited: Schema.Boolean,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number
})
export type ReaderAbArm = typeof ReaderAbArm.Type

export const ReaderAbRow = Schema.Struct({
  questionId: Schema.String,
  questionType: Schema.String,
  judgeTemplate: Schema.Literals([
    "default",
    "temporal-reasoning",
    "knowledge-update",
    "single-session-preference",
    "abstention"
  ]),
  route: Schema.NullOr(Schema.String),
  spanHash: Schema.String,
  excerpts: Schema.Number,
  withRoute: ReaderAbArm,
  withoutRoute: ReaderAbArm
})
export type ReaderAbRow = typeof ReaderAbRow.Type

/** Both arms read identical packed excerpts; only the reader prompt differs. */
export const ReaderAbFile = Schema.Struct({
  kind: Schema.Literal("reader-ab"),
  split: Schema.String,
  prefix: Schema.String,
  profile: Schema.String,
  readerModel: Schema.String,
  judgeModel: Schema.String,
  extractionGeneration: Schema.String,
  runtimeConfig: Schema.optionalKey(Schema.ObjectKeyword),
  questionTypes: Schema.Array(Schema.String),
  batch: Schema.optionalKey(Schema.Struct({ index: Schema.Number, count: Schema.Number })),
  rows: Schema.Array(ReaderAbRow)
})
export type ReaderAbFile = typeof ReaderAbFile.Type

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
