import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  ENVELOPE_SUBJECT,
  canonicalJson,
  compareReplay,
  parseReplayRun,
  workspaceRoot,
  type EvalEnvelope,
  type EvalRow,
  type ReplayRun
} from "../../src/index.js"

const row = (questionId: string, overrides: Partial<EvalRow> = {}): EvalRow => ({
  system: "palimpsest-v2",
  questionId,
  questionType: "multi-session",
  isAbstention: false,
  verdict: "ANSWER",
  reason: null,
  answer: "a bike",
  notInMemory: false,
  premiseSupported: null,
  premiseNote: "",
  judged: true,
  judgeTemplate: "default",
  judgeReply: "Yes",
  judgeModel: "gpt-4o",
  evidenceSessions: ["s1", "s2"],
  answerSessions: ["s1"],
  sessionHit: true,
  evidence: 2,
  anchorsAsked: 4,
  anchorsReachingClaims: 3,
  readerInputTokens: 800,
  readerOutputTokens: 10,
  sessionsDropped: 0,
  latencyMs: 250,
  hash: `span-${questionId}`,
  askMs: 240,
  graphMs: 200,
  stageTimingsMs: { convergence: 60, select: 5 },
  claimHash: `claims-${questionId}`,
  unionSessions: ["s1", "s2", "s3"],
  ...overrides
})

const envelope = (rows: ReadonlyArray<EvalRow>, overrides: Partial<EvalEnvelope> = {}): EvalEnvelope => ({
  system: "palimpsest-v2",
  dataset: "s",
  prefix: "g3",
  split: "dev",
  profile: "full",
  slice: rows.length,
  readerModel: "gpt-5.6-luna",
  selectModel: "gpt-5.6-luna",
  sufficiencyModel: "gpt-5.6-luna",
  judgeModel: "gpt-4o",
  extractionGeneration: "extract-v1-fixture",
  ablations: [],
  granularity: null,
  rows,
  ...overrides
})

const run = (value: EvalEnvelope): ReplayRun => parseReplayRun(JSON.parse(JSON.stringify(value)))

const frozen = run(envelope([row("q1"), row("q2")]))

describe("canonicalJson", () => {
  it("is independent of key order and keeps array order significant", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}')
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
    expect(canonicalJson(["x", "y"])).not.toBe(canonicalJson(["y", "x"]))
    expect(canonicalJson("é")).toBe('"é"')
  })
})

describe("compareReplay", () => {
  it("treats a run that changes only measurement fields as semantically identical", () => {
    const replay = run(
      envelope([row("q1", { latencyMs: 90_000, askMs: 88_000, graphMs: 86_000, stageTimingsMs: { cold: 86_000 } }), row("q2")], {
        pass: "warm",
        variant: []
      })
    )
    expect(compareReplay(frozen, replay)).toEqual({
      verdict: "semantically-identical",
      compared: 2,
      missing: [],
      unexpected: [],
      repeated: [],
      differences: [],
      measurementOnly: 1,
      proofFindings: []
    })
  })

  it("reports every decision-bearing difference with canonical values, including order", () => {
    const replay = run(envelope([row("q1", { answer: "a car", unionSessions: ["s2", "s1", "s3"] }), row("q2")]))
    const comparison = compareReplay(frozen, replay)
    expect(comparison.verdict).toBe("semantically-different")
    expect(comparison.differences).toEqual([
      { questionId: "q1", field: "answer", frozen: '"a bike"', replay: '"a car"' },
      { questionId: "q1", field: "unionSessions", frozen: '["s1","s2","s3"]', replay: '["s2","s1","s3"]' }
    ])
  })

  it("counts a field present on one side only, including fields the schema does not name", () => {
    const replay = parseReplayRun({
      ...JSON.parse(JSON.stringify(envelope([row("q1", { sufficiencyMissing: "the date" }), row("q2")]))),
      rows: [
        { ...JSON.parse(JSON.stringify(row("q1", { sufficiencyMissing: "the date" }))) },
        { ...JSON.parse(JSON.stringify(row("q2"))), temporal: { perspective: "recorded" } }
      ]
    })
    expect(compareReplay(frozen, replay).differences).toEqual([
      { questionId: "q1", field: "sufficiencyMissing", frozen: null, replay: '"the date"' },
      { questionId: "q2", field: "temporal", frozen: null, replay: '{"perspective":"recorded"}' }
    ])
  })

  it("fails on missing, unexpected, and repeated questions", () => {
    const comparison = compareReplay(frozen, run(envelope([row("q1"), row("q3"), row("q3")])))
    expect(comparison.verdict).toBe("semantically-different")
    expect(comparison.missing).toEqual(["q2"])
    expect(comparison.unexpected).toEqual(["q3"])
    expect(comparison.repeated).toEqual(["q3"])
    expect(comparison.compared).toBe(1)
  })

  it("requires the same run identity and never accepts a cold pass", () => {
    const models = compareReplay(frozen, run(envelope([row("q1"), row("q2")], { readerModel: "gpt-5.7" })))
    expect(models.differences).toEqual([
      { questionId: ENVELOPE_SUBJECT, field: "readerModel", frozen: '"gpt-5.6-luna"', replay: '"gpt-5.7"' }
    ])
    const variant = compareReplay(frozen, run(envelope([row("q1"), row("q2")], { ablations: ["noSelect"] })))
    expect(variant.differences.map((difference) => difference.field)).toEqual(["variant", "ablations"])
    const cold = compareReplay(frozen, run(envelope([row("q1"), row("q2")], { pass: "cold" })))
    expect(cold.differences).toEqual([{ questionId: ENVELOPE_SUBJECT, field: "pass", frozen: null, replay: '"cold"' }])
  })

  it("requires cache-hit traces and evidence-byte hashes when qualifying a replay", () => {
    const withoutProof = compareReplay(frozen, run(envelope([row("q1"), row("q2")])), { requireProof: true })
    expect(withoutProof.verdict).toBe("semantically-different")
    expect(withoutProof.proofFindings).toContain("replay envelope has no LLM call trace")

    const replay = run(
      envelope(
        [row("q1", { evidenceBytesSha256: "a".repeat(64) }), row("q2", { evidenceBytesSha256: "b".repeat(64) })],
        {
          llmTrace: [
            {
              kind: "read",
              cacheKey: "key",
              cache: "hit",
              requestedModel: "gpt-5.6-luna",
              resolvedModel: null,
              protocol: "responses",
              promptSha256: "prompt",
              schemaSha256: "schema",
              outputSha256: "output"
            }
          ]
        }
      )
    )
    expect(compareReplay(frozen, replay, { requireProof: true }).verdict).toBe("semantically-identical")
  })
})

describe("the committed v2 dev result", () => {
  const raw = readFileSync(resolve(workspaceRoot(), "results/palimpsest-v2-dev.json"), "utf8")

  it("is semantically identical to an exact copy of itself", () => {
    const comparison = compareReplay(parseReplayRun(JSON.parse(raw)), parseReplayRun(JSON.parse(raw)))
    expect(comparison.verdict).toBe("semantically-identical")
    expect(comparison.compared).toBe(60)
  })

  it("isolates a single changed judge reply", () => {
    const copy = JSON.parse(raw)
    copy.rows[7].judgeReply = `${copy.rows[7].judgeReply} (edited)`
    const comparison = compareReplay(parseReplayRun(JSON.parse(raw)), parseReplayRun(copy))
    expect(comparison.differences.map((difference) => [difference.questionId, difference.field])).toEqual([
      [copy.rows[7].questionId, "judgeReply"]
    ])
  })
})
