import type { DatasetQuestion } from "@palimpsest/dataset"
import { describe, expect, it } from "vitest"
import {
  buildPopulationRecord,
  buildReconciledUser,
  completionFromWitness,
  exclusionsFrom,
  ingestionFailures,
  isVerifiedIngestion,
  membershipFailures,
  observedSplits,
  parseReconcileWitness,
  populationGateFailures,
  reconcileWitnessFailures,
  readSplitFile,
  splitFilePath,
  splitMembershipSha256,
  witnessQuestionIds,
  type PopulationMembership,
  type PopulationSection
} from "../../src/index.js"

const date = { raw: "2023/04/10 (Mon) 17:50", ts: 0, dateInt: 20230410 }

const question = (id: string, abstention = id.endsWith("_abs")): DatasetQuestion => ({
  questionId: id,
  questionType: "multi-session",
  question: "q",
  answer: "a",
  questionDate: date,
  sessions: [],
  answerSessionIds: [],
  isAbstention: abstention
})

const membership = (overrides: Partial<PopulationMembership> = {}): PopulationMembership => {
  const requested = [question("a"), question("b"), question("b_abs")]
  return {
    requested,
    selected: requested,
    dev: ["a", "b"],
    test: ["b_abs"],
    ...overrides
  }
}

const verified = (count: number) => ({
  state: "verified" as const,
  count,
  evidenceKind: "legacy-query-visible" as const,
  verifiedAt: "2026-09-11T00:00:00.000Z",
  witness: "data/splits/retrieval-v2.reconcile.json"
})

const section = (overrides: Partial<PopulationSection> = {}): PopulationSection => ({
  requested: 3,
  ingested: verified(3),
  capacityGateTripped: false,
  ...overrides
})

const recordInput = (overrides: Partial<Parameters<typeof buildPopulationRecord>[0]> = {}) => ({
  split: "dev" as const,
  dataset: "s",
  datasetSha256: "deadbeef",
  slice: 3,
  prefix: "g3",
  membership: membership(),
  population: section(),
  exclusions: [],
  observed: observedSplits({ dev: true, test: false }),
  generatedAt: "2026-09-11T00:00:00.000Z",
  commands: ["pnpm splits --check"],
  ...overrides
})

describe("ingestion evidence", () => {
  it("accepts only a witnessed, timestamped, evidence-bearing verified count", () => {
    expect(isVerifiedIngestion(verified(3))).toBe(true)
    expect(
      isVerifiedIngestion({
        state: "verified",
        count: 3,
        evidenceKind: "unknown",
        verifiedAt: null,
        witness: null
      })
    ).toBe(false)
  })

  it("reports every incompatible completion branch", () => {
    const cases = [
      {
        name: "unverified declaration",
        input: {
          ingested: { state: "unknown" as const, count: null, evidenceKind: "unknown" as const, verifiedAt: null, witness: null },
          selected: 3,
          completion: "unknown" as const,
          capacityGateTripped: false,
          exclusions: []
        },
        message: "not a verified count"
      },
      {
        name: "count above selection",
        input: {
          ingested: verified(4),
          selected: 3,
          completion: "complete" as const,
          capacityGateTripped: false,
          exclusions: []
        },
        message: "exceeds"
      },
      {
        name: "complete count with capacity flag",
        input: {
          ingested: verified(3),
          selected: 3,
          completion: "complete" as const,
          capacityGateTripped: true,
          exclusions: []
        },
        message: "capacityGateTripped"
      },
      {
        name: "partial count labelled complete",
        input: {
          ingested: verified(2),
          selected: 3,
          completion: "complete" as const,
          capacityGateTripped: false,
          exclusions: [{ questionId: "c", reason: "missing-source" as const }]
        },
        message: "only 2/3"
      }
    ]

    for (const { name, input, message } of cases) {
      expect(ingestionFailures(input), name).toEqual(expect.arrayContaining([expect.stringContaining(message)]))
    }
    expect(
      ingestionFailures({
        ingested: verified(2),
        selected: 3,
        completion: "capacity-capped",
        capacityGateTripped: true,
        exclusions: [{ questionId: "c", reason: "capacity-capped" }]
      })
    ).toEqual([])
  })
})

describe("population membership", () => {
  it("accepts one clean dev/test partition", () => {
    expect(membershipFailures(membership())).toEqual([])
  })

  it("rejects every way selected and split membership can disagree", () => {
    const cases: ReadonlyArray<readonly [string, PopulationMembership, string]> = [
      ["duplicate selection", membership({ selected: [question("a"), question("a"), question("b")] }), "duplicate"],
      ["split overlap", membership({ dev: ["a", "b"], test: ["b"] }), "overlap"],
      ["outside the slice", membership({ dev: ["a", "b", "zzz"] }), "outside benchmarkSlice"],
      ["uncovered selection", membership({ test: [] }), "in neither dev nor test"],
      ["unselected split id", membership({ selected: [question("a"), question("b")] }), "does not select"]
    ]

    for (const [name, input, message] of cases) {
      expect(membershipFailures(input), name).toEqual(expect.arrayContaining([expect.stringContaining(message)]))
    }
  })
})

