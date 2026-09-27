import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  BENCHMARK_EXTRACTION_DEPENDENCIES,
  RECONCILE_FILE,
  buildFreezeDraft,
  buildReconciledUser,
  eligibleFromWitness,
  freezeFindings,
  freezeStatus,
  parseEvaluationFreeze,
  parseReconcileWitness,
  pinnedArtifacts,
  readSplitFile,
  sha256Text,
  splitFilePath,
  splitMembershipSha256,
  workspaceRoot,
  type ArtifactPin,
  type EvalEnvelope,
  type EvalRow,
  type EvaluationFreeze,
  type FreezeObservation,
  type FrozenRunContract,
  type PopulationRecord,
  type ReadArm,
  type ReconcileWitness,
  type SplitFile,
  type SystemName
} from "../../src/index.js"

const DATASET_SHA = sha256Text("dataset")
const RESULT = "results/palimpsest-v2-test.json"

const CONTRACT: FrozenRunContract = {
  codeIdentity: {
    strategy: "pinned-historical-commit",
    baseCommit: "a".repeat(40),
    lockfileSha256: "lock",
    harnessPatchSha256: null
  },
  scoring: {
    upstreamRevision: "upstream",
    endpoint: "chat-completions",
    model: "gpt-4o-2024-08-06",
    temperature: 0,
    maxTokens: 10,
    n: 1,
    parser: "case-insensitive-yes-substring",
    historicalScores: "secondary-only",
    scope: "rescore-all-frozen-answer-artifacts"
  },
  models: { reader: "reader", select: "select", sufficiency: "sufficiency" },
  extractionGeneration: "generation",
  profile: "full",
  variant: [],
  granularity: null,
  devReplay: {
    split: "dev",
    eligible: 60,
    cacheMode: "cache-only",
    batches: 15,
    batchSize: 4,
    outputRoot: "artifacts/dev"
  },
  testArm: {
    split: "test",
    eligible: 104,
    cacheMode: "read-write",
    batches: 26,
    batchSize: 4,
    outputRoot: "artifacts/test"
  },
  retry: { initialDelayMs: 1000, multiplier: 2, maxRetries: 4, jitter: true },
  runtime: { configSha256: "runtime", imageId: "image", composeSha256: "compose" },
  prices: { path: "data/splits/prices.json", sha256: sha256Text("data/splits/prices.json"), commit: "abc1234" },
  invalidRunConditions: ["invalid"],
  metrics: ["accuracy"],
  pairedTests: ["McNemar"],
  acceptanceThresholds: { gain: 3 }
}

const pin = (path: string): ArtifactPin => ({ path, sha256: sha256Text(path), commit: "abc1234" })

const GATE = {
  readAt: "2026-08-31T20:29:00.443Z",
  passed: true,
  numbers: { v1File: "results/v1-dev.json", v2File: "results/v2-dev.json", gain: 6 }
}

const splitFile = (overrides: Partial<SplitFile> = {}): SplitFile => ({
  schemaVersion: 1,
  dataset: "s",
  slice: 5,
  prefix: "g3",
  createdAt: "2026-08-29",
  note: "fixture",
  extractionGeneration: {
    id: "extract-v1-fixture",
    promptTemplateSha256: "prompt",
    outputSchemaSha256: "schema",
    dependencies: BENCHMARK_EXTRACTION_DEPENDENCIES
  },
  population: {
    requested: 5,
    ingested: {
      state: "verified",
      count: 4,
      evidenceKind: "legacy-query-visible",
      verifiedAt: "2026-09-10T20:33:17.392Z",
      witness: RECONCILE_FILE
    },
    capacityGateTripped: true,
    exclusions: [{ questionId: "t3", reason: "missing-source" }]
  },
  dev: ["d1", "d2"],
  test: ["t1", "t2", "t3"],
  gate: GATE,
  ...overrides
})

type Status = "complete" | "missing" | "partial"

