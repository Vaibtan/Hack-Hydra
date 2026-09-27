import type { DatasetSession } from "@palimpsest/dataset"
import { HydraMemory as HydraMemoryService } from "@palimpsest/hydra"
import { Data, Effect, Layer, Result } from "effect"
import { describe, expect, it } from "vitest"
import { makeHydraMemory, relIdentity, writeSourcePlane, type HydraMemory } from "../HydraMemory.js"
import { claimDigest } from "../../src/ClaimGraph.js"
import { createEntityCanonicalView } from "../../src/EntityCanonicalView.js"
import { createExtractionArtifact } from "../../src/ExtractionArtifact.js"
import type { ExtractedClaim, ExtractedEntity } from "../../src/Extract.js"
import { IndexGraph } from "../../src/IndexGraph.js"
import { createIndexGeneration } from "../../src/IndexGeneration.js"
import {
  createUserIndexSnapshot,
  IngestManifest,
  IngestManifestLayerMemory,
  type IngestManifestService,
  type IngestState,
  type SourceRevision
} from "../../src/IngestManifest.js"
import { IngestCommitLock, IngestCommitLockMemory } from "../../src/IngestCommitLock.js"
import { parseMemoryScope, type MemoryScope } from "../../src/MemoryScope.js"
import { SnapshotGraph, snapshotClaimKey } from "../../src/SnapshotGraph.js"
import {
  canonicalSessionSource,
  createExtractionGeneration,
  sourceRevisionInputForSession
} from "../../src/SourceIdentity.js"
import { SourceTranscript } from "../../src/SourceTranscript.js"
import {
  collectSupersessionChains,
  decideSlotSupersession,
  matchKeyEquivalences,
  pairsToDecisionLinks,
  SupersessionDecisionUnavailable,
  type SupersessionChain,
  type SupersessionIndexPair,
  type SupersessionChainSource
} from "../../src/SupersessionDecision.js"
import { classifySourceIndexFailure } from "../../src/SourceIndexing.js"
import { Llm } from "@palimpsest/llm"
import { AiError } from "effect/unstable/ai"
import { behaviorFake } from "../BehaviorFake.js"
import {
  commitScope,
  runTransactionalSourceCommit,
  runTransactionalSourceIndex
} from "../../src/TransactionalSourceIndex.js"

const scope = Result.getOrThrow(parseMemoryScope("default", "user-a"))
const otherScope = Result.getOrThrow(parseMemoryScope("default", "user-b"))

const EXTRACTION = createExtractionGeneration({
  extractor: { id: "claim-extractor", revision: "git:abc123" },
  model: { id: "provider/model", revision: "snapshot:2026-08-20" },
  tokenizer: { id: "provider/tokenizer", revision: "v1" },
  promptTemplate: "Extract claims.",
  outputSchema: { type: "object", version: 1 }
})

const GENERATION = createIndexGeneration({
  extractionGeneration: EXTRACTION,
  graphWriter: { id: "palimpsest-index-graph", revision: "git:abc123" },
  graphSchema: { id: "palimpsest-index-schema", revision: "v1" }
})

const sessionA: DatasetSession = {
  sid: "s-a",
  key: "session-a",
  sessionOrd: 1,
  date: { raw: "2026-08-20", dateInt: 20260820, ts: 1_755_657_600_000 },
  turns: [
    { turnIdx: 0, role: "user", text: "I live in Mumbai with my hamster Suki.", hasAnswer: false }
  ]
}
const sessionB: DatasetSession = {
  sid: "s-b",
  key: "session-b",
  sessionOrd: 2,
  date: { raw: "2026-08-25", dateInt: 20260825, ts: 1_756_089_600_000 },
  turns: [{ turnIdx: 0, role: "user", text: "I moved to Berlin last week.", hasAnswer: false }]
}
const sessionC: DatasetSession = {
  sid: "s-c",
  key: "session-c",
  sessionOrd: 3,
  date: { raw: "2026-09-01", dateInt: 20260901, ts: 1_756_694_400_000 },
  turns: [{ turnIdx: 0, role: "user", text: "Still in Berlin, and happy about it.", hasAnswer: false }]
}

const nate: ExtractedEntity = { canon: "Nate", etype: "self", aliases: ["I"] }
const nathan: ExtractedEntity = { canon: "Nathan", etype: "self", aliases: ["Nate"] }

const claimA1: ExtractedClaim = {
  text: "Nate lives in Mumbai.",
  speaker: "user",
  ctype: "fact",
  entities: [nate],
  slot: { entityCanon: "Nate", attr: "residence" },
  tEvent: 20260820,
  tPrec: "day",
  span: { turnIdx: 0, cs: 0, ce: 20 },
  keywords: ["Mumbai"],
  located: "exact"
}
const claimB1: ExtractedClaim = {
  text: "Nathan moved to Berlin.",
  speaker: "user",
  ctype: "fact",
  entities: [nathan],
  slot: { entityCanon: "Nathan", attr: "residence" },
  tEvent: 20260825,
  tPrec: "day",
  span: { turnIdx: 0, cs: 0, ce: 22 },
  keywords: ["Berlin"],
  located: "exact"
}
const claimC1: ExtractedClaim = {
  text: "Nathan still lives in Berlin.",
  speaker: "user",
  ctype: "fact",
  entities: [nathan],
  slot: { entityCanon: "Nathan", attr: "residence" },
  tEvent: 20260901,
  tPrec: "day",
  span: { turnIdx: 0, cs: 0, ce: 28 },
  keywords: ["Berlin"],
  located: "exact"
}
const claimA2: ExtractedClaim = {
  ...claimA1,
  text: "Nate works at Acme.",
  slot: { entityCanon: "Nate", attr: "employer" },
  span: { turnIdx: 0, cs: 21, ce: 38 },
  keywords: ["Acme"]
}
const claimB2: ExtractedClaim = {
  ...claimB1,
  text: "Nathan now works at Globex.",
  slot: { entityCanon: "Nathan", attr: "employer" },
  span: { turnIdx: 0, cs: 0, ce: 28 },
  keywords: ["Globex"]
}

