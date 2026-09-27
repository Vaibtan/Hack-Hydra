import { HydraIdentityIntegrityError, HydraLimitError } from "@palimpsest/hydra"
import {
  ActiveSnapshotCorrupt,
  InvalidMemoryScope,
  MemoryScopeNotFound,
  NoActiveSnapshot,
  SnapshotGraphMismatch,
  SnapshotScopeViolation,
  type AnsweredPlan,
  type HydratedSpan,
  type Receipt as RetrievalReceipt,
  type TemporalStatement,
  type V2Answer
} from "@palimpsest/palimpsest"
import { describe, expect, it } from "vitest"
import { GraphError, NotFound } from "../../src/Api.js"
import { snapshotFailure, toAskResponse, toPublicEvidence } from "../../src/Handlers.js"
import { projectPlan } from "../../src/ReceiptProjection.js"

describe("snapshotFailure", () => {
  it("keeps an unknown scope a 404 with its tenant and user", () => {
    const failure = snapshotFailure(new MemoryScopeNotFound({ tenant: "tenant-a", uid: "user-a" }))

    expect(failure).toBeInstanceOf(NotFound)
    expect(failure).toMatchObject({ what: "user", key: "tenant-a/user-a" })
  })

  it("maps a missing active snapshot to a 503 that never reads as an absence", () => {
    const failure = snapshotFailure(new NoActiveSnapshot({ tenant: "tenant-a", uid: "user-a" }))

    expect(failure).toBeInstanceOf(GraphError)
    expect(failure).toMatchObject({ reason: "no active snapshot for tenant-a/user-a" })
  })

  it("names the corrupt pointer and its reason", () => {
    const failure = snapshotFailure(
      new ActiveSnapshotCorrupt({
        snapshotId: "snapshot-a",
        reason: "stateNotActive",
        detail: "SUPERSEDED"
      })
    )

    expect(failure).toMatchObject({ reason: "active snapshot snapshot-a is corrupt: stateNotActive" })
  })

  it("maps scope and graph mismatches to typed 503 reasons", () => {
    expect(
      snapshotFailure(
        new SnapshotScopeViolation({ expectedSnapshotId: "snapshot-a", key: "k", reason: "foreignSnapshot" })
      )
    ).toMatchObject({ reason: "snapshot scope violation: foreignSnapshot" })
    expect(
      snapshotFailure(
        new SnapshotGraphMismatch({ snapshotId: "snapshot-a", reason: "missingRoot", detail: "root" })
      )
    ).toMatchObject({ reason: "snapshot graph mismatch: missingRoot" })
  })

  it("passes a Hydra limit reason through", () => {
    const failure = snapshotFailure(
      new HydraLimitError({ reason: "retrieval stage edges exceeded 5000 ms", status: 408, query: "<ask:edges>" })
    )

    expect(failure).toMatchObject({ reason: "retrieval stage edges exceeded 5000 ms" })
  })

  it("reports an identity integrity failure without key material", () => {
    const failure = snapshotFailure(
      new HydraIdentityIntegrityError({
        kind: "vertex",
        reason: "numericMismatch",
        numericId: 7,
        existingKeyFingerprint: "abc",
        requestedKeyFingerprint: "def"
      })
    )

    expect(failure).toBeInstanceOf(GraphError)
    const reason = failure._tag === "GraphError" ? failure.reason : ""
    expect(reason).toContain("identity integrity")
    expect(reason).not.toContain("abc")
  })

  it("keeps manifest internals opaque even when they carry a reason string", () => {
    const failure = snapshotFailure(new InvalidMemoryScope({ field: "uid", reason: "must not be empty" }))

    expect(failure).toMatchObject({ reason: "memory scope is unavailable" })
  })
})