const witnessOf = (split: SplitFile, statuses: ReadonlyMap<string, Status> = new Map([["t3", "missing"]])): ReconcileWitness => ({
  schemaVersion: 1,
  dataset: "s",
  datasetSha256: DATASET_SHA,
  membershipSha256: splitMembershipSha256(split),
  prefix: "g3",
  verifiedAt: "2026-09-10T20:33:17.392Z",
  evidenceKind: "legacy-query-visible",
  graph: { kind: "legacy-prefix", prefix: "g3", snapshotId: null },
  command: "fixture",
  users: [...split.dev, ...split.test].map((questionId) => {
    const status = statuses.get(questionId) ?? "complete"
    return buildReconciledUser({
      questionId,
      uid: `g3-${questionId}`,
      expectedSessionKeys: ["k1"],
      visibleSessionKeys: status === "complete" ? ["k1"] : status === "partial" ? ["k2"] : []
    })
  })
})

const row = (system: SystemName, questionId: string): EvalRow => ({
  system,
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
  hash: `h-${questionId}`
})

const envelopeOf = (
  system: SystemName,
  split: "dev" | "test",
  ids: ReadonlyArray<string>,
  overrides: Partial<EvalEnvelope> = {}
): EvalEnvelope => ({
  system,
  dataset: "s",
  prefix: "g3",
  split,
  profile: "full",
  slice: ids.length,
  readerModel: "gpt-5.6-luna",
  judgeModel: "gpt-4o",
  ablations: [],
  granularity: null,
  rows: ids.map((id) => row(system, id)),
  ...overrides
})

const ARMS: ReadonlyArray<ReadArm> = [
  { system: "palimpsest", split: "dev", artifact: pin("results/v1-dev.json"), rows: 2 },
  { system: "palimpsest-v2", split: "dev", artifact: pin("results/v2-dev.json"), rows: 2 },
  { system: "bm25", split: "test", artifact: pin("results/bm25-test.json"), rows: 3 }
]

const draftFor = (split: SplitFile, witness: ReconcileWitness, alreadyRead: ReadonlyArray<ReadArm> = ARMS): EvaluationFreeze =>
  buildFreezeDraft({
    dataset: { name: "s", path: "data/longmemeval_s_cleaned.json", sha256: DATASET_SHA },
    inputs: {
      split: pin("data/splits/retrieval-v2.json"),
      witness: pin(RECONCILE_FILE),
      populationDev: pin("data/splits/population-dev.json"),
      populationTest: pin("data/splits/population-test.json")
    },
    split,
    witness,
    gateReport: pin("results/gate-dev.md"),
    alreadyRead,
    claim: { kind: "held-out-not-blind", statement: "fixture", viewed: [] },
    contract: {
      ...CONTRACT,
      devReplay: { ...CONTRACT.devReplay, eligible: 2, batches: 1, batchSize: 2 },
      testArm: { ...CONTRACT.testArm, eligible: 2, batches: 1, batchSize: 2 }
    },
    blockers: [{ id: "code-identity", kind: "maintainer-decision", status: "open", summary: "decide", evidence: [] }],
    result: RESULT
  })

const intact = () => {
  const split = splitFile()
  const witness = witnessOf(split)
  const manifest = draftFor(split, witness)
  const populationRecord = (name: "dev" | "test"): PopulationRecord => ({
    schemaVersion: 1,
    split: name,
    dataset: "s",
    datasetSha256: DATASET_SHA,
    slice: 5,
    prefix: "g3",
    requested: 5,
    selected: 5,
    dev: 2,
    test: 3,
    answerable: 5,
    abstention: 0,
    ingested: {
      state: "verified",
      count: 4,
      evidenceKind: "legacy-query-visible",
      verifiedAt: "2026-09-10T20:33:17.392Z",
      witness: RECONCILE_FILE
    },
    capacityGateTripped: true,
    completion: "capacity-capped",
    exclusions: [{ questionId: "t3", reason: "missing-source" }],
    observed: { dev: true, test: true, note: "fixture" },
    membership: { dev: ["d1", "d2"], test: ["t1", "t2", "t3"] },
    eligible: { dev: ["d1", "d2"], test: ["t1", "t2"] },
    generatedAt: "2026-09-10T20:33:17.392Z",
    commands: ["fixture"],
    evaluated: name === "dev" ? ["d1", "d2"] : [],
    failures: []
  })
  const observation: FreezeObservation = {
    digests: new Map<string, string | null>([
      ...pinnedArtifacts(manifest).map((artifact) => [artifact.path, artifact.sha256] as const),
      [RESULT, null]
    ]),
    datasetSha256: DATASET_SHA,
    split,
    witness,
    populationRecords: new Map([
      ["dev", populationRecord("dev")],
      ["test", populationRecord("test")]
    ]),
    envelopes: new Map([
      ["results/v1-dev.json", envelopeOf("palimpsest", "dev", ["d1", "d2"])],
      ["results/v2-dev.json", envelopeOf("palimpsest-v2", "dev", ["d1", "d2"])],
      ["results/bm25-test.json", envelopeOf("bm25", "test", ["t1", "t2", "t3"])]
    ])
  }
  return { split, witness, manifest, observation }
}