class TestDeciderError extends Data.TaggedError("TestDeciderError")<{
  readonly reason: string
}> {}

class TestFatalError extends Data.TaggedError("TestFatalError")<{
  readonly reason: string
}> {}

const artifactFor = (
  revision: SourceRevision,
  session: DatasetSession,
  claims: ReadonlyArray<ExtractedClaim>
) =>
  createExtractionArtifact({
    commitId: revision.commitId,
    sourceDigest: revision.sourceDigest,
    extractionGeneration: revision.extractionGeneration,
    extraction: { sid: session.sid, sessionOrd: revision.sessionOrdinal, claims, dropped: [] }
  })

const makeTestLayer = (memory: HydraMemory) => {
  const deps = Layer.mergeAll(
    IngestManifestLayerMemory,
    Layer.succeed(HydraMemoryService, memory.client),
    IngestCommitLockMemory
  )
  const services = Layer.provide(
    Layer.mergeAll(SourceTranscript.layer, IndexGraph.layer, SnapshotGraph.layer),
    deps
  )
  return Layer.mergeAll(deps, services)
}

type TestRequirements =
  | IngestManifest
  | IngestCommitLock
  | HydraMemoryService
  | SourceTranscript
  | IndexGraph
  | SnapshotGraph

const run = <A, E>(memory: HydraMemory, effect: Effect.Effect<A, E, TestRequirements>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(makeTestLayer(memory)))))

interface Counters {
  extractCalls: number
  decideCalls: number
  readonly chains: Array<SupersessionChain>
}

const counters = (): Counters => ({ extractCalls: 0, decideCalls: 0, chains: [] })

const commitWith = (
  seen: Counters,
  claims: ReadonlyArray<ExtractedClaim>,
  session: DatasetSession,
  decide?: (
    chain: SupersessionChain
  ) => Effect.Effect<ReadonlyArray<SupersessionIndexPair>, TestDeciderError | TestFatalError>
) =>
  runTransactionalSourceCommit({
    sourceRevision: sourceRevisionInputForSession(scope, session, EXTRACTION),
    indexGeneration: GENERATION,
    session,
    extract: (input) =>
      Effect.sync(() => {
        seen.extractCalls++
        return { sid: input.sid, sessionOrd: input.sessionOrd, claims, dropped: [] }
      }),
    decideSupersession: (chain) =>
      Effect.sync(() => {
        seen.decideCalls++
        seen.chains.push(chain)
      }).pipe(
        Effect.flatMap(() => {
          if (decide !== undefined) return decide(chain)
          const empty: ReadonlyArray<SupersessionIndexPair> = []
          return Effect.succeed(empty)
        })
      ),
    classifyFailure: ({ error }) =>
      error._tag === "TestDeciderError"
        ? { code: "DECIDER_DOWN", retryable: true }
        : { code: error._tag, retryable: false }
  })

/** Seed a revision to a target durable state with real transcript rows, artifact, and (past ENRICHED) decisions. */
const seedTo = (
  memory: HydraMemory,
  session: DatasetSession,
  claims: ReadonlyArray<ExtractedClaim>,
  target: IngestState
) =>
  Effect.gen(function* () {
    const manifest = yield* IngestManifest
    let revision = (
      yield* manifest.begin(sourceRevisionInputForSession(scope, session, EXTRACTION))
    ).revision
    if (target === "RECEIVED") return revision
    revision = yield* manifest.advance({ revision, from: "RECEIVED", to: "SOURCE_DURABLE" })
    writeSourcePlane(memory, revision, session)
    if (target === "SOURCE_DURABLE") return revision
    revision = yield* manifest.advance({ revision, from: "SOURCE_DURABLE", to: "INDEXED" })
    yield* manifest.storeExtractionArtifact({
      revision,
      artifact: artifactFor(revision, session, claims)
    })
    if (target === "INDEXED") return revision
    revision = yield* manifest.advance({ revision, from: "INDEXED", to: "ENRICHED" })
    yield* manifest.storeSupersessionDecisions({ revision, links: [] })
    if (target === "ENRICHED") return revision
    revision = yield* manifest.advance({ revision, from: "ENRICHED", to: "CONSOLIDATED" })
    if (target === "CONSOLIDATED") return revision
    return yield* manifest.advance({ revision, from: "CONSOLIDATED", to: "COMMITTED" })
  })

const SCOPE_INPUT = { tenant: scope.tenantId, uid: scope.uid }

const readActive = (manifest: IngestManifestService) =>
  manifest.readActiveIndexSnapshot(SCOPE_INPUT)

/** Register a snapshot covering `commitIds` and mark it VERIFIED with fixed evidence. */
const registerVerified = (
  manifest: IngestManifestService,
  snapshotScope: MemoryScope,
  commitIds: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    yield* manifest.storeIndexGeneration({ generation: GENERATION })
    const view = Result.getOrThrow(
      createEntityCanonicalView({
        identities: [{ id: "identity-self", canon: "Nate", etype: "self" }],
        equivalences: []
      })
    )
    yield* manifest.storeEntityCanonicalView({ ...SCOPE_INPUT, view })
    const snapshot = Result.getOrThrow(
      createUserIndexSnapshot({
        scope: snapshotScope,
        indexGenerationId: GENERATION.id,
        canonicalViewId: view.id,
        sourceCommitIds: commitIds,
        manifestSchemaVersion: 1
      })
    )
    yield* manifest.registerUserIndexSnapshot({ snapshot })
    return yield* manifest.verifyUserIndexSnapshot({
      snapshotId: snapshot.id,
      verificationDigest: "a".repeat(64),
      graphRoots: ["root"],
      counts: { sourceRevisions: commitIds.length, vertices: 1, relationships: 0 }
    })
  })

