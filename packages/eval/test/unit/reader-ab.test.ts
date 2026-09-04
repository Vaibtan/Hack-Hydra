import { describe, expect, it } from "vitest"
import {
  disagreements,
  renderReaderAb,
  summariseReaderAb,
  type ReaderAbFile,
  type ReaderAbRow
} from "../../src/index.js"

const arm = (correct: boolean, answer: string, outputTokens = 20) => ({
  answer,
  correct,
  judgeReply: correct ? "yes" : "no",
  notInMemory: false,
  recited: false,
  inputTokens: 2000,
  outputTokens
})

const row = (over: Partial<ReaderAbRow> & { questionId: string }): ReaderAbRow => ({
  questionType: "single-session-preference",
  judgeTemplate: "single-session-preference",
  route: "preference",
  spanHash: "abc123",
  excerpts: 6,
  withRoute: arm(true, "Because you keep basil, try a caprese."),
  withoutRoute: arm(false, "Try a salad."),
  ...over
})

const file = (rows: ReadonlyArray<ReaderAbRow>): ReaderAbFile => ({
  kind: "reader-ab",
  split: "dev",
  prefix: "g3",
  profile: "full",
  readerModel: "gpt-5.6-luna",
  judgeModel: "gpt-4o",
  extractionGeneration: "extract-v1-abc",
  questionTypes: ["single-session-preference", "knowledge-update"],
  rows
})

describe("summary", () => {
  it("splits the four paired outcomes, not just two totals", () => {
    const rows = [
      row({ questionId: "a", withRoute: arm(true, "x"), withoutRoute: arm(true, "y") }),
      row({ questionId: "b", withRoute: arm(true, "x"), withoutRoute: arm(false, "y") }),
      row({ questionId: "c", withRoute: arm(false, "x"), withoutRoute: arm(true, "y") }),
      row({ questionId: "d", withRoute: arm(false, "x"), withoutRoute: arm(false, "y") })
    ]

    const all = summariseReaderAb(rows).find((s) => s.type === "ALL")!

    expect(all).toMatchObject({
      n: 4,
      withRoute: 2,
      withoutRoute: 2,
      both: 1,
      routeOnly: 1,
      plainOnly: 1,
      neither: 1
    })
  })

  it("reports each question type as well as the total", () => {
    const rows = [
      row({ questionId: "a" }),
      row({ questionId: "b", questionType: "knowledge-update", judgeTemplate: "knowledge-update" })
    ]

    expect(summariseReaderAb(rows).map((s) => s.type)).toEqual([
      "knowledge-update",
      "single-session-preference",
      "ALL"
    ])
  })

  it("reports output tokens, because the route rules ask for longer answers", () => {
    const rows = [
      row({ questionId: "a", withRoute: arm(true, "x", 90), withoutRoute: arm(true, "y", 8) })
    ]

    const all = summariseReaderAb(rows).find((s) => s.type === "ALL")!
    expect(all.routeTokensP50).toBe(90)
    expect(all.plainTokensP50).toBe(8)
  })
})

describe("disagreements", () => {
  it("is every row the two arms scored differently, in either direction", () => {
    const rows = [
      row({ questionId: "agree", withRoute: arm(true, "x"), withoutRoute: arm(true, "y") }),
      row({ questionId: "route", withRoute: arm(true, "x"), withoutRoute: arm(false, "y") }),
      row({ questionId: "plain", withRoute: arm(false, "x"), withoutRoute: arm(true, "y") })
    ]

    expect(disagreements(rows).map((r) => r.questionId)).toEqual(["route", "plain"])
  })
})

describe("the table", () => {
  it("says the arms agreed rather than implying a result", () => {
    const rows = [row({ questionId: "a", withRoute: arm(true, "x"), withoutRoute: arm(true, "y") })]

    const table = renderReaderAb(file(rows))

    expect(table).toContain("agreed on every question")
    expect(table).toContain("changed no judged answer")
  })

  it("prints every disagreement in full, because the count cannot be read alone", () => {
    const table = renderReaderAb(file([row({ questionId: "q-1234" })]))

    expect(table).toContain("q-1234")
    expect(table).toContain("Because you keep basil, try a caprese.")
    expect(table).toContain("Try a salad.")
  })

  it("states the pairing the whole comparison rests on", () => {
    expect(renderReaderAb(file([row({ questionId: "a" })]))).toContain("same packed excerpts")
  })

  it("escapes a pipe in an answer instead of splitting the row", () => {
    const rows = [row({ questionId: "a", withRoute: arm(true, "eggs | milk | bread") })]

    expect(renderReaderAb(file(rows))).toContain("eggs \\| milk \\| bread")
  })

  it("collapses a newline in an answer, which would end the table row", () => {
    const rows = [row({ questionId: "a", withRoute: arm(true, "one\ntwo") })]

    const table = renderReaderAb(file(rows))
    expect(table).toContain("one two")
    expect(table).not.toContain("one\ntwo")
  })

  it("tells the operator what to run when there is nothing to render", () => {
    expect(renderReaderAb(file([]))).toContain("pnpm reader-ab")
  })
})