describe("toPublicEvidence", () => {
  const span = (): HydratedSpan => ({
    ckey: "ckey-a",
    id: "span-id-a",
    sid: "session-a",
    sessionKey: "session-a",
    turnIdx: 1,
    cs: 4,
    ce: 12,
    sessionOrd: 1,
    sessionDate: 20230101,
    tEvent: 0,
    speaker: "user",
    status: "CURRENT",
    atSession: null,
    excerpt: "The mortgage is with Wells Fargo.",
    highlight: { start: 0, end: 33 },
    provenance: {
      snapshotId: "snapshot-a",
      commitId: "commit-a",
      sourceDigest: "digest-a",
      logicalSessionId: "session-a",
      sourceTurnKey: "turn-a"
    }
  })

  it("projects verbatim excerpts with an immutable source locator", () => {
    const projected = toPublicEvidence([span()])

    expect(projected).toEqual([
      {
        ckey: "ckey-a",
        id: "span-id-a",
        sid: "session-a",
        sessionOrd: 1,
        sessionDate: 20230101,
        tEvent: 0,
        speaker: "user",
        status: "CURRENT",
        atSession: null,
        source: {
          snapshotId: "snapshot-a",
          commitId: "commit-a",
          sourceDigest: "digest-a",
          logicalSessionId: "session-a",
          sourceTurnKey: "turn-a",
          turnIdx: 1,
          offsetStart: 4,
          offsetEnd: 12
        },
        excerpt: "The mortgage is with Wells Fargo.",
        highlight: { start: 0, end: 33 }
      }
    ])
    expect("provenance" in projected[0]!).toBe(false)
  })

  it("fails closed when a snapshot span loses its immutable provenance", () => {
    const { provenance: _provenance, ...withoutProvenance } = span()
    expect(() => toPublicEvidence([withoutProvenance])).toThrow("missing immutable source provenance")
  })
})

describe("toAskResponse", () => {
  const temporal = (): TemporalStatement => ({
    perspective: "recorded-time",
    snapshotId: "snapshot-a",
    watermark: "COMMITTED",
    coverage: { revisionsCovered: 1, scopeRevisions: 2, uncommitted: 1 },
    caps: { topK: 25, maxLen: 2, unionCap: 120, armCap: 60 },
    stats: { snapshotId: "snapshot-a", totalClaims: 10 },
    completeness: {
      complete: false,
      timedOutArms: ["discovery"],
      unionDropped: 0,
      slotMateCapped: false,
      perspectiveFiltered: 1
    }
  })

  const receipt = (): RetrievalReceipt => ({
    question: "Where is my mortgage?",
    uid: "user-a",
    profile: "full",
    asOf: null,
    anchorTerms: ["mortgage"],
    anchorsReachingClaims: [],
    anchorsReachingNothing: ["mortgage"],
    historical: false,
    wantsCount: false,
    timeRef: null,
    convergenceThreshold: 1,
    totalClaims: 10,
    query1: "CALL algo.MSpaths($source) YIELD path RETURN path",
    query1Params: { maxLen: 2, pathCount: 100 },
    query1Paths: 0,
    query2: null,
    query2Paths: 0,
    models: { reader: "stub", select: "stub", sufficiency: "stub" },
    convergence: [],
    temporal: temporal()
  })

  const plan = (): AnsweredPlan => ({
    route: "fact",
    routeReason: "model",
    flags: { wantsCount: false, hasTimeRef: false, needsDecomposition: false },
    subQuestions: [],
    probes: [],
    extraTerms: [],
    arms: [],
    union: { candidates: 0, dropped: 0 },
    timeScope: { phrase: null, interval: null, inScope: 0, outOfScope: 1, applied: true },
    selection: { kept: [], dropped: [], reasons: {}, fallback: false },
    sufficiency: { tier: "skipped", missing: "", premise: "", premiseContradictedBy: [], secondPass: false },
    budget: { budget: 4000, estimatedTokens: 0, charsPerToken: 4, dropped: [], overBudget: false },
    intervalSentence: null,
    slots: {},
    protectedKeys: [],
    unionSessions: [],
    ablations: {},
    temporal: temporal()
  })

  const answered = (): V2Answer => ({
    ask: {
      verdict: "INCOMPLETE",
      reason: "INCOMPLETE_MEMORY",
      evidence: [],
      receipt: receipt(),
      hash: "hash",
      timings: { askMs: 1, graphMs: 1, stages: {} },
      plan: plan()
    },
    read: null,
    verdict: "INCOMPLETE",
    reason: "INCOMPLETE_MEMORY",
    sufficiency: {
      tier: "EXACT",
      missing: "",
      missingTerms: [],
      premise: "",
      premiseCitedIds: [],
      skipped: true,
      cached: true
    },
    secondPass: false,
    passes: 1,
    hash: "hash"
  })

  it("presents an incomplete search as an explicit non-answer, never an absence", () => {
    const response = toAskResponse(answered(), [], Date.now())

    expect(response.verdict).toBe("INCOMPLETE")
    expect(response.reason).toBe("INCOMPLETE_MEMORY")
    expect(response.answer).toBeNull()
    expect(response.notInMemory).toBe(false)
    expect(response.receipt.temporal).toMatchObject({
      perspective: "recorded-time",
      completeness: { complete: false }
    })
  })

  it("projects the temporal statement into the demo plan", () => {
    expect(projectPlan(answered()).temporal).toEqual(temporal())
  })
})