// ---------------------------------------------------------------------------
// runTransactionalSourceCommit
// ---------------------------------------------------------------------------

describe("runTransactionalSourceCommit", () => {
  it("drives a fresh session to COMMITTED and activates a covering snapshot", async () => {
    const memory = makeHydraMemory()
    const seen = counters()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const committed = yield* commitWith(seen, [claimA1], sessionA)
        const manifest = yield* IngestManifest
        const active = yield* readActive(manifest)
        const decisions = yield* manifest.readSupersessionDecisions(committed.revision)
        const activeView = yield* manifest.readActiveEntityCanonicalView(SCOPE_INPUT)
        const activeGeneration = yield* manifest.readActiveIndexGeneration(SCOPE_INPUT)
        return { committed, active, decisions, activeView, activeGeneration }
      })
    )
    expect(result.committed.revision.state).toBe("COMMITTED")
    expect(result.committed.alreadyCommitted).toBe(false)
    expect(result.committed.queryVisible).toBe(true)
    expect(result.committed.snapshotId).not.toBeNull()
    expect(result.active?.record.snapshot.id).toBe(result.committed.snapshotId)
    expect(result.active?.record.snapshot.sourceCommitIds).toEqual([
      result.committed.revision.commitId
    ])
    expect(result.active?.record.state).toBe("ACTIVE")
    expect(result.activeView?.id).toBe(result.active?.record.snapshot.canonicalViewId)
    expect(result.activeGeneration?.id).toBe(result.active?.record.snapshot.indexGenerationId)
    expect(result.decisions?.commitId).toBe(result.committed.revision.commitId)
    expect(result.decisions?.links).toEqual([])
    expect(seen.extractCalls).toBe(1)
    expect(seen.decideCalls).toBe(0)
    const roots = [...memory.vertices.values()].filter(
      (vertex) => vertex.label === "SnapshotRoot"
    )
    expect(roots).toHaveLength(1)
  })

  it("persists decided supersession links and projects them into the active snapshot", async () => {
    const memory = makeHydraMemory()
    const seen = counters()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const first = yield* commitWith(seen, [claimA1], sessionA)
        const second = yield* commitWith(seen, [claimB1], sessionB, () =>
          Effect.succeed([{ older: 0, newer: 1 }])
        )
        const manifest = yield* IngestManifest
        const active = yield* readActive(manifest)
        const decisionsA = yield* manifest.readSupersessionDecisions(first.revision)
        const decisionsB = yield* manifest.readSupersessionDecisions(second.revision)
        const previous = first.snapshotId === null
          ? null
          : yield* manifest.readUserIndexSnapshot(first.snapshotId)
        return { first, second, active, decisionsA, decisionsB, previous }
      })
    )
    expect(result.second.revision.state).toBe("COMMITTED")
    expect(result.active?.record.snapshot.sourceCommitIds).toEqual([
      result.first.revision.commitId,
      result.second.revision.commitId
    ])
    expect(result.previous?.state).toBe("SUPERSEDED")
    expect(result.decisionsA?.links).toEqual([])

    const olderDigest = claimDigest(claimA1, sessionA.key)
    const newerDigest = claimDigest(claimB1, sessionB.key)
    expect(result.decisionsB?.links).toEqual([
      {
        older: { commitId: result.first.revision.commitId, claimDigest: olderDigest },
        newer: { commitId: result.second.revision.commitId, claimDigest: newerDigest }
      }
    ])

    const snapshotId = result.active?.record.snapshot.id ?? "missing"
    const olderKey = snapshotClaimKey(
      scope,
      snapshotId,
      result.first.revision.commitId,
      olderDigest
    )
    const newerKey = snapshotClaimKey(
      scope,
      snapshotId,
      result.second.revision.commitId,
      newerDigest
    )
    expect(
      memory.relations.has(relIdentity(olderKey, "SNAPSHOT_SUPERSEDED_BY", newerKey))
    ).toBe(true)
    expect(seen.decideCalls).toBe(1)
    expect(seen.chains[0]?.entityCanon).toBe("Nate")
    expect(seen.chains[0]?.attr).toBe("residence")
    expect(seen.chains[0]?.claims.map((claim) => claim.text)).toEqual([
      claimA1.text,
      claimB1.text
    ])
  })

  it("repeating the same session is a verified no-op", async () => {
    const memory = makeHydraMemory()
    const seen = counters()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const first = yield* commitWith(seen, [claimA1], sessionA)
        const callsAfterFirst = { ...memory.calls }
        const second = yield* commitWith(seen, [claimA1], sessionA)
        return { first, second, callsAfterFirst, callsAfterSecond: { ...memory.calls } }
      })
    )
    expect(result.second.alreadyCommitted).toBe(true)
    expect(result.second.revision.commitId).toBe(result.first.revision.commitId)
    expect(result.second.snapshotId).toBe(result.first.snapshotId)
    expect(result.second.queryVisible).toBe(true)
    expect(result.callsAfterSecond).toEqual(result.callsAfterFirst)
    expect(seen.extractCalls).toBe(1)
  })

  it("resumes from INDEXED without re-extracting or rewriting the transcript", async () => {
    const memory = makeHydraMemory()
    const seen = counters()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const seeded = yield* seedTo(memory, sessionA, [claimA1], "INDEXED")
        const committed = yield* commitWith(seen, [claimA1], sessionA)
        const manifest = yield* IngestManifest
        const active = yield* readActive(manifest)
        const decisions = yield* manifest.readSupersessionDecisions(seeded)
        return { seeded, committed, active, decisions }
      })
    )
    expect(result.committed.revision.state).toBe("COMMITTED")
    expect(result.committed.revision.commitId).toBe(result.seeded.commitId)
    expect(result.committed.queryVisible).toBe(true)
    expect(result.active?.record.snapshot.sourceCommitIds).toContain(result.seeded.commitId)
    expect(result.decisions).not.toBeNull()
    expect(seen.extractCalls).toBe(0)
    expect(seen.decideCalls).toBe(0)
  })

  it("resumes from ENRICHED using the stored decisions without re-deciding", async () => {
    const memory = makeHydraMemory()
    const seen = counters()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const seeded = yield* seedTo(memory, sessionA, [claimA1], "ENRICHED")
        const committed = yield* commitWith(seen, [claimA1], sessionA)
        return { seeded, committed }
      })
    )
    expect(result.committed.revision.state).toBe("COMMITTED")
    expect(result.committed.queryVisible).toBe(true)
    expect(seen.decideCalls).toBe(0)
    expect(seen.extractCalls).toBe(0)
  })

  it("converges a CONSOLIDATED revision whose commit never ran", async () => {
    const memory = makeHydraMemory()
    const seen = counters()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const seeded = yield* seedTo(memory, sessionA, [claimA1], "CONSOLIDATED")
        const committed = yield* commitWith(seen, [claimA1], sessionA)
        const manifest = yield* IngestManifest
        return { seeded, committed, active: yield* readActive(manifest) }
      })
    )
    expect(result.committed.revision.state).toBe("COMMITTED")
    expect(result.committed.queryVisible).toBe(true)
    expect(result.active?.record.snapshot.sourceCommitIds).toContain(result.seeded.commitId)
    expect(seen.decideCalls).toBe(0)
  })

  it("a retryable stage failure records the failure and a retry converges", async () => {
    const memory = makeHydraMemory()
    const seen = counters()
    const result = await run(
      memory,
      Effect.gen(function* () {
        // revA seeds the contested residence slot the decider must resolve for revB.
        yield* seedTo(memory, sessionA, [claimA1], "INDEXED")
        const failing = yield* Effect.result(
          commitWith(seen, [claimB1], sessionB, () =>
            Effect.fail(new TestDeciderError({ reason: "provider down" }))
          )
        )
        const manifest = yield* IngestManifest
        const begun = yield* manifest.begin(
          sourceRevisionInputForSession(scope, sessionB, EXTRACTION)
        )
        const midRevision = yield* manifest.readSourceRevisionByCommitId(
          begun.revision.commitId
        )
        const activeMid = yield* readActive(manifest)
        const recovered = yield* commitWith(seen, [claimB1], sessionB)
        const activeAfter = yield* readActive(manifest)
        return { failing, midRevision, activeMid, recovered, activeAfter }
      })
    )
    expect(Result.isFailure(result.failing)).toBe(true)
    if (Result.isFailure(result.failing)) {
      expect(result.failing.failure._tag).toBe("IngestStageFailed")
      if (result.failing.failure._tag === "IngestStageFailed") {
        expect(result.failing.failure.stage).toBe("ENRICHED")
        expect(result.failing.failure.retryable).toBe(true)
      }
    }
    expect(result.midRevision?.state).toBe("INDEXED")
    expect(result.midRevision?.failureCode).toBe("DECIDER_DOWN")
    expect(result.activeMid).toBeNull()
    expect(result.recovered.revision.state).toBe("COMMITTED")
    expect(result.recovered.queryVisible).toBe(true)
    expect(result.activeAfter?.record.snapshot.sourceCommitIds).toContain(
      result.recovered.revision.commitId
    )
  })

  it("persists each successful chain before a later provider failure", async () => {
    const memory = makeHydraMemory()
    const seen = counters()
    const result = await run(
      memory,
      Effect.gen(function* () {
        yield* commitWith(seen, [claimA1, claimA2], sessionA)
        const first = yield* Effect.result(
          commitWith(seen, [claimB1, claimB2], sessionB, (chain) =>
            chain.attr === "residence"
              ? Effect.fail(new TestDeciderError({ reason: "provider down" }))
              : Effect.succeed([])
          )
        )
        const manifest = yield* IngestManifest
        const revision = (
          yield* manifest.begin(sourceRevisionInputForSession(scope, sessionB, EXTRACTION))
        ).revision
        const successful = seen.chains.find((chain) => chain.attr === "employer")
        if (successful === undefined) return yield* Effect.die("missing successful chain")
        const checkpoint = yield* manifest.readSupersessionChainDecisions(
          revision,
          successful.id
        )
        const recovered = yield* commitWith(seen, [claimB1, claimB2], sessionB)
        return { first, checkpoint, recovered }
      })
    )
    expect(Result.isFailure(result.first)).toBe(true)
    expect(result.checkpoint?.links).toEqual([])
    expect(seen.chains.map((chain) => chain.attr)).toEqual([
      "employer",
      "residence",
      "residence"
    ])
    expect(result.recovered.revision.state).toBe("COMMITTED")
    expect(result.recovered.queryVisible).toBe(true)
  })

  it("keeps all active pointers on the previous snapshot when verification fails, then retries", async () => {
    const memory = makeHydraMemory()
    const seen = counters()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const first = yield* commitWith(seen, [claimA1], sessionA)
        const manifest = yield* IngestManifest
        const beforeSnapshot = yield* readActive(manifest)
        const beforeView = yield* manifest.readActiveEntityCanonicalView(SCOPE_INPUT)
        const beforeGeneration = yield* manifest.readActiveIndexGeneration(SCOPE_INPUT)
        const seeded = yield* seedTo(memory, sessionB, [claimB1], "ENRICHED")
        memory.onRead = () => {
          memory.onRead = undefined
          const victim = [...memory.vertices.entries()].find(
            ([, vertex]) =>
              vertex.label === "SnapshotClaim" &&
              vertex.properties["snapshot_id"] !== beforeSnapshot?.record.snapshot.id
          )
          if (victim !== undefined) memory.vertices.delete(victim[0])
        }
        const failed = yield* Effect.result(
          runTransactionalSourceCommit({
            sourceRevision: sourceRevisionInputForSession(scope, sessionB, EXTRACTION),
            indexGeneration: GENERATION,
            session: sessionB,
            extract: () => Effect.die("seeded revision must not extract"),
            decideSupersession: () => Effect.die("seeded enrichment must not decide"),
            classifyFailure: ({ error }) => classifySourceIndexFailure({ error })
          })
        )
        const failedRevision = yield* manifest.readSourceRevisionByCommitId(seeded.commitId)
        const afterSnapshot = yield* readActive(manifest)
        const afterView = yield* manifest.readActiveEntityCanonicalView(SCOPE_INPUT)
        const afterGeneration = yield* manifest.readActiveIndexGeneration(SCOPE_INPUT)
        const recovered = yield* commitWith(seen, [claimB1], sessionB)
        return {
          first,
          failed,
          failedRevision,
          beforeSnapshot,
          beforeView,
          beforeGeneration,
          afterSnapshot,
          afterView,
          afterGeneration,
          recovered
        }
      })
    )
    expect(result.failed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "IngestStageFailed", stage: "CONSOLIDATED", retryable: true }
    })
    expect(result.failedRevision).toMatchObject({
      state: "ENRICHED",
      failureCode: "SnapshotGraphVerifyRejected",
      failureRetryable: true
    })
    expect(result.afterSnapshot?.record.snapshot.id).toBe(result.beforeSnapshot?.record.snapshot.id)
    expect(result.afterView?.id).toBe(result.beforeView?.id)
    expect(result.afterGeneration?.id).toBe(result.beforeGeneration?.id)
    expect(result.recovered.revision.state).toBe("COMMITTED")
    expect(result.recovered.snapshotId).not.toBe(result.first.snapshotId)
    expect(result.recovered.queryVisible).toBe(true)
  })

  it("a non-retryable stage failure blocks later retries", async () => {
    const memory = makeHydraMemory()
    const seen = counters()
    const result = await run(
      memory,
      Effect.gen(function* () {
        yield* seedTo(memory, sessionA, [claimA1], "INDEXED")
        const first = yield* Effect.result(
          commitWith(seen, [claimB1], sessionB, () =>
            Effect.fail(new TestFatalError({ reason: "corrupt" }))
          )
        )
        const second = yield* Effect.result(commitWith(seen, [claimB1], sessionB))
        return { first, second }
      })
    )
    expect(Result.isFailure(result.first)).toBe(true)
    if (Result.isFailure(result.first) && result.first.failure._tag === "IngestStageFailed") {
      expect(result.first.failure.stage).toBe("ENRICHED")
      expect(result.first.failure.retryable).toBe(false)
    } else {
      expect.unreachable("expected IngestStageFailed")
    }
    expect(Result.isFailure(result.second)).toBe(true)
    if (Result.isFailure(result.second)) {
      expect(result.second.failure._tag).toBe("IngestRetryBlocked")
    }
  })

  it("INDEXED-only runs never move the active pointer", async () => {
    const memory = makeHydraMemory()
    const result = await run(
      memory,
      Effect.gen(function* () {
        yield* runTransactionalSourceIndex({
          sourceRevision: sourceRevisionInputForSession(scope, sessionA, EXTRACTION),
          indexGeneration: GENERATION,
          session: sessionA,
          extract: () =>
            Effect.succeed({
              sid: sessionA.sid,
              sessionOrd: sessionA.sessionOrd,
              claims: [claimA1],
              dropped: []
            }),
          classifyFailure: ({ error }) => ({ code: error._tag, retryable: false })
        })
        const manifest = yield* IngestManifest
        const active = yield* readActive(manifest)
        const snapshots = [...memory.vertices.values()].filter((vertex) =>
          vertex.label.startsWith("Snapshot")
        )
        return { active, snapshots }
      })
    )
    expect(result.active).toBeNull()
    expect(result.snapshots).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// commitScope repair path
// ---------------------------------------------------------------------------

describe("commitScope", () => {
  it("converges seeded consolidated revisions and activates the covering snapshot", async () => {
    const memory = makeHydraMemory()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const seededA = yield* seedTo(memory, sessionA, [claimA1], "CONSOLIDATED")
        const seededB = yield* seedTo(memory, sessionB, [claimB1], "CONSOLIDATED")
        const activated = yield* commitScope({
          tenant: scope.tenantId,
          uid: scope.uid,
          indexGeneration: GENERATION
        })
        const manifest = yield* IngestManifest
        const revisionA = yield* manifest.readSourceRevisionByCommitId(seededA.commitId)
        const revisionB = yield* manifest.readSourceRevisionByCommitId(seededB.commitId)
        return { seededA, seededB, activated, revisionA, revisionB }
      })
    )
    expect(result.activated?.record.state).toBe("ACTIVE")
    expect(result.activated?.record.snapshot.sourceCommitIds).toEqual([
      result.seededA.commitId,
      result.seededB.commitId
    ])
    expect(result.revisionA?.state).toBe("COMMITTED")
    expect(result.revisionB?.state).toBe("COMMITTED")
  })

  it("repairs a committed-but-uncovered revision", async () => {
    const memory = makeHydraMemory()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const seeded = yield* seedTo(memory, sessionA, [claimA1], "COMMITTED")
        const manifest = yield* IngestManifest
        const before = yield* readActive(manifest)
        const activated = yield* commitScope({
          tenant: scope.tenantId,
          uid: scope.uid,
          indexGeneration: GENERATION
        })
        return { seeded, before, activated }
      })
    )
    expect(result.before).toBeNull()
    expect(result.activated?.record.snapshot.sourceCommitIds).toEqual([
      result.seeded.commitId
    ])
  })

  it("is a no-op on an idle scope", async () => {
    const memory = makeHydraMemory()
    const result = await run(
      memory,
      commitScope({ tenant: scope.tenantId, uid: scope.uid, indexGeneration: GENERATION })
    )
    expect(result).toBeNull()
    expect(memory.calls.commitWrites).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// commitAndActivateIndexSnapshot — atomic transaction semantics
// ---------------------------------------------------------------------------

describe("commitAndActivateIndexSnapshot", () => {
  it("a stale expected manifest version rolls the whole transaction back", async () => {
    const memory = makeHydraMemory()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const seeded = yield* seedTo(memory, sessionA, [claimA1], "CONSOLIDATED")
        const manifest = yield* IngestManifest
        const verified = yield* registerVerified(manifest, scope, [seeded.commitId])
        const version = yield* manifest.readManifestVersion(SCOPE_INPUT)
        const attempt = yield* Effect.result(
          manifest.commitAndActivateIndexSnapshot({
            ...SCOPE_INPUT,
            snapshotId: verified.snapshot.id,
            expectedManifestVersion: version + 5,
            expectedActiveSnapshotId: null
          })
        )
        const after = yield* manifest.readSourceRevisionByCommitId(seeded.commitId)
        const pointer = yield* readActive(manifest)
        return { attempt, after, pointer }
      })
    )
    expect(Result.isFailure(result.attempt)).toBe(true)
    if (Result.isFailure(result.attempt)) {
      expect(result.attempt.failure._tag).toBe("SnapshotActivationConflict")
    }
    expect(result.after?.state).toBe("CONSOLIDATED")
    expect(result.pointer).toBeNull()
  })

  it("a stale expected active pointer rolls the whole transaction back", async () => {
    const memory = makeHydraMemory()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const seededA = yield* seedTo(memory, sessionA, [claimA1], "CONSOLIDATED")
        const seededB = yield* seedTo(memory, sessionB, [claimB1], "CONSOLIDATED")
        const manifest = yield* IngestManifest
        const verified = yield* registerVerified(manifest, scope, [
          seededA.commitId,
          seededB.commitId
        ])
        const version = yield* manifest.readManifestVersion(SCOPE_INPUT)
        const attempt = yield* Effect.result(
          manifest.commitAndActivateIndexSnapshot({
            ...SCOPE_INPUT,
            snapshotId: verified.snapshot.id,
            expectedManifestVersion: version,
            expectedActiveSnapshotId: "snapshot-that-never-was"
          })
        )
        const revisionA = yield* manifest.readSourceRevisionByCommitId(seededA.commitId)
        const revisionB = yield* manifest.readSourceRevisionByCommitId(seededB.commitId)
        const pointer = yield* readActive(manifest)
        return { attempt, revisionA, revisionB, pointer }
      })
    )
    expect(Result.isFailure(result.attempt)).toBe(true)
    if (Result.isFailure(result.attempt)) {
      expect(result.attempt.failure._tag).toBe("SnapshotActivePointerConflict")
    }
    expect(result.revisionA?.state).toBe("CONSOLIDATED")
    expect(result.revisionB?.state).toBe("CONSOLIDATED")
    expect(result.pointer).toBeNull()
  })

  it("an uncovered committed revision rolls the whole transaction back", async () => {
    const memory = makeHydraMemory()
    const result = await run(
      memory,
      Effect.gen(function* () {
        yield* seedTo(memory, sessionA, [claimA1], "COMMITTED")
        const seededB = yield* seedTo(memory, sessionB, [claimB1], "CONSOLIDATED")
        const manifest = yield* IngestManifest
        const verified = yield* registerVerified(manifest, scope, [seededB.commitId])
        const version = yield* manifest.readManifestVersion(SCOPE_INPUT)
        const attempt = yield* Effect.result(
          manifest.commitAndActivateIndexSnapshot({
            ...SCOPE_INPUT,
            snapshotId: verified.snapshot.id,
            expectedManifestVersion: version,
            expectedActiveSnapshotId: null
          })
        )
        const revision = yield* manifest.readSourceRevisionByCommitId(seededB.commitId)
        const pointer = yield* readActive(manifest)
        return { attempt, revision, pointer }
      })
    )
    expect(Result.isFailure(result.attempt)).toBe(true)
    if (Result.isFailure(result.attempt)) {
      expect(result.attempt.failure._tag).toBe("SnapshotRevisionCoverageMismatch")
    }
    expect(result.revision?.state).toBe("CONSOLIDATED")
    expect(result.pointer).toBeNull()
  })

  it("re-activation against the same pointer is idempotent", async () => {
    const memory = makeHydraMemory()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const seeded = yield* seedTo(memory, sessionA, [claimA1], "CONSOLIDATED")
        const manifest = yield* IngestManifest
        const verified = yield* registerVerified(manifest, scope, [seeded.commitId])
        const version = yield* manifest.readManifestVersion(SCOPE_INPUT)
        const first = yield* manifest.commitAndActivateIndexSnapshot({
          ...SCOPE_INPUT,
          snapshotId: verified.snapshot.id,
          expectedManifestVersion: version,
          expectedActiveSnapshotId: null
        })
        // Stale expectations are ignored once the pointer already names the target.
        const second = yield* manifest.commitAndActivateIndexSnapshot({
          ...SCOPE_INPUT,
          snapshotId: verified.snapshot.id,
          expectedManifestVersion: 0,
          expectedActiveSnapshotId: null
        })
        const revision = yield* manifest.readSourceRevisionByCommitId(seeded.commitId)
        return { first, second, revision }
      })
    )
    expect(result.first.record.state).toBe("ACTIVE")
    expect(result.second.record.snapshot.id).toBe(result.first.record.snapshot.id)
    expect(result.revision?.state).toBe("COMMITTED")
  })

  it("refuses a snapshot that was never verified", async () => {
    const memory = makeHydraMemory()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const seeded = yield* seedTo(memory, sessionA, [claimA1], "CONSOLIDATED")
        const manifest = yield* IngestManifest
        yield* manifest.storeIndexGeneration({ generation: GENERATION })
        const view = Result.getOrThrow(
          createEntityCanonicalView({
            identities: [{ id: "identity-self", canon: "Nate", etype: "self" }],
            equivalences: []
          })
        )
        yield* manifest.storeEntityCanonicalView({ ...SCOPE_INPUT, view })
        const snapshot = Result.getOrThrow(
          createUserIndexSnapshot({
            scope,
            indexGenerationId: GENERATION.id,
            canonicalViewId: view.id,
            sourceCommitIds: [seeded.commitId],
            manifestSchemaVersion: 1
          })
        )
        yield* manifest.registerUserIndexSnapshot({ snapshot })
        const version = yield* manifest.readManifestVersion(SCOPE_INPUT)
        const attempt = yield* Effect.result(
          manifest.commitAndActivateIndexSnapshot({
            ...SCOPE_INPUT,
            snapshotId: snapshot.id,
            expectedManifestVersion: version,
            expectedActiveSnapshotId: null
          })
        )
        const revision = yield* manifest.readSourceRevisionByCommitId(seeded.commitId)
        return { attempt, revision }
      })
    )
    expect(Result.isFailure(result.attempt)).toBe(true)
    if (Result.isFailure(result.attempt)) {
      expect(result.attempt.failure._tag).toBe("InvalidSnapshotTransition")
    }
    expect(result.revision?.state).toBe("CONSOLIDATED")
  })
})