describe("population records and gate", () => {
  it("builds a clean record with counts and exact split membership", () => {
    const record = buildPopulationRecord(recordInput())
    expect(record).toMatchObject({
      failures: [],
      completion: "complete",
      answerable: 2,
      abstention: 1,
      membership: { dev: ["a", "b"], test: ["b_abs"] },
      eligible: { dev: ["a", "b"], test: ["b_abs"] }
    })
  })

  it("keeps every capacity exclusion reason-coded and out of eligibility", () => {
    const selected = [question("a"), question("b"), question("c")]
    const exclusions = exclusionsFrom(["a", "b", "c"], ["a"], "capacity-capped")
    const record = buildPopulationRecord(
      recordInput({
        membership: membership({ requested: selected, selected, dev: ["a"], test: ["b", "c"] }),
        population: section({ ingested: verified(1), capacityGateTripped: true, completion: "capacity-capped" }),
        exclusions
      })
    )

    expect(record.failures).toEqual([])
    expect(record.exclusions).toEqual([
      { questionId: "b", reason: "capacity-capped" },
      { questionId: "c", reason: "capacity-capped" }
    ])
    expect(record.eligible).toEqual({ dev: ["a"], test: [] })
  })

  it("refuses missing, duplicate, or stray evaluated rows", () => {
    const record = buildPopulationRecord(recordInput())
    expect(populationGateFailures({ record, evaluated: ["a"] })).toEqual([
      expect.stringContaining("not evaluated")
    ])
    expect(populationGateFailures({ record, evaluated: ["a", "a", "b", "zzz"] })).toEqual(
      expect.arrayContaining([
        expect.stringContaining("repeat"),
        expect.stringContaining("not in the selected population")
      ])
    )
    expect(populationGateFailures({ record, evaluated: ["a", "b"] })).toEqual([])
  })

  it("uses exact non-excluded membership for a capacity-capped split", () => {
    const record = buildPopulationRecord(
      recordInput({
        population: section({
          ingested: verified(2),
          capacityGateTripped: true,
          completion: "capacity-capped"
        }),
        exclusions: [{ questionId: "b_abs", reason: "missing-source" }]
      })
    )
    expect(record.failures).toEqual([])
    expect(record.eligible).toEqual({ dev: ["a", "b"], test: [] })
    expect(populationGateFailures({ record, evaluated: ["a", "b"] })).toEqual([])
    expect(populationGateFailures({ record, evaluated: ["a", "b", "b_abs"] })).toContain(
      "1 evaluated id(s) are not in the selected population: b_abs"
    )
  })
})

describe("split observation", () => {
  it("describes the three visibility states without claiming the test split is blind", () => {
    const cases: ReadonlyArray<readonly [{ dev: boolean; test: boolean }, string]> = [
      [{ dev: true, test: true }, "not blind"],
      [{ dev: true, test: false }, "test is unread"],
      [{ dev: false, test: false }, "unobserved"]
    ]
    for (const [present, message] of cases) {
      expect(observedSplits(present).note).toContain(message)
    }
  })
})

describe("legacy reconciliation witnesses", () => {
  const user = buildReconciledUser({
    questionId: "a",
    uid: "g3-a",
    expectedSessionKeys: ["g3-a|sess|s1", "g3-a|sess|s2"],
    visibleSessionKeys: ["g3-a|sess|s2", "g3-a|sess|s1"]
  })
  const witness = {
    schemaVersion: 1 as const,
    dataset: "s",
    datasetSha256: "dataset",
    membershipSha256: "membership",
    prefix: "g3",
    verifiedAt: "2026-09-11T00:00:00.000Z",
    evidenceKind: "legacy-query-visible" as const,
    graph: { kind: "legacy-prefix" as const, prefix: "g3", snapshotId: null },
    command: "pnpm splits --check",
    users: [user]
  }

  it("compares exact session keys instead of mutable counters", () => {
    expect(user).toMatchObject({
      status: "complete",
      visibleSessionKeys: ["g3-a|sess|s1", "g3-a|sess|s2"],
      missingSessionKeys: [],
      unexpectedSessionKeys: []
    })
  })

  it("classifies missing, unexpected, and duplicate sessions as partial", () => {
    const partial = buildReconciledUser({
      questionId: "a",
      uid: "g3-a",
      expectedSessionKeys: ["s1", "s2"],
      visibleSessionKeys: ["s1", "s1", "other"]
    })
    expect(partial).toMatchObject({
      status: "partial",
      missingSessionKeys: ["s2"],
      unexpectedSessionKeys: ["other"],
      duplicateSessionKeys: ["s1"]
    })
  })

  it("parses the boundary artifact and derives status lists", () => {
    expect(parseReconcileWitness(JSON.parse(JSON.stringify(witness)))).toEqual(witness)
    expect(witnessQuestionIds(witness)).toEqual({ complete: ["a"], missing: [], partial: [] })
    expect(() => parseReconcileWitness({ ...witness, users: "not-an-array" })).toThrow()
  })

  it("fails stale membership and missing selected questions", () => {
    const failures = reconcileWitnessFailures(witness, {
      dataset: "s",
      datasetSha256: "dataset",
      membershipSha256: "different",
      prefix: "g3",
      expectedUsers: [
        { questionId: "a", uid: "g3-a", expectedSessionKeys: ["g3-a|sess|s1", "g3-a|sess|s2"] },
        { questionId: "b", uid: "g3-b", expectedSessionKeys: [] }
      ]
    })
    expect(failures).toContain("witness split membership hash does not match")
    expect(failures).toContain("witness omits selected question b")
  })

  it("hashes stable membership fields and derives completion from witnessed coverage", () => {
    const file = readSplitFile(splitFilePath())
    const changedMetadata = { ...file, createdAt: "changed", note: "changed" }
    expect(splitMembershipSha256(changedMetadata)).toBe(splitMembershipSha256(file))
    expect(splitMembershipSha256(file)).toHaveLength(64)
    expect(completionFromWitness(200, 200, true)).toBe("complete")
    expect(completionFromWitness(164, 200, true)).toBe("capacity-capped")
    expect(completionFromWitness(164, 200, false)).toBe("unknown")
  })
})
