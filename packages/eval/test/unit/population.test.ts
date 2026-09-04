import type { DatasetQuestion } from "@palimpsest/dataset"
import { describe, expect, it } from "vitest"
import {
  batchOf,
  leakedTestIds,
  readSplitFile,
  splitFilePath,
  splitQuestions,
  testGateRefusal,
  uidFor
} from "../../src/index.js"

const question = (questionId: string): DatasetQuestion => ({
  questionId,
  questionType: "multi-session",
  question: "",
  answer: "",
  questionDate: { raw: "", ts: 0, dateInt: 0 },
  sessions: [],
  answerSessionIds: [],
  isAbstention: false
})

describe("the committed split file", () => {
  const file = readSplitFile(splitFilePath())

  it("decodes, with the gate record it carries", () => {
    expect(file.dev.length).toBe(60)
    expect(file.test.length).toBe(140)
    expect(file.gate?.passed).toBe(true)
  })

  it("selects a split's questions in id order and says how many it wanted", () => {
    const questions = [...file.test.slice(0, 3), ...file.dev.slice(0, 2)].reverse().map(question)
    const selected = splitQuestions(questions, file, "dev")
    expect(selected.wanted).toBe(60)
    expect(selected.slice.map((q) => q.questionId)).toEqual([...file.dev.slice(0, 2)].sort())
  })

  it("refuses the test half only while the gate is unread", () => {
    expect(testGateRefusal(file, "test")).toBeNull()
    expect(testGateRefusal({ ...file, gate: null }, "test")).toContain("no gate record")
    expect(testGateRefusal({ ...file, gate: null }, "dev")).toBeNull()
  })

  it("names the test ids a slice would leak while the gate is unread", () => {
    const slice = [question(file.test[0]!), question(file.dev[0]!)]
    expect(leakedTestIds(slice, { ...file, gate: null })).toEqual([file.test[0]])
    expect(leakedTestIds(slice, file)).toEqual([])
    expect(leakedTestIds(slice, null)).toEqual([])
  })
})

describe("uids and batches", () => {
  it("prefixes a question id, or leaves it alone with no prefix", () => {
    expect(uidFor("g3", "abc")).toBe("g3-abc")
    expect(uidFor("", "abc")).toBe("abc")
  })

  it("cuts contiguous batches by position", () => {
    const items = ["a", "b", "c", "d", "e"]
    expect(batchOf(items, { index: 1, count: 2 })).toEqual({ items: ["a", "b", "c"], from: 0 })
    expect(batchOf(items, { index: 2, count: 2 })).toEqual({ items: ["d", "e"], from: 3 })
    expect(batchOf(items, { index: 3, count: 3 })).toEqual({ items: ["e"], from: 4 })
  })
})