// ---------------------------------------------------------------------------
// supersession decision persistence
// ---------------------------------------------------------------------------

describe("storeSupersessionDecisions", () => {
  it("round-trips links and rejects divergent rewrites", async () => {
    const memory = makeHydraMemory()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const revA = yield* seedTo(memory, sessionA, [claimA1], "INDEXED")
        const revB = yield* seedTo(memory, sessionB, [claimB1], "INDEXED")
        const manifest = yield* IngestManifest
        const link = {
          older: { commitId: revA.commitId, claimDigest: claimDigest(claimA1, sessionA.key) },
          newer: { commitId: revB.commitId, claimDigest: claimDigest(claimB1, sessionB.key) }
        }
        const stored = yield* manifest.storeSupersessionDecisions({
          revision: revB,
          links: [link]
        })
        const again = yield* manifest.storeSupersessionDecisions({
          revision: revB,
          links: [link]
        })
        const read = yield* manifest.readSupersessionDecisions(revB)
        const divergent = yield* Effect.result(
          manifest.storeSupersessionDecisions({
            revision: revB,
            links: [
              {
                older: link.newer,
                newer: {
                  commitId: revA.commitId,
                  claimDigest: claimDigest(claimC1, sessionC.key)
                }
              }
            ]
          })
        )
        return { stored, again, read, divergent }
      })
    )
    expect(result.stored.links).toHaveLength(1)
    expect(result.again).toEqual(result.stored)
    expect(result.read).toEqual(result.stored)
    expect(Result.isFailure(result.divergent)).toBe(true)
    if (Result.isFailure(result.divergent)) {
      expect(result.divergent.failure._tag).toBe("SupersessionDecisionConflict")
    }
  })

  it("rejects endpoints outside the revision scope", async () => {
    const memory = makeHydraMemory()
    const result = await run(
      memory,
      Effect.gen(function* () {
        const revA = yield* seedTo(memory, sessionA, [claimA1], "INDEXED")
        const manifest = yield* IngestManifest
        const foreign = (
          yield* manifest.begin(
            sourceRevisionInputForSession(otherScope, sessionB, EXTRACTION)
          )
        ).revision
        const attempt = yield* Effect.result(
          manifest.storeSupersessionDecisions({
            revision: revA,
            links: [
              {
                older: {
                  commitId: foreign.commitId,
                  claimDigest: claimDigest(claimB1, sessionB.key)
                },
                newer: {
                  commitId: revA.commitId,
                  claimDigest: claimDigest(claimA1, sessionA.key)
                }
              }
            ]
          })
        )
        return { attempt }
      })
    )
    expect(Result.isFailure(result.attempt)).toBe(true)
    if (Result.isFailure(result.attempt)) {
      expect(result.attempt.failure._tag).toBe("InvalidSupersessionDecisions")
    }
  })
})

