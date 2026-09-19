import type { DatasetQuestion } from "@palimpsest/dataset"
import type { HydratedSpan, V2Answer } from "@palimpsest/palimpsest"
import { describe, expect, it } from "vitest"
import {
  EvalRow,
  absentResponse,
  graphMsOf,
  responseOf,
  rowFromBaseline,
  rowFromV2,
  type Judgement,
  type V2EvaluationAnswer,
  type V2Outcome
} from "../../src/index.js"
import { Schema } from "effect"

const question: DatasetQuestion = {
  questionId: "q1",
  questionType: "multi-session",
  question: "What did I buy?",
  answer: "a bike",
  questionDate: { raw: "2023/05/20 (Sat) 02:21", ts: 1684549260, dateInt: 20230520 },
  sessions: [],
  answerSessionIds: ["s2"],
  isAbstention: false
}

const span = (sid: string, ckey: string): HydratedSpan => ({
  ckey,
  id: ckey.slice(-4),
  sid,
  sessionKey: `u|${sid}`,
  turnIdx: 0,
  cs: 0,
  ce: 10,
  sessionOrd: 1,
  sessionDate: 20230501,
  tEvent: 20230501,
  speaker: "user",
  status: "CURRENT",
  atSession: null,
  excerpt: "I bought a bike",
  highlight: { start: 2, end: 15 }
})

const judgement: Judgement = { correct: true, template: "default", reply: "yes", model: "gpt-4o", cached: true }

const read = (spans: ReadonlyArray<HydratedSpan>) => ({
  answer: "a bike",
  notInMemory: false,
  citedIds: [],
  reasoning: "",
  spans,
  cached: true,
  inputTokens: 900,
  outputTokens: 12,
  hydrateMs: 40,
  readMs: 700,
  spanHash: "spanhash",
  granularity: "span" as const,
  pack: { dropped: [span("s9", "u|c|dropped")] },
  recited: false
})

const answered = (over: Partial<{ read: ReturnType<typeof read> | null; verdict: "ANSWER" | "ABSENT"; reason: V2Answer["reason"] }> = {}): V2EvaluationAnswer =>
  ({
    ask: {
      reason: null,
      hash: "claimhash",
      timings: { askMs: 1200, graphMs: 200, stages: { arms: 150 } },
      receipt: { anchorTerms: ["bike", "buy"], anchorsReachingClaims: ["bike"] },
      plan: {
        route: "multi_fact",
        flags: { wantsCount: false, hasTimeRef: true, needsDecomposition: false },
        selection: { fallback: false },
        unionSessions: ["s1", "s2", "s3"],
        sufficiency: { tier: "EXACT", missing: "", premise: "" },
        budget: { estimatedTokens: 850, dropped: [{ id: "x1" }], overBudget: false }
      }
    },
    read: over.read === undefined ? read([span("s2", "u|c|1"), span("s1", "u|c|2")]) : over.read,
    verdict: over.verdict ?? "ANSWER",
    reason: over.reason ?? null,
    sufficiency: { premise: "" },
    secondPass: false,
    hash: "spanhash"
  })

const outcome = (a: V2EvaluationAnswer): V2Outcome => ({ kind: "v2", answered: a, ablations: [] })

describe("rowFromV2", () => {
  it("is a total function producing a decodable row", () => {
    const row = rowFromV2(question, outcome(answered()), judgement, 1500)
    expect(() => Schema.decodeUnknownSync(EvalRow)(JSON.parse(JSON.stringify(row)))).not.toThrow()
    expect(row).toMatchObject({
      system: "palimpsest-v2",
      questionId: "q1",
      verdict: "ANSWER",
      judged: true,
      evidence: 2,
      evidenceSessions: ["s1", "s2"],
      keptSessions: ["s1", "s2"],
      sessionHit: true,
      anchorsAsked: 2,
      anchorsReachingClaims: 1,
      readerInputTokens: 900,
      hash: "spanhash",
      claimHash: "claimhash",
      route: "multi_fact",
      flags: ["hasTimeRef"],
      askMs: 1200,
      stageTimingsMs: { arms: 150, hydrate: 40, read: 700 },
      unionSessions: ["s1", "s2", "s3"],
      budgetDroppedSessions: ["s9"],
      budgetDropIds: ["x1"],
      granularity: "span",
      estimatedTokens: 850,
      sufficiencyTier: "EXACT",
      errorClass: null
    })
    expect(row).not.toHaveProperty("sufficiencyMissing")
    expect(row).not.toHaveProperty("overBudget")
  })

  it("adds the read's hydration to the ask's graph time, and nothing else", () => {
    expect(graphMsOf(answered())).toBe(240)
    expect(graphMsOf(answered({ read: null }))).toBe(200)
    expect(rowFromV2(question, outcome(answered()), judgement, 0).graphMs).toBe(240)
  })

  it("phrases a structural abstention in fixed words and records no read fields", () => {
    const a = answered({ read: null, verdict: "ABSENT", reason: "A2_no_convergence" })
    const row = rowFromV2(question, outcome(a), { ...judgement, correct: false }, 10)
    expect(row.answer).toBe(absentResponse("A2_no_convergence"))
    expect(responseOf(outcome(a))).toBe(row.answer)
    expect(row.notInMemory).toBe(true)
    expect(row.evidence).toBe(0)
    expect(row).not.toHaveProperty("granularity")
    expect(row.keptSessions).toEqual([])
    expect(row.errorClass).toBe("selection")
  })

  it("uses the reader's answer only for an ANSWER verdict", () => {
    const a = answered({ verdict: "ABSENT", reason: "INSUFFICIENT_EVIDENCE" })
    expect(responseOf(outcome(a))).toContain("not all of it")
    expect(responseOf(outcome(answered()))).toBe("a bike")
  })
})

describe("rowFromBaseline", () => {
  it("records the reader's read and no v2 fields", () => {
    const spans = [span("s2", "u|c|1")]
    const row = rowFromBaseline(
      "bm25",
      question,
      {
        kind: "baseline",
        spans,
        sessionsDropped: 3,
        hash: "h",
        read: { answer: "a bike", notInMemory: false, inputTokens: 3000, outputTokens: 5 }
      },
      judgement,
      800
    )
    expect(() => Schema.decodeUnknownSync(EvalRow)(JSON.parse(JSON.stringify(row)))).not.toThrow()
    expect(row).toMatchObject({
      system: "bm25",
      verdict: "ANSWER",
      reason: null,
      sessionsDropped: 3,
      readerInputTokens: 3000,
      latencyMs: 800,
      route: null,
      sessionHit: true
    })
    expect(row).not.toHaveProperty("graphMs")
    expect(row).not.toHaveProperty("ablations")
  })
})
