import { describe, expect, it } from "vitest"
import {
  countedAnswerRefusals,
  qualificationRefusals,
  readQualification,
  type EvalEnvelope,
  type EvalRow,
  type QualificationThresholds
} from "../../src/index.js"

const thresholds: QualificationThresholds = {
  minimumAnswerableCorrectGain: 3,
  maximumWorstTypeAccuracyRegressionPercentagePoints: 8,
  maximumFalseAbstentionPercent: 8,
  minimumAbstentionCorrect: 3,
  maximumWarmGraphP50Ms: 400,
  maximumReaderInputTokensP50: 1200
}

const row = (questionId: string, overrides: Partial<EvalRow> = {}): EvalRow => ({
  system: "palimpsest-v2",
  questionId,
  questionType: "multi-session",
  isAbstention: false,
  verdict: "ANSWER",
  reason: null,
  answer: "answer",
  notInMemory: false,
  premiseSupported: null,
  premiseNote: "",
  judged: true,
  judgeTemplate: "default",
  judgeReply: "yes",
  judgeModel: "gpt-4o-2024-08-06",
  judgeResolvedModel: "gpt-4o-2024-08-06",
  evidenceSessions: [],
  answerSessions: [],
  sessionHit: true,
  evidence: 3,
  anchorsAsked: 5,
  anchorsReachingClaims: 4,
  readerInputTokens: 1000,
  readerOutputTokens: 40,
  sessionsDropped: 0,
  latencyMs: 1000,
  hash: "hash",
  graphMs: 300,
  ...overrides
})

const envelope = (rows: ReadonlyArray<EvalRow>, pass: "cold" | "warm" = "warm"): EvalEnvelope => ({
  system: "palimpsest-v2",
  dataset: "s",
  prefix: "g3",
  split: "dev",
  pass,
  slice: rows.length,
  readerModel: "gpt-5.6-luna",
  judgeModel: "gpt-4o-2024-08-06",
  scoreSource: { path: "answers.json", sha256: "a".repeat(64) },
  scoringProtocol: {
    endpoint: "chat-completions",
    model: "gpt-4o-2024-08-06",
    temperature: 0,
    maxTokens: 10,
    n: 1,
    parser: "case-insensitive-yes-substring"
  },
  rows
})

describe("D5 fresh-dev qualification", () => {
  it("applies every predeclared bound as one conjunction", () => {
    const baseline = Array.from({ length: 54 }, (_, index) => row(`q${index}`, { judged: index < 40 }))
    const candidate = Array.from({ length: 54 }, (_, index) => row(`q${index}`, { judged: index < 43 }))
    const abstention = Array.from({ length: 6 }, (_, index) => row(`a${index}`, { isAbstention: true, judged: index < 3 }))
    const report = readQualification([...baseline, ...abstention], [...candidate, ...abstention], thresholds)
    expect(report.passed).toBe(true)
    expect(report.numbers["answerableCorrectGain"]).toBe(3)
    expect(report.criteria.every((criterion) => criterion.passed)).toBe(true)
  })

  it("refuses non-identical populations, cold candidates, and non-upstream scores", () => {
    const baseline = envelope([row("q1")])
    const candidate = envelope([row("q2")], "cold")
    const { scoreSource: _scoreSource, scoringProtocol: _scoringProtocol, ...unscored } = baseline
    const refusals = qualificationRefusals(unscored, candidate, 1)
    expect(refusals).toContain("baseline is not scored by the exact upstream protocol")
    expect(refusals).toContain("baseline does not identify its immutable answer source")
    expect(refusals).toContain("candidate is not the counted warm pass")
    expect(refusals).toContain("candidate adds question q2")
    expect(refusals).toContain("candidate lacks question q1")
  })

  it("checks retrieval cache evidence on the answer artifact, not judge traces on its rescore", () => {
    const trace = {
      kind: "read",
      cacheKey: "key",
      cache: "hit" as const,
      requestedModel: "gpt-5.6-luna",
      resolvedModel: null,
      protocol: "responses" as const,
      promptSha256: "prompt",
      schemaSha256: "schema",
      outputSha256: "output"
    }
    const answer: EvalEnvelope = {
      ...envelope([row("q1")]),
      freezeManifestSha256: "manifest",
      codeIdentity: "harness",
      llmTrace: [trace]
    }
    expect(countedAnswerRefusals(answer, "manifest", "harness")).toEqual([])
    expect(countedAnswerRefusals({ ...answer, llmTrace: [{ ...trace, cache: "live" }] }, "manifest", "harness"))
      .toContain("counted candidate answer is not cache-hit-only")
  })
})