const codes = (manifest: EvaluationFreeze, observation: FreezeObservation, purpose: "integrity" | "test-arm" = "integrity") =>
  freezeFindings(manifest, observation, purpose).map((finding) => finding.code)

describe("a freeze drafted from intact evidence", () => {
  it("passes the integrity check and derives the witnessed population", () => {
    const { manifest, observation } = intact()
    expect(freezeFindings(manifest, observation, "integrity")).toEqual([])
    expect(manifest.population.eligible).toEqual({ dev: ["d1", "d2"], test: ["t1", "t2"] })
    expect(manifest.population.exclusions).toEqual([{ questionId: "t3", reason: "missing-source" }])
    expect(manifest.population.original).toEqual({ dev: 2, test: 3 })
    expect(freezeStatus(manifest)).toBe("draft")
  })

  it("cannot qualify the test arm while a blocker is open, it is unsigned, or the arm already ran", () => {
    const { manifest, observation } = intact()
    expect(codes(manifest, observation, "test-arm")).toEqual(["blocker-open", "sign-off-missing"])

    const signed: EvaluationFreeze = {
      ...manifest,
      blockers: manifest.blockers.map((blocker) => ({ ...blocker, status: "resolved" as const })),
      signOff: { by: "maintainer", at: "2026-09-27", note: "approved" }
    }
    expect(freezeStatus(signed)).toBe("frozen")
    expect(codes(signed, observation, "test-arm")).toEqual([])

    const ran = { ...observation, digests: new Map([...observation.digests, [RESULT, sha256Text("result")]]) }
    expect(codes(signed, ran, "test-arm")).toEqual(["remaining-arm-present"])
    expect(codes(signed, ran, "integrity")).toEqual([])
  })
})