// ---------------------------------------------------------------------------
// supersession chain building (pure)
// ---------------------------------------------------------------------------

const revisionStub = (session: DatasetSession, commitId: string): SourceRevision => {
  const source = canonicalSessionSource(session)
  return {
    tenant: scope.tenantId,
    uid: scope.uid,
    logicalSessionId: session.key,
    sourceDigest: source.sourceDigest,
    sourceBytes: source.sourceBytes,
    extractionGeneration: EXTRACTION.id,
    sessionOrdinal: session.sessionOrd,
    commitId,
    state: "ENRICHED",
    manifestVersion: 1,
    failureCode: null,
    failureRetryable: null,
    acceptedAtMs: 1700000000000,
    reachedAtMs: {
      RECEIVED: 1700000000000,
      SOURCE_DURABLE: 1700000001000,
      INDEXED: 1700000002000,
      ENRICHED: 1700000003000,
      CONSOLIDATED: null,
      COMMITTED: null
    }
  }
}

const chainSourceFor = (
  revision: SourceRevision,
  session: DatasetSession,
  claims: ReadonlyArray<ExtractedClaim>
): SupersessionChainSource => ({ revision, artifact: artifactFor(revision, session, claims) })

const contestedChain = (): SupersessionChain => {
  const chains = collectSupersessionChains(
    [
      chainSourceFor(revisionStub(sessionA, "commit-a"), sessionA, [claimA1]),
      chainSourceFor(revisionStub(sessionB, "commit-b"), sessionB, [claimB1])
    ],
    "commit-b"
  )
  const found = chains[0]
  if (found === undefined) throw new Error("expected a contested chain")
  return found
}

