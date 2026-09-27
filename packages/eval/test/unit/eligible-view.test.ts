import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  EligibleView,
  RECONCILE_FILE,
  decodeEnvelope,
  deriveEligibleView,
  eligibleFromWitness,
  fileSha256,
  joinEligible,
  parseReconcileWitness,
  readEnvelope,
  readSplitFile,
  renderEligibleView,
  splitFilePath,
  workspaceRoot,
  type EvalEnvelope,
  type EvalRow,
  type SplitPopulation,
  type SystemName
} from "../../src/index.js"

const row = (system: SystemName, questionId: string, overrides: Partial<EvalRow> = {}): EvalRow => ({
  system,
  questionId,
  questionType: "multi-session",
  isAbstention: questionId.endsWith("_abs"),
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
  evidenceSessions: ["s1"],
  answerSessions: ["s1"],
  sessionHit: true,
  evidence: 1,
  anchorsAsked: 0,
  anchorsReachingClaims: 0,
  readerInputTokens: 800,
  readerOutputTokens: 10,
  sessionsDropped: 0,
  latencyMs: 100,
  hash: `h-${questionId}`,
  ...overrides
})

const envelope = (ids: ReadonlyArray<string>, overrides: Partial<EvalEnvelope> = {}): EvalEnvelope => ({
  system: "bm25",
  dataset: "s",
  prefix: "g3",
  split: "test",
  profile: "full",
  slice: ids.length,
  readerModel: "gpt-5.6-luna",
  judgeModel: "gpt-4o",
  ablations: [],
  granularity: null,
  rows: ids.map((id) => row("bm25", id)),
  ...overrides
})

const population: SplitPopulation = {
  split: "test",
  original: ["t1", "t2", "t3"],
  eligible: ["t1", "t2"],
  exclusions: [
    { questionId: "t3", reason: "missing-source" },
    { questionId: "d9", reason: "missing-source" }
  ]
}

const source = (value: EvalEnvelope) => ({ path: "results/bm25-test.json", sha256: "abc", envelope: value })

const refusals = (value: EvalEnvelope, over: Partial<SplitPopulation> = {}): ReadonlyArray<string> => {
  const outcome = deriveEligibleView(source(value), { ...population, ...over })
  return outcome._tag === "Refused" ? outcome.reasons : []
}

describe("deriveEligibleView", () => {
  it("keeps exactly the eligible rows, in source order, without altering them", () => {
    const input = envelope(["t2", "t3", "t1"])
    const outcome = deriveEligibleView(source(input), population)
    if (outcome._tag !== "Derived") throw new Error(outcome.reasons.join("; "))
    const { view } = outcome
    expect(view.view.rows.map((kept) => kept.questionId)).toEqual(["t2", "t1"])
    expect(view.view.rows[0]).toBe(input.rows[0])
    expect(view.view.rows[1]).toBe(input.rows[2])
    expect(view.eligible).toEqual(["t1", "t2"])
    expect(view.excluded).toEqual([{ questionId: "t3", reason: "missing-source" }])
    expect(view.source).toEqual({ path: "results/bm25-test.json", sha256: "abc", rows: 3 })
    expect(view.system).toBe("bm25")
  })

  it("refuses a source that does not cover exactly the original split", () => {
    expect(refusals(envelope(["t1", "t2"])).join()).toContain("missing 1 id(s): t3")
    expect(refusals(envelope(["t1", "t2", "t3", "x9"])).join()).toContain("outside the population: x9")
    expect(refusals(envelope(["t1", "t1", "t2", "t3"])).join()).toContain("repeats t1")
  })

  it("refuses a population whose eligible and excluded ids do not partition the split", () => {
    expect(refusals(envelope(["t1", "t2", "t3"]), { eligible: ["t1", "t2", "t3"] }).join()).toContain(
      "eligible ids are also excluded: t3"
    )
    expect(refusals(envelope(["t1", "t2", "t3"]), { eligible: ["t1"] }).join()).toContain("missing 1 id(s): t2")
  })

  it("refuses anything that is not one whole full-pipeline run of the split", () => {
    const ids = ["t1", "t2", "t3"]
    expect(refusals(envelope(ids, { split: "dev" }))).toHaveLength(1)
    expect(refusals(envelope(ids, { ablations: ["noSelect"] }))).toHaveLength(1)
    expect(refusals(envelope(ids, { partial: true }))).toHaveLength(1)
    expect(refusals(envelope(ids, { batch: { index: 1, count: 2, population: ids } }))).toHaveLength(1)
  })

  it("renders deterministically, decodes as a view, and can never pass for a results envelope", () => {
    const outcome = deriveEligibleView(source(envelope(["t1", "t2", "t3"])), population)
    if (outcome._tag !== "Derived") throw new Error(outcome.reasons.join("; "))
    const text = renderEligibleView(outcome.view)
    expect(renderEligibleView(outcome.view)).toBe(text)
    expect(text.endsWith("}\n")).toBe(true)
    const parsed = JSON.parse(text)
    expect(Schema.decodeUnknownSync(EligibleView)(parsed)).toEqual(outcome.view)
    expect(() => decodeEnvelope(parsed)).toThrow()
  })
})

