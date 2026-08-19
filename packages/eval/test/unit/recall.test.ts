import type { DatasetQuestion } from "@palimpsest/dataset"
import type { ExtractedClaim, SessionExtraction } from "@palimpsest/palimpsest"
import { describe, expect, it } from "vitest"
import { byType, questionRecall, stratifiedSlice, summarise } from "../../src/index.js"

const date = { raw: "2023/04/10 (Mon) 17:50", ts: 0, dateInt: 20230410 }

const question = (
  id: string,
  type: string,
  sessions: ReadonlyArray<{ sid: string; answerTurns: ReadonlyArray<number>; turns: number }>
): DatasetQuestion => ({
  questionId: id,
  questionType: type,
  question: "q",
  answer: "a",
  questionDate: date,
  answerSessionIds: [],
  isAbstention: false,
  sessions: sessions.map((session, i) => ({
    sid: session.sid,
    key: session.sid,
    sessionOrd: i + 1,
    date,
    turns: Array.from({ length: session.turns }, (_, turnIdx) => ({
      turnIdx,
      role: "user" as const,
      text: "t",
      hasAnswer: session.answerTurns.includes(turnIdx)
    }))
  }))
})

const claimAt = (turnIdx: number): ExtractedClaim => ({
  text: "c",
  speaker: "user",
  ctype: "fact",
  entities: [],
  slot: null,
  tEvent: 0,
  tPrec: "none",
  span: { turnIdx, cs: 0, ce: 1 },
  keywords: [],
  located: "exact"
})

const extraction = (sid: string, turnIdxs: ReadonlyArray<number>, dropped = 0): SessionExtraction => ({
  sid,
  sessionOrd: 1,
  claims: turnIdxs.map(claimAt),
  dropped: Array.from({ length: dropped }, () => ({
    reason: "span_not_found" as const,
    turnIdx: 0,
    quote: "q",
    text: "t"
  })),
  cached: false
})

describe("questionRecall", () => {
  it("counts an answer turn as covered when any claim's span lands in it", () => {
    const q = question("q1", "multi-session", [{ sid: "s1", answerTurns: [2, 5], turns: 6 }])
    const result = questionRecall(q, [extraction("s1", [0, 2, 3])])
    expect(result.coveredTurns).toBe(1)
    expect(result.answerTurns).toBe(2)
    expect(result.recall).toBe(0.5)
    expect(result.misses).toEqual([{ sid: "s1", turnIdx: 5, covered: false }])
  })

  it("does not let a claim in one session cover the same turn index in another", () => {
    const q = question("q1", "multi-session", [
      { sid: "s1", answerTurns: [1], turns: 3 },
      { sid: "s2", answerTurns: [1], turns: 3 }
    ])
    const result = questionRecall(q, [extraction("s1", [1])])
    expect(result.coveredTurns).toBe(1)
    expect(result.misses.map((m) => m.sid)).toEqual(["s2"])
  })

  it("reports no recall at all for a question with no answer-bearing turns", () => {
    const q = question("q_abs", "single-session-user", [{ sid: "s1", answerTurns: [], turns: 3 }])
    expect(questionRecall(q, [extraction("s1", [0])]).recall).toBeNull()
  })
})

describe("summarise", () => {
  it("micro-averages over turns, so a 12-turn question outweighs a 1-turn one", () => {
    const wide = questionRecall(question("q1", "t", [{ sid: "s1", answerTurns: [0, 1, 2, 3], turns: 4 }]), [
      extraction("s1", [0, 1, 2, 3])
    ])
    const narrow = questionRecall(question("q2", "t", [{ sid: "s2", answerTurns: [0], turns: 1 }]), [
      extraction("s2", [], 2)
    ])
    const total = summarise([wide, narrow])
    expect(total).toEqual({ answerTurns: 5, coveredTurns: 4, recall: 0.8, claims: 4, dropped: 2 })
    // A per-question average would have said 50 %.
  })
})

describe("byType", () => {
  it("groups by question type in a stable order", () => {
    const a = questionRecall(question("q1", "temporal-reasoning", [{ sid: "s1", answerTurns: [0], turns: 1 }]), [
      extraction("s1", [0])
    ])
    const b = questionRecall(question("q2", "knowledge-update", [{ sid: "s2", answerTurns: [0], turns: 1 }]), [
      extraction("s2", [])
    ])
    expect(byType([a, b]).map(([type, s]) => [type, s.recall])).toEqual([
      ["knowledge-update", 0],
      ["temporal-reasoning", 1]
    ])
  })
})

describe("stratifiedSlice", () => {
  const questions = [
    ...Array.from({ length: 10 }, (_, i) => question(`b${i}`, "multi-session", [])),
    ...Array.from({ length: 10 }, (_, i) => question(`a${i}`, "temporal-reasoning", [])),
    ...Array.from({ length: 2 }, (_, i) => question(`c${i}`, "single-session-preference", []))
  ]

  it("takes types round-robin so every type is represented", () => {
    const slice = stratifiedSlice(questions, 6)
    const types = slice.map((q) => q.questionType)
    expect(new Set(types).size).toBe(3)
    expect(types.filter((t) => t === "single-session-preference")).toHaveLength(2)
  })

  it("is deterministic and drains larger types once small ones run out", () => {
    const first = stratifiedSlice(questions, 12)
    expect(stratifiedSlice(questions, 12).map((q) => q.questionId)).toEqual(
      first.map((q) => q.questionId)
    )
    expect(first).toHaveLength(12)
    expect(first.filter((q) => q.questionType === "single-session-preference")).toHaveLength(2)
  })

  it("never returns more than the dataset holds", () => {
    expect(stratifiedSlice(questions, 100)).toHaveLength(22)
  })
})