describe("decideSlotSupersession", () => {
  it("keeps provider failures typed and production-classifies them as retryable", async () => {
    const providerError = new AiError.AiError({
      module: "TestProvider",
      method: "generateObject",
      reason: new AiError.InternalProviderError({ description: "provider unavailable" })
    })
    const llm = behaviorFake<Llm>({
      model: "test",
      cacheDir: "",
      concurrency: 1,
      generateObject: () => Effect.fail(providerError),
      usage: Effect.succeed({ inputTokens: 0, outputTokens: 0, calls: 0, cacheHits: 0 }),
      resetUsage: Effect.void
    })
    const result = await Effect.runPromise(
      decideSlotSupersession(contestedChain()).pipe(
        Effect.provideService(Llm, llm),
        Effect.result
      )
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SupersessionDecisionUnavailable", cause: providerError }
    })
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SupersessionDecisionUnavailable)
      expect(classifySourceIndexFailure({ error: result.failure })).toEqual({
        code: "SupersessionDecisionUnavailable",
        retryable: true
      })
    }
  })
})

describe("collectSupersessionChains", () => {
  it("groups contested slots across canon spellings through match keys", () => {
    const chains = collectSupersessionChains(
      [
        chainSourceFor(revisionStub(sessionA, "commit-a"), sessionA, [claimA1]),
        chainSourceFor(revisionStub(sessionB, "commit-b"), sessionB, [claimB1])
      ],
      "commit-b"
    )
    expect(chains).toHaveLength(1)
    expect(chains[0]?.attr).toBe("residence")
    expect(chains[0]?.claims.map((claim) => claim.commitId)).toEqual([
      "commit-a",
      "commit-b"
    ])
    expect(chains[0]?.claims.map((claim) => claim.claimDigest)).toEqual([
      claimDigest(claimA1, sessionA.key),
      claimDigest(claimB1, sessionB.key)
    ])
  })

  it("only returns chains the target revision introduced", () => {
    const chains = collectSupersessionChains(
      [
        chainSourceFor(revisionStub(sessionA, "commit-a"), sessionA, [claimA1]),
        chainSourceFor(revisionStub(sessionB, "commit-b"), sessionB, [claimB1]),
        chainSourceFor(revisionStub(sessionC, "commit-c"), sessionC, [claimC1])
      ],
      "commit-c"
    )
    expect(chains).toHaveLength(1)
    expect(chains[0]?.claims).toHaveLength(3)
    const single = collectSupersessionChains(
      [chainSourceFor(revisionStub(sessionA, "commit-a"), sessionA, [claimA1])],
      "commit-a"
    )
    expect(single).toEqual([])
  })

  it("keeps uncontested attributes out of the decision set", () => {
    const hobby: ExtractedClaim = {
      ...claimB1,
      slot: { entityCanon: "Nathan", attr: "hobby" }
    }
    const chains = collectSupersessionChains(
      [
        chainSourceFor(revisionStub(sessionA, "commit-a"), sessionA, [claimA1]),
        chainSourceFor(revisionStub(sessionB, "commit-b"), sessionB, [hobby])
      ],
      "commit-b"
    )
    expect(chains).toEqual([])
  })
})

