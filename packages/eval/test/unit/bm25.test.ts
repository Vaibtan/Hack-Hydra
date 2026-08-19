import type { DatasetQuestion, DatasetSession } from "@palimpsest/dataset"
import { describe, expect, it } from "vitest"
import { buildIndex, fullContextSpans, topSpans } from "../../src/index.js"

/**
 * B1 and B2 are only meaningful as comparisons if they differ from Palimpsest
 * in exactly one thing — which text reaches the reader. These tests pin the
 * selection; the reader prompt and the judge are shared code.
 */
const session = (
  ord: number,
  dateInt: number,
  turns: ReadonlyArray<string>
): DatasetSession => ({
  sid: `s${ord}`,
  key: `s${ord}`,
  sessionOrd: ord,
  date: { raw: `2023/01/${String(ord).padStart(2, "0")} (Mon) 10:00`, ts: ord, dateInt },
  turns: turns.map((text, turnIdx) => ({
    turnIdx,
    role: turnIdx % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text,
    hasAnswer: false
  }))
})

const question = (
  text: string,
  sessions: ReadonlyArray<DatasetSession>
): DatasetQuestion => ({
  questionId: "q1",
  questionType: "multi-session",
  question: text,
  answer: "a",
  questionDate: { raw: "2023/02/01 (Wed) 10:00", ts: 99, dateInt: 20230201 },
  sessions,
  answerSessionIds: [],
  isAbstention: false
})

describe("BM25 turn selection", () => {
  const q = question("What is the name of my hamster?", [
    session(1, 20230101, ["I went running this morning", "Nice, how far?"]),
    session(2, 20230102, ["My hamster is called Nibbles", "Cute name for a hamster"]),
    session(3, 20230103, ["The weather is cold today", "Wrap up warm"])
  ])

  it("ranks by shared terms — which is the baseline's whole weakness", () => {
    // "Cute name for a hamster" carries both query stems and the turn that
    // actually holds the answer carries one, so BM25 puts the assistant's
    // echo first. Term overlap is not aboutness; that is the comparison.
    const spans = topSpans(q, buildIndex(q), 1)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.excerpt).toBe("Cute name for a hamster")

    // Both are in reach at k = 10, which is why the baseline gets ten turns.
    expect(topSpans(q, buildIndex(q), 10).map((span) => span.excerpt)).toContain(
      "My hamster is called Nibbles"
    )
  })

  it("scores turns, not sessions, and gives the reader whole turns", () => {
    // BM25 selects turns; cutting a window out of one would invent a span the
    // baseline never produced.
    const spans = topSpans(q, buildIndex(q), 2)
    expect(spans.map((span) => span.excerpt)).toEqual([
      "My hamster is called Nibbles",
      "Cute name for a hamster"
    ])
  })

  it("hands them over in chronological order, as the graph path does", () => {
    const spans = topSpans(q, buildIndex(q), 10)
    const ords = spans.map((span) => span.sessionOrd)
    expect([...ords].sort((a, b) => a - b)).toEqual(ords)
  })

  it("labels everything CURRENT, because a term index has no supersession", () => {
    for (const span of topSpans(q, buildIndex(q), 10)) {
      expect(span.status).toBe("CURRENT")
      expect(span.atSession).toBeNull()
    }
  })

  it("returns nothing when no turn shares a term with the question", () => {
    const other = question("Quantum chromodynamics?", q.sessions)
    expect(topSpans(other, buildIndex(other), 10)).toHaveLength(0)
  })
})

describe("full-context selection", () => {
  const long = (n: number) => "x".repeat(n)
  const q = question("anything", [
    session(1, 20230101, [long(100)]),
    session(2, 20230102, [long(100)]),
    session(3, 20230103, [long(100)])
  ])

  it("sends the whole haystack when it fits, oldest first", () => {
    const full = fullContextSpans(q, 10_000)
    expect(full.sessionsDropped).toBe(0)
    expect(full.spans.map((span) => span.sessionOrd)).toEqual([1, 2, 3])
  })

  it("drops the oldest sessions when it does not, and says how many", () => {
    // Dropping the newest would flatter this baseline on exactly the
    // knowledge-update questions it should find hard.
    const full = fullContextSpans(q, 250)
    expect(full.sessionsDropped).toBe(1)
    expect(full.spans.map((span) => span.sessionOrd)).toEqual([2, 3])
  })

  it("always keeps at least one session, however small the budget", () => {
    const full = fullContextSpans(q, 1)
    expect(full.spans.length).toBeGreaterThan(0)
    expect(full.sessionsDropped).toBe(2)
  })
})
