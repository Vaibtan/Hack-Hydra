import type { DatasetQuestion } from "@palimpsest/dataset"
import { describe, expect, it } from "vitest"
import { benchmarkSlice, evalSlice, stratifiedSlice } from "../../src/index.js"

const TYPES = [
  "knowledge-update",
  "multi-session",
  "single-session-assistant",
  "single-session-preference",
  "single-session-user",
  "temporal-reasoning"
] as const

const date = { raw: "2023/04/10 (Mon) 17:50", ts: 0, dateInt: 20230410 }

const question = (id: string, type: string): DatasetQuestion => ({
  questionId: id,
  questionType: type,
  question: "q",
  answer: "a",
  questionDate: date,
  sessions: [],
  answerSessionIds: [],
  isAbstention: id.endsWith("_abs")
})

const corpus: ReadonlyArray<DatasetQuestion> = [
  ...Array.from({ length: 470 }, (_, i) =>
    question(`q${String(i).padStart(3, "0")}`, TYPES[i % TYPES.length]!)
  ),
  ...Array.from({ length: 30 }, (_, i) =>
    question(`z${String(i).padStart(3, "0")}_abs`, TYPES[i % TYPES.length]!)
  )
]

describe("evalSlice", () => {
  it("takes every abstention question plus the requested answerable count", () => {
    const slice = evalSlice(corpus, { answerable: 70 })
    expect(slice).toHaveLength(100)
    expect(slice.filter((q) => q.isAbstention)).toHaveLength(30)
    expect(slice.filter((q) => !q.isAbstention)).toHaveLength(70)
  })

  it("takes all 30 where the stratified slice of the same size takes few", () => {
    const stratified = stratifiedSlice(corpus, 100).filter((q) => q.isAbstention)
    expect(stratified.length).toBeLessThan(30)
  })

  it("keeps the answerable half stratified across every question type", () => {
    const byType = new Map<string, number>()
    for (const q of evalSlice(corpus, { answerable: 60 })) {
      if (q.isAbstention) continue
      byType.set(q.questionType, (byType.get(q.questionType) ?? 0) + 1)
    }
    expect([...byType.keys()].sort()).toEqual([...TYPES].sort())
    expect([...byType.values()]).toEqual([10, 10, 10, 10, 10, 10])
  })

  it("is deterministic and stably ordered", () => {
    const a = evalSlice(corpus, { answerable: 70 }).map((q) => q.questionId)
    const b = evalSlice([...corpus].reverse(), { answerable: 70 }).map((q) => q.questionId)
    expect(b).toEqual(a)
    expect([...a].sort()).toEqual(a)
  })

  it("can drop the abstention half, for a purely answerable run", () => {
    const slice = evalSlice(corpus, { answerable: 12, allAbstention: false })
    expect(slice).toHaveLength(12)
    expect(slice.some((q) => q.isAbstention)).toBe(false)
  })
})

describe("benchmarkSlice", () => {
  it("is the gate's stratified slice below the abstention count", () => {
    expect(benchmarkSlice(corpus, 20).map((q) => q.questionId)).toEqual(
      stratifiedSlice(corpus, 20).map((q) => q.questionId)
    )
  })

  it("is the abstention-complete slice above it", () => {
    const slice = benchmarkSlice(corpus, 100)
    expect(slice).toHaveLength(100)
    expect(slice.filter((q) => q.isAbstention)).toHaveLength(30)
  })

  it("is the whole benchmark at or above the file size", () => {
    expect(benchmarkSlice(corpus, 500)).toHaveLength(500)
    expect(benchmarkSlice(corpus, 900)).toHaveLength(500)
  })

  it("means the same questions to ingest, to the gate and to the harness", () => {
    const a = benchmarkSlice(corpus, 100).map((q) => q.questionId)
    const b = benchmarkSlice(corpus, 100).map((q) => q.questionId)
    expect(b).toEqual(a)
  })
})