describe("the committed test baselines", () => {
  it("each yield a 104-row view of their untouched 140-row artifact with 36 named exclusions", () => {
    const root = workspaceRoot()
    const split = readSplitFile(splitFilePath(root))
    const witness = parseReconcileWitness(JSON.parse(readFileSync(resolve(root, RECONCILE_FILE), "utf8")))
    const derived = eligibleFromWitness(split, witness)
    for (const path of ["results/bm25-test.json", "results/fullctx-test.json", "results/oracle-session-test.json"]) {
      const before = fileSha256(resolve(root, path))
      const outcome = deriveEligibleView(
        { path, sha256: before ?? "", envelope: readEnvelope(resolve(root, path)) },
        { split: "test", original: split.test, eligible: derived.test, exclusions: derived.exclusions }
      )
      if (outcome._tag !== "Derived") throw new Error(`${path}: ${outcome.reasons.join("; ")}`)
      expect([outcome.view.source.rows, outcome.view.view.rows.length, outcome.view.excluded.length], path).toEqual([
        140, 104, 36
      ])
      expect(outcome.view.view.rows.map((kept) => kept.questionId).sort()).toEqual(derived.test)
      expect(fileSha256(resolve(root, path)), path).toBe(before)
    }
  })
})

describe("joinEligible", () => {
  const eligible = ["t1", "t2"]

  it("aligns arms that each cover exactly the eligible population", () => {
    const outcome = joinEligible(eligible, [
      { system: "palimpsest-v2", rows: [row("palimpsest-v2", "t2"), row("palimpsest-v2", "t1")] },
      { system: "bm25", rows: [row("bm25", "t1"), row("bm25", "t2")] }
    ])
    if (outcome._tag !== "Joined") throw new Error(outcome.reasons.join("; "))
    expect(outcome.questions.map((question) => question.questionId)).toEqual(["t1", "t2"])
    expect([...(outcome.questions[0]?.rows.keys() ?? [])]).toEqual(["palimpsest-v2", "bm25"])
    expect(outcome.questions[0]?.rows.get("palimpsest-v2")?.system).toBe("palimpsest-v2")
  })

  it("refuses the whole join on an id outside the population, a missing id, or a repeat", () => {
    const refused = (rows: ReadonlyArray<EvalRow>): string => {
      const outcome = joinEligible(eligible, [
        { system: "bm25", rows: [row("bm25", "t1"), row("bm25", "t2")] },
        { system: "palimpsest-v2", rows }
      ])
      return outcome._tag === "Refused" ? outcome.reasons.join("; ") : ""
    }
    expect(refused([row("palimpsest-v2", "t1"), row("palimpsest-v2", "t2"), row("palimpsest-v2", "t3")])).toContain(
      "palimpsest-v2 has 1 id(s) outside the population: t3"
    )
    expect(refused([row("palimpsest-v2", "t1")])).toContain("palimpsest-v2 is missing 1 id(s): t2")
    expect(refused([row("palimpsest-v2", "t1"), row("palimpsest-v2", "t1"), row("palimpsest-v2", "t2")])).toContain(
      "palimpsest-v2 repeats t1"
    )
  })

  it("refuses a question whose type or answerability differs between arms", () => {
    const outcome = joinEligible(eligible, [
      { system: "bm25", rows: [row("bm25", "t1"), row("bm25", "t2")] },
      { system: "palimpsest-v2", rows: [row("palimpsest-v2", "t1", { questionType: "temporal-reasoning" }), row("palimpsest-v2", "t2")] }
    ])
    expect(outcome._tag === "Refused" ? outcome.reasons.join() : "").toContain("t1 has inconsistent question type")
  })

  it("refuses repeated systems and an empty arm list", () => {
    const arm = { system: "bm25" as const, rows: [row("bm25", "t1"), row("bm25", "t2")] }
    expect(joinEligible(eligible, [arm, arm])._tag).toBe("Refused")
    expect(joinEligible(eligible, [])._tag).toBe("Refused")
  })
})