describe("drift", () => {
  it("reports a changed or missing pinned artifact by path", () => {
    const { manifest, observation } = intact()
    const changed = new Map(observation.digests)
    changed.set("results/bm25-test.json", sha256Text("rewritten"))
    changed.set("results/gate-dev.md", null)
    const findings = freezeFindings(manifest, { ...observation, digests: changed }, "integrity")
    expect(findings.map((finding) => [finding.code, finding.subject])).toEqual([
      ["artifact-missing", "results/gate-dev.md"],
      ["artifact-drift", "results/bm25-test.json"]
    ])
  })

  it("re-derives the population from the witness, so a newly missing user is drift", () => {
    const { manifest, observation, split } = intact()
    const witness = witnessOf(split, new Map([["t3", "missing"], ["t2", "missing"]]))
    const found = freezeFindings(manifest, { ...observation, witness }, "integrity")
    expect(found.map((finding) => finding.subject)).toEqual(["eligible test", "exclusions", "split exclusions"])
    expect(found[0]?.detail).toContain("t2")
  })

  it("excludes a partially visible user as ingest-failed rather than admitting it", () => {
    const split = splitFile()
    const derived = eligibleFromWitness(split, witnessOf(split, new Map([["t3", "missing"], ["d2", "partial"]])))
    expect(derived.dev).toEqual(["d1"])
    expect(derived.exclusions).toEqual([
      { questionId: "d2", reason: "ingest-failed" },
      { questionId: "t3", reason: "missing-source" }
    ])
  })

  it("pins the read-once gate record by content and requires its inputs to be pinned", () => {
    const { manifest, observation, split } = intact()
    const tampered = splitFile({ gate: { ...GATE, numbers: { ...GATE.numbers, gain: 7 } } })
    expect(codes(manifest, { ...observation, split: tampered })).toEqual(["gate-drift"])
    expect(codes(manifest, { ...observation, split: splitFile({ gate: null }) })).toContain("gate-drift")

    const unpinned = draftFor(split, witnessOf(split), ARMS.filter((arm) => arm.system !== "palimpsest"))
    const found = freezeFindings(unpinned, observation, "integrity")
    expect(found.map((finding) => [finding.code, finding.subject])).toEqual([["gate-drift", "gate v1File"]])
  })

  it("requires every already-read artifact to be one whole full run over the original split", () => {
    const { manifest, observation } = intact()
    const short = new Map(observation.envelopes)
    short.set("results/bm25-test.json", envelopeOf("bm25", "test", ["t1", "t2"]))
    const found = freezeFindings(manifest, { ...observation, envelopes: short }, "integrity")
    expect(found.map((finding) => finding.code)).toEqual(["already-read-drift", "already-read-drift"])
    expect(found[0]?.detail).toContain("lacks 1: t3")

    const variant = new Map(observation.envelopes)
    variant.set("results/bm25-test.json", envelopeOf("bm25", "test", ["t1", "t2", "t3"], { ablations: ["noSelect"] }))
    expect(codes(manifest, { ...observation, envelopes: variant })).toEqual(["already-read-drift"])
  })

  it("refuses a manifest that lists the remaining arm as already read", () => {
    const { split, witness, observation } = intact()
    const listed = draftFor(split, witness, [
      ...ARMS,
      { system: "palimpsest-v2", split: "test", artifact: pin("results/bm25-test.json"), rows: 3 }
    ])
    const found = freezeFindings(listed, observation, "integrity")
    expect(found[0]).toMatchObject({ code: "already-read-drift", subject: "palimpsest-v2 test" })
  })

  it("detects dataset, membership, and witness drift", () => {
    const { manifest, observation, witness } = intact()
    expect(codes(manifest, { ...observation, datasetSha256: sha256Text("other") })).toEqual(["dataset-drift"])
    expect(codes(manifest, { ...observation, datasetSha256: null })).toEqual(["dataset-drift"])

    const grown = splitFile({ test: ["t1", "t2", "t3", "t4"] })
    const found = codes(manifest, { ...observation, split: grown, witness })
    expect(found).toContain("membership-drift")
    expect(found).toContain("already-read-drift")

    const foreign = { ...witness, prefix: "g2", graph: { ...witness.graph, prefix: "g2" } }
    expect(codes(manifest, { ...observation, witness: foreign })).toEqual(["witness-drift"])
  })

  it("parses and reconciles the pinned population records instead of trusting their byte pins", () => {
    const { manifest, observation } = intact()
    const records = new Map(observation.populationRecords)
    const test = records.get("test")!
    records.set("test", { ...test, eligible: { ...test.eligible, test: ["t1"] } })
    const found = freezeFindings(manifest, { ...observation, populationRecords: records }, "integrity")
    expect(found).toEqual([
      {
        code: "population-record-drift",
        subject: "population test",
        detail: "eligible membership differs"
      }
    ])
  })

  it("rejects a manifest for another lane or claim", () => {
    const { manifest } = intact()
    const raw = JSON.parse(JSON.stringify(manifest))
    expect(parseEvaluationFreeze(raw)).toEqual(manifest)
    expect(() => parseEvaluationFreeze({ ...raw, lane: "retrieval-v3" })).toThrow()
    expect(() => parseEvaluationFreeze({ ...raw, claim: { ...raw.claim, kind: "blind" } })).toThrow()
  })
})

describe("the committed S00 evidence", () => {
  it("derives dev 60 and test 104 with 36 missing-source exclusions that match the split file", () => {
    const root = workspaceRoot()
    const split = readSplitFile(splitFilePath(root))
    const witness = parseReconcileWitness(JSON.parse(readFileSync(resolve(root, RECONCILE_FILE), "utf8")))
    const derived = eligibleFromWitness(split, witness)
    expect([derived.dev.length, derived.test.length, derived.exclusions.length]).toEqual([60, 104, 36])
    expect(new Set(derived.exclusions.map((entry) => entry.reason))).toEqual(new Set(["missing-source"]))
    expect(derived.exclusions).toEqual(
      [...(split.population.exclusions ?? [])].sort((left, right) => (left.questionId < right.questionId ? -1 : 1))
    )
    const recorded = JSON.parse(readFileSync(resolve(root, "data/splits/population-test.json"), "utf8"))
    expect(derived.test).toEqual([...recorded.eligible.test].sort())
  })
})
