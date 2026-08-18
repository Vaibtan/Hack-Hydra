import { describe, expect, it } from "vitest"
import { parseQuestion, parseHaystackDate } from "../../src/index.js"

/**
 * Oracle: the shape and the date format come from the real files in `data/`.
 * This fixture is a hand-built three-session question whose file order is
 * deliberately *not* chronological — the same trap 211 of the 500 LongMemEval_S
 * questions contain.
 */
const RAW = {
  question_id: "gpt4_2655b836",
  question_type: "temporal-reasoning",
  question: "What was the first issue I had with my new car?",
  answer: "GPS system not functioning correctly",
  question_date: "2023/04/10 (Mon) 23:07",
  haystack_dates: [
    "2023/04/10 (Mon) 17:50",
    "2023/04/10 (Mon) 14:47",
    "2023/04/10 (Mon) 17:15"
  ],
  haystack_session_ids: ["answer_x_2", "answer_x_3", "answer_x_1"],
  haystack_sessions: [
    [{ role: "user", content: "second by clock", has_answer: true }],
    [{ role: "user", content: "first by clock" }],
    [
      { role: "user", content: "third by clock" },
      { role: "assistant", content: "a reply", has_answer: false }
    ]
  ],
  answer_session_ids: ["answer_x_2"]
}

describe("parseHaystackDate", () => {
  it("reads the LongMemEval timestamp format into an epoch and a YYYYMMDD integer", () => {
    const parsed = parseHaystackDate("2023/04/10 (Mon) 17:50")
    expect(parsed.dateInt).toBe(20230410)
    expect(parsed.ts).toBe(Date.UTC(2023, 3, 10, 17, 50) / 1000)
    expect(parsed.raw).toBe("2023/04/10 (Mon) 17:50")
  })
})

describe("parseQuestion", () => {
  it("assigns session_ord by timestamp, not file order", () => {
    const q = parseQuestion(RAW)
    expect(q.sessions.map((s) => [s.sid, s.sessionOrd])).toEqual([
      ["answer_x_3", 1],
      ["answer_x_1", 2],
      ["answer_x_2", 3]
    ])
  })

  it("keeps input order for sessions that share a timestamp", () => {
    const tied = {
      ...RAW,
      haystack_dates: ["2023/04/10 (Mon) 17:50", "2023/04/10 (Mon) 17:50", "2023/04/10 (Mon) 09:00"],
      haystack_session_ids: ["b", "a", "z"]
    }
    expect(parseQuestion(tied).sessions.map((s) => s.sid)).toEqual(["z", "b", "a"])
  })

  it("preserves turn text verbatim, with indices and roles", () => {
    const q = parseQuestion(RAW)
    const third = q.sessions.find((s) => s.sid === "answer_x_1")!
    expect(third.turns).toEqual([
      { turnIdx: 0, role: "user", text: "third by clock", hasAnswer: false },
      { turnIdx: 1, role: "assistant", text: "a reply", hasAnswer: false }
    ])
  })

  it("treats a missing has_answer key as false, which is how the S file encodes it", () => {
    const q = parseQuestion(RAW)
    const first = q.sessions.find((s) => s.sid === "answer_x_3")!
    expect(first.turns[0]!.hasAnswer).toBe(false)
    const second = q.sessions.find((s) => s.sid === "answer_x_2")!
    expect(second.turns[0]!.hasAnswer).toBe(true)
  })

  it("keeps answer_session_ids and the question date for the eval harness", () => {
    const q = parseQuestion(RAW)
    expect(q.answerSessionIds).toEqual(["answer_x_2"])
    expect(q.questionDate.dateInt).toBe(20230410)
    expect(q.isAbstention).toBe(false)
  })

  it("flags the abstention questions by their _abs question id suffix", () => {
    expect(parseQuestion({ ...RAW, question_id: "gpt4_2655b836_abs" }).isAbstention).toBe(true)
  })
})