describe("pairsToDecisionLinks", () => {
  it("resolves index pairs into durable claim endpoints", () => {
    const links = pairsToDecisionLinks(contestedChain(), [{ older: 0, newer: 1 }])
    expect(links).toEqual([
      {
        older: { commitId: "commit-a", claimDigest: claimDigest(claimA1, sessionA.key) },
        newer: { commitId: "commit-b", claimDigest: claimDigest(claimB1, sessionB.key) }
      }
    ])
  })

  it("drops backward, self, and out-of-range pairs", () => {
    const links = pairsToDecisionLinks(contestedChain(), [
      { older: 1, newer: 0 },
      { older: 0, newer: 0 },
      { older: 0, newer: 7 },
      { older: -1, newer: 1 }
    ])
    expect(links).toEqual([])
  })
})

describe("matchKeyEquivalences", () => {
  it("links identities sharing a match key deterministically", () => {
    const identities = new Map<string, ExtractedEntity>()
    for (const entity of [nate, nathan]) {
      identities.set(`${entity.etype}:${entity.canon.toLowerCase()}`, entity)
    }
    const edges = matchKeyEquivalences(identities)
    expect(edges).toHaveLength(1)
    const [edge] = edges
    expect(edge !== undefined && edge.leftIdentityId < edge.rightIdentityId).toBe(true)
  })
})
