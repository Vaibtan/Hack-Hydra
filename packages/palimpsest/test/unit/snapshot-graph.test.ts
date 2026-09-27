import type { DatasetSession } from "@palimpsest/dataset"
import { HydraMemory as HydraMemoryService, vertexId } from "@palimpsest/hydra"
import { Effect, Layer, Result } from "effect"
import { describe, expect, it } from "vitest"
import { makeHydraMemory, relIdentity, writeSourcePlane, type HydraMemory } from "../HydraMemory.js"
import { claimDigest } from "../../src/ClaimGraph.js"
import {
  createEntityCanonicalView,
  type EntityCanonicalView,
  type EntityEquivalence
} from "../../src/EntityCanonicalView.js"
import { createExtractionArtifact } from "../../src/ExtractionArtifact.js"
import type { ExtractedClaim, ExtractedEntity } from "../../src/Extract.js"
import { indexEntityIdentityId } from "../../src/IndexGraph.js"
import { createIndexGeneration } from "../../src/IndexGeneration.js"
import {
  createUserIndexSnapshot,
  IngestManifest,
  IngestManifestLayerMemory,
  makeIngestManifestTestLayer,
  type IngestManifestService,
  type SourceRevision
} from "../../src/IngestManifest.js"
import { parseMemoryScope, scopePrefix, type MemoryScope } from "../../src/MemoryScope.js"
import {
  canonicalSessionSource,
  createExtractionGeneration,
  sourceRevisionInputForSession
} from "../../src/SourceIdentity.js"
import { sourceTurnKey } from "../../src/SourceTranscript.js"
import { stems } from "../../src/Tokenize.js"
import {
  planSnapshotGraph,
  SnapshotGraph,
  snapshotClaimKey,
  snapshotEvidenceKey,
  snapshotEntityKey,
  snapshotRootKey,
  snapshotSlotKey,
  snapshotTokenKey,
  type SnapshotCausalLink,
  type SnapshotGraphSource,
  type SnapshotSourceSession
} from "../../src/SnapshotGraph.js"
import type { UserIndexSnapshot } from "../../src/UserIndexSnapshot.js"

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
    { turnIdx: 0, role: "user", text: "I live in Mumbai with my hamster Suki.", hasAnswer: false },
    { turnIdx: 1, role: "assistant", text: "Mumbai is huge.", hasAnswer: false }
  ]
}
const sessionB: DatasetSession = {
  sid: "s-b",
  key: "session-b",
  sessionOrd: 2,
  date: { raw: "2026-08-25", dateInt: 20260825, ts: 1_756_089_600_000 },
  turns: [{ turnIdx: 0, role: "user", text: "I moved to Berlin.", hasAnswer: false }]
}
const sourceA = canonicalSessionSource(sessionA)
const sourceB = canonicalSessionSource(sessionB)

const nate: ExtractedEntity = { canon: "Nate", etype: "self", aliases: ["I"] }
const suki: ExtractedEntity = { canon: "Suki", etype: "pet", aliases: ["the hamster"] }
const nathan: ExtractedEntity = { canon: "Nathan", etype: "self", aliases: ["Nate"] }

const claimA1: ExtractedClaim = {
  text: "Nate lives in Mumbai.",
  speaker: "user",
  ctype: "fact",
  entities: [nate, suki],
  slot: { entityCanon: "Nate", attr: "residence" },
  tEvent: 20260820,
  tPrec: "day",
  span: { turnIdx: 0, cs: 0, ce: 20 },
  keywords: ["Mumbai"],
  located: "exact"
}
const claimA2: ExtractedClaim = {
  text: "The hamster is called Suki.",
  speaker: "user",
  ctype: "fact",
  entities: [suki],
  slot: null,
  tEvent: 0,
  tPrec: "none",
  span: { turnIdx: 1, cs: 0, ce: 15 },
  keywords: ["Suki", "hamster"],
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
  span: { turnIdx: 0, cs: 0, ce: 20 },
  keywords: ["Berlin"],
  located: "exact"
}

const revisionFor = (
  session: DatasetSession,
  source: ReturnType<typeof canonicalSessionSource>,
  commitId: string,
  state: SourceRevision["state"] = "COMMITTED"
): SourceRevision => {
  const order = ["RECEIVED", "SOURCE_DURABLE", "INDEXED", "ENRICHED", "CONSOLIDATED", "COMMITTED"]
  const at = (stage: SourceRevision["state"]): number | null =>
    order.indexOf(stage) <= order.indexOf(state) ? 1700000000000 : null
  return {
    tenant: scope.tenantId,
    uid: scope.uid,
    logicalSessionId: session.key,
    sourceDigest: source.sourceDigest,
    sourceBytes: source.sourceBytes,
    extractionGeneration: EXTRACTION.id,
    sessionOrdinal: session.sessionOrd,
    commitId,
    state,
    manifestVersion: 1,
    failureCode: null,
    failureRetryable: null,
    acceptedAtMs: 1700000000000,
    reachedAtMs: {
      RECEIVED: at("RECEIVED"),
      SOURCE_DURABLE: at("SOURCE_DURABLE"),
      INDEXED: at("INDEXED"),
      ENRICHED: at("ENRICHED"),
      CONSOLIDATED: at("CONSOLIDATED"),
      COMMITTED: at("COMMITTED")
    }
  }
}

const sessionFixture = (revision: SourceRevision, session: DatasetSession): SnapshotSourceSession => ({
  sid: session.sid,
  sessionOrd: revision.sessionOrdinal,
  dateInt: session.date.dateInt,
  turns: session.turns.length
})

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

const sourceFixture = (
  revision: SourceRevision,
  session: DatasetSession,
  claims: ReadonlyArray<ExtractedClaim>
): SnapshotGraphSource => ({
  revision,
  artifact: artifactFor(revision, session, claims),
  session: sessionFixture(revision, session)
})

/** Mirrors the planner's entity collection: claim entities plus slot-implied canons. */
const identityRefsFor = (claims: ReadonlyArray<ExtractedClaim>) => {
  const byIdentity = new Map<string, ExtractedEntity>()
  const canons = new Map<string, ExtractedEntity>()
  for (const claim of claims) {
    for (const entity of claim.entities) {
      byIdentity.set(indexEntityIdentityId(entity), entity)
      if (!canons.has(entity.canon)) canons.set(entity.canon, entity)
    }
  }
  for (const claim of claims) {
    if (claim.slot !== null) {
      const entity =
        canons.get(claim.slot.entityCanon) ??
        ({ canon: claim.slot.entityCanon, etype: "topic", aliases: [] } as const)
      byIdentity.set(indexEntityIdentityId(entity), entity)
    }
  }
  return [...byIdentity.entries()].map(([id, entity]) => ({
    id,
    canon: entity.canon,
    etype: entity.etype
  }))
}

const viewFor = (
  claims: ReadonlyArray<ExtractedClaim>,
  equivalences: ReadonlyArray<EntityEquivalence> = []
): EntityCanonicalView =>
  Result.getOrThrow(
    createEntityCanonicalView({ identities: identityRefsFor(claims), equivalences })
  )

const snapshotFor = (
  snapshotScope: MemoryScope,
  view: EntityCanonicalView,
  commitIds: ReadonlyArray<string>
): UserIndexSnapshot =>
  Result.getOrThrow(
    createUserIndexSnapshot({
      scope: snapshotScope,
      indexGenerationId: GENERATION.id,
      canonicalViewId: view.id,
      sourceCommitIds: commitIds,
      manifestSchemaVersion: 1
    })
  )

const commitRevision = (
  manifest: IngestManifestService,
  fake: HydraMemory,
  session: DatasetSession,
  claims: ReadonlyArray<ExtractedClaim>
) =>
  Effect.gen(function* () {
    let revision = (
      yield* manifest.begin(sourceRevisionInputForSession(scope, session, EXTRACTION))
    ).revision
    revision = yield* manifest.advance({ revision, from: "RECEIVED", to: "SOURCE_DURABLE" })
    writeSourcePlane(fake, revision, session)
    revision = yield* manifest.advance({ revision, from: "SOURCE_DURABLE", to: "INDEXED" })
    yield* manifest.storeExtractionArtifact({
      revision,
      artifact: artifactFor(revision, session, claims)
    })
    for (const [from, to] of [
      ["INDEXED", "ENRICHED"],
      ["ENRICHED", "CONSOLIDATED"],
      ["CONSOLIDATED", "COMMITTED"]
    ] as const) {
      revision = yield* manifest.advance({ revision, from, to })
    }
    return revision
  })

const registerSnapshot = (
  manifest: IngestManifestService,
  snapshot: UserIndexSnapshot,
  view: EntityCanonicalView
) =>
  Effect.gen(function* () {
    yield* manifest.storeIndexGeneration({ generation: GENERATION })
    yield* manifest.storeEntityCanonicalView({ tenant: scope.tenantId, uid: scope.uid, view })
    return yield* manifest.registerUserIndexSnapshot({ snapshot })
  })

const makeLayer = (fake: HydraMemory, manifestLayer = IngestManifestLayerMemory) => {
  const deps = Layer.mergeAll(manifestLayer, Layer.succeed(HydraMemoryService, fake.client))
  return Layer.mergeAll(deps, Layer.provide(SnapshotGraph.layer, deps))
}

const run = <A, E>(
  fake: HydraMemory,
  effect: Effect.Effect<A, E, IngestManifest | SnapshotGraph>,
  manifestLayer = IngestManifestLayerMemory
) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(makeLayer(fake, manifestLayer)))))

// ---------------------------------------------------------------------------
// planSnapshotGraph
// ---------------------------------------------------------------------------

const revisionA = revisionFor(sessionA, sourceA, "commit-a")
const revisionB = revisionFor(sessionB, sourceB, "commit-b")
const allClaims = [claimA1, claimA2, claimB1]
const nateNathanView = viewFor(allClaims, [
  { leftIdentityId: indexEntityIdentityId(nate), rightIdentityId: indexEntityIdentityId(nathan) }
])
const snapshotAB = snapshotFor(scope, nateNathanView, [revisionA.commitId, revisionB.commitId])

const planInput = (
  view: EntityCanonicalView,
  commitIds: ReadonlyArray<string>,
  causalLinks: ReadonlyArray<SnapshotCausalLink> = []
) => ({
  snapshot: snapshotFor(scope, view, commitIds),
  generation: GENERATION,
  view,
  sources: [
    sourceFixture(revisionA, sessionA, [claimA1, claimA2]),
    sourceFixture(revisionB, sessionB, [claimB1])
  ],
  causalLinks
})

describe("planSnapshotGraph", () => {
  it("produces a deterministic, source-order-independent digest", () => {
    const first = planSnapshotGraph(planInput(nateNathanView, [revisionA.commitId, revisionB.commitId]))
    const reversed = planSnapshotGraph({
      ...planInput(nateNathanView, [revisionA.commitId, revisionB.commitId]),
      sources: [
        sourceFixture(revisionB, sessionB, [claimB1]),
        sourceFixture(revisionA, sessionA, [claimA1, claimA2])
      ]
    })

    expect(first._tag).toBe("Success")
    expect(reversed._tag).toBe("Success")
    if (first._tag === "Failure" || reversed._tag === "Failure") return
    expect(reversed.success.digest).toBe(first.success.digest)
    expect(reversed.success.members).toEqual(first.success.members)
    expect(reversed.success.relations).toEqual(first.success.relations)
  })

  it("scopes every vertex and relationship to tenant, uid and snapshot", () => {
    const same = planSnapshotGraph(planInput(nateNathanView, [revisionA.commitId, revisionB.commitId]))
    if (same._tag === "Failure") return expect.unreachable(same.failure.message)
    const otherRevision = (revision: SourceRevision): SourceRevision => ({
      ...revision,
      tenant: otherScope.tenantId,
      uid: otherScope.uid
    })
    const otherUidSnapshot = snapshotFor(otherScope, nateNathanView, [
      revisionA.commitId,
      revisionB.commitId
    ])
    const other = planSnapshotGraph({
      snapshot: otherUidSnapshot,
      generation: GENERATION,
      view: nateNathanView,
      sources: [
        {
          ...sourceFixture(revisionA, sessionA, [claimA1, claimA2]),
          revision: otherRevision(revisionA)
        },
        { ...sourceFixture(revisionB, sessionB, [claimB1]), revision: otherRevision(revisionB) }
      ],
      causalLinks: []
    })
    if (other._tag === "Failure") return expect.unreachable(other.failure.message)

    const prefix = `${scopePrefix(scope)}|snap|${snapshotAB.id}`
    for (const vertex of [same.success.root, ...same.success.members]) {
      expect(vertex.key.startsWith(prefix)).toBe(true)
      expect(vertex.properties["snapshot_id"]).toBe(snapshotAB.id)
      expect(vertex.properties["tenant"]).toBe(scope.tenantId)
      expect(vertex.properties["uid"]).toBe(scope.uid)
    }
    for (const relation of same.success.relations) {
      expect(relation.properties["snapshot_id"]).toBe(snapshotAB.id)
      expect(relation.srcKey.startsWith(prefix)).toBe(true)
      expect(relation.dstKey.startsWith(prefix)).toBe(true)
    }

    const keys = [same.success.root.key, ...same.success.members.map((member) => member.key)]
    const otherKeys = [other.success.root.key, ...other.success.members.map((member) => member.key)]
    for (const key of keys) expect(otherKeys).not.toContain(key)
    expect(same.success.digest).not.toBe(other.success.digest)
  })

  it("collapses equal claims inside a revision but keeps revisions distinct", () => {
    const dupe = { ...claimA1 }
    const source = sourceFixture(revisionA, sessionA, [claimA1, dupe])
    const planned = planSnapshotGraph({
      snapshot: snapshotFor(scope, viewFor([claimA1]), [revisionA.commitId]),
      generation: GENERATION,
      view: viewFor([claimA1]),
      sources: [source],
      causalLinks: []
    })
    if (planned._tag === "Failure") return expect.unreachable(planned.failure.message)

    const claims = planned.success.members.filter((member) => member.label === "SnapshotClaim")
    expect(claims).toHaveLength(1)
    const revision = planned.success.members.find((member) => member.label === "SnapshotRevision")
    expect(revision?.properties["n_claims"]).toBe(1)
  })

  it("resolves entities through the pinned canonical view and aggregates slots across revisions", () => {
    const planned = planSnapshotGraph(planInput(nateNathanView, [revisionA.commitId, revisionB.commitId]))
    if (planned._tag === "Failure") return expect.unreachable(planned.failure.message)

    const entities = planned.success.members.filter((member) => member.label === "SnapshotEntity")
    expect(entities).toHaveLength(2)
    // The canonical member is the smallest canon in the equivalence class.
    const canonicalNateId = indexEntityIdentityId(nate)
    const canonicalNate = entities.find(
      (entity) => entity.properties["canonical_identity_id"] === canonicalNateId
    )
    expect(canonicalNate?.key).toBe(snapshotEntityKey(scope, snapshotAB.id, canonicalNateId))
    expect(canonicalNate?.properties["n_member_identities"]).toBe(2)

    const claimAKey = snapshotClaimKey(
      scope,
      snapshotAB.id,
      revisionA.commitId,
      claimDigest(claimA1, sessionA.key)
    )
    const claimBKey = snapshotClaimKey(
      scope,
      snapshotAB.id,
      revisionB.commitId,
      claimDigest(claimB1, sessionB.key)
    )
    const mentions = planned.success.relations.filter(
      (relation) => relation.type === "SNAPSHOT_MENTIONS" && relation.srcKey === canonicalNate?.key
    )
    expect(mentions.map((relation) => relation.dstKey).sort()).toEqual([claimAKey, claimBKey].sort())

    const slots = planned.success.members.filter((member) => member.label === "SnapshotSlot")
    const residence = slots.find((slot) => slot.properties["attr"] === "residence")
    expect(residence?.key).toBe(
      snapshotSlotKey(scope, snapshotAB.id, canonicalNateId, "residence")
    )
    expect(residence?.properties["n_claims"]).toBe(2)
    const fills = planned.success.relations.filter(
      (relation) => relation.type === "SNAPSHOT_FILLS" && relation.dstKey === residence?.key
    )
    expect(fills.map((relation) => relation.srcKey).sort()).toEqual([claimAKey, claimBKey].sort())
  })

  it("links every claim to its revision and snapshot-scoped evidence locator", () => {
    const planned = planSnapshotGraph(planInput(nateNathanView, [revisionA.commitId, revisionB.commitId]))
    if (planned._tag === "Failure") return expect.unreachable(planned.failure.message)

    const claimAKey = snapshotClaimKey(
      scope,
      snapshotAB.id,
      revisionA.commitId,
      claimDigest(claimA1, sessionA.key)
    )
    expect(planned.success.relations).toContainEqual(
      expect.objectContaining({
        type: "SNAPSHOT_DERIVED_FROM",
        srcKey: claimAKey,
        dstKey: `${snapshotRootKey(scope, snapshotAB.id)}|rev|${revisionA.commitId}`
      })
    )
    expect(planned.success.relations).toContainEqual(
      expect.objectContaining({
        type: "SNAPSHOT_EVIDENCE",
        srcKey: claimAKey,
        dstLabel: "SnapshotEvidence",
        dstKey: snapshotEvidenceKey(scope, snapshotAB.id, revisionA.commitId, 0),
        properties: expect.objectContaining({ cs: 0, ce: 20 })
      })
    )
    const evidence = planned.success.members.find(
      (member) => member.key === snapshotEvidenceKey(scope, snapshotAB.id, revisionA.commitId, 0)
    )
    expect(evidence?.properties).toMatchObject({
      commit_id: revisionA.commitId,
      turn_idx: 0,
      source_turn_key: sourceTurnKey(scope, sessionA.key, sourceA.sourceDigest, 0)
    })
    const claim = planned.success.members.find((member) => member.key === claimAKey)
    expect(claim?.properties).toMatchObject({
      commit_id: revisionA.commitId,
      claim_digest: claimDigest(claimA1, sessionA.key),
      accepted_at_ms: revisionA.acceptedAtMs,
      session_ord: 1,
      session_date: 20260820,
      turn_idx: 0,
      located: "exact"
    })
  })

  it("bounds tokens by the shared tokenizer contract and names canonical entities", () => {
    const planned = planSnapshotGraph(planInput(nateNathanView, [revisionA.commitId, revisionB.commitId]))
    if (planned._tag === "Failure") return expect.unreachable(planned.failure.message)

    const tokens = planned.success.members.filter((member) => member.label === "SnapshotToken")
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) {
      const df = token.properties["df"]
      const hits = planned.success.relations.filter(
        (relation) => relation.type === "SNAPSHOT_HITS" && relation.srcKey === token.key
      )
      expect(hits.length).toBe(df)
      expect(token.key).toBe(snapshotTokenKey(scope, snapshotAB.id, String(token.properties["stem"])))
    }
    // A stem of the canonical entity's member name NAMES the entity vertex.
    const nateStem = stems("Nate")[0]
    expect(nateStem).toBeDefined()
    const nateToken = snapshotTokenKey(scope, snapshotAB.id, nateStem ?? "")
    const canonicalNateId = indexEntityIdentityId(nate)
    const nateEntity = snapshotEntityKey(scope, snapshotAB.id, canonicalNateId)
    const names = planned.success.relations.filter((relation) => relation.type === "SNAPSHOT_NAMES")
    expect(
      names.some((relation) => relation.srcKey === nateToken && relation.dstKey === nateEntity)
    ).toBe(true)
  })

  it("folds caller-decided supersession links with the newer session ordinal", () => {
    const link: SnapshotCausalLink = {
      older: { commitId: revisionA.commitId, claimDigest: claimDigest(claimA1, sessionA.key) },
      newer: { commitId: revisionB.commitId, claimDigest: claimDigest(claimB1, sessionB.key) }
    }
    const planned = planSnapshotGraph(
      planInput(nateNathanView, [revisionA.commitId, revisionB.commitId], [link, link])
    )
    if (planned._tag === "Failure") return expect.unreachable(planned.failure.message)

    const links = planned.success.relations.filter(
      (relation) => relation.type === "SNAPSHOT_SUPERSEDED_BY"
    )
    expect(links).toHaveLength(1)
    expect(links[0]?.properties["at_session"]).toBe(2)
  })

  it("rejects revisions that are not committed, missing, unlisted or duplicated", () => {
    const input = planInput(nateNathanView, [revisionA.commitId, revisionB.commitId])

    const uncommitted = planSnapshotGraph({
      ...input,
      sources: [
        { ...input.sources[0]!, revision: { ...revisionA, state: "INDEXED" } },
        input.sources[1]!
      ]
    })
    expect(uncommitted).toMatchObject({ _tag: "Failure", failure: { reason: "revisionNotReady" } })

    const missing = planSnapshotGraph({
      ...input,
      sources: [input.sources[0]!]
    })
    expect(missing).toMatchObject({ _tag: "Failure", failure: { reason: "missingSourceRevision" } })

    const unlisted = planSnapshotGraph({
      ...input,
      sources: [
        ...input.sources,
        sourceFixture(
          { ...revisionFor(sessionA, sourceA, "commit-x"), sessionOrdinal: 3 },
          sessionA,
          []
        )
      ]
    })
    expect(unlisted).toMatchObject({ _tag: "Failure", failure: { reason: "unlistedSourceRevision" } })

    const duplicated = planSnapshotGraph({
      ...input,
      sources: [...input.sources, input.sources[0]!]
    })
    expect(duplicated).toMatchObject({
      _tag: "Failure",
      failure: { reason: "duplicateSourceRevision" }
    })
  })

  it("rejects entities outside the canonical view and invalid evidence spans", () => {
    // The view covers claimB1's identities only; claimA1's entities are absent.
    const partialView = viewFor([claimB1])
    const uncovered = planSnapshotGraph({
      snapshot: snapshotFor(scope, partialView, [revisionA.commitId, revisionB.commitId]),
      generation: GENERATION,
      view: partialView,
      sources: [
        sourceFixture(revisionA, sessionA, [claimA1, claimA2]),
        sourceFixture(revisionB, sessionB, [claimB1])
      ],
      causalLinks: []
    })
    expect(uncovered).toMatchObject({
      _tag: "Failure",
      failure: { reason: "entityNotInCanonicalView" }
    })

    const badTurn = planSnapshotGraph({
      ...planInput(nateNathanView, [revisionA.commitId]),
      sources: [sourceFixture(revisionA, sessionA, [{ ...claimA1, span: { ...claimA1.span, turnIdx: 9 } }])]
    })
    expect(badTurn).toMatchObject({ _tag: "Failure", failure: { reason: "unknownTurn" } })

    const badSpan = planSnapshotGraph({
      ...planInput(nateNathanView, [revisionA.commitId]),
      sources: [
        sourceFixture(revisionA, sessionA, [
          { ...claimA1, span: { ...claimA1.span, cs: 20, ce: 10 } }
        ])
      ]
    })
    expect(badSpan).toMatchObject({ _tag: "Failure", failure: { reason: "invalidSpan" } })
  })

  it("rejects causal links whose endpoints are not in the snapshot or go backwards", () => {
    const unknown = planSnapshotGraph(
      planInput(nateNathanView, [revisionA.commitId, revisionB.commitId], [
        {
          older: { commitId: revisionA.commitId, claimDigest: "0".repeat(40) },
          newer: { commitId: revisionB.commitId, claimDigest: claimDigest(claimB1, sessionB.key) }
        }
      ])
    )
    expect(unknown).toMatchObject({
      _tag: "Failure",
      failure: { reason: "unknownCausalEndpoint" }
    })

    const backwards = planSnapshotGraph(
      planInput(nateNathanView, [revisionA.commitId, revisionB.commitId], [
        {
          older: { commitId: revisionB.commitId, claimDigest: claimDigest(claimB1, sessionB.key) },
          newer: { commitId: revisionA.commitId, claimDigest: claimDigest(claimA1, sessionA.key) }
        }
      ])
    )
    expect(backwards).toMatchObject({ _tag: "Failure", failure: { reason: "invalidCausalLink" } })
  })
})

// ---------------------------------------------------------------------------
// SnapshotGraph.build — service behavior over the in-memory Hydra double and
// the real manifest layer.
// ---------------------------------------------------------------------------

describe("SnapshotGraph.build", () => {
  const seeded = (fake: HydraMemory) =>
    Effect.gen(function* () {
      const manifest = yield* IngestManifest
      const revA = yield* commitRevision(manifest, fake, sessionA, [claimA1, claimA2])
      const revB = yield* commitRevision(manifest, fake, sessionB, [claimB1])
      const snapshot = snapshotFor(scope, nateNathanView, [revA.commitId, revB.commitId])
      const record = yield* registerSnapshot(manifest, snapshot, nateNathanView)
      return { manifest, revA, revB, record }
    })

  it("writes the graph, verifies read-back, and marks the snapshot VERIFIED", async () => {
    const fake = makeHydraMemory()
    const result = await run(
      fake,
      Effect.gen(function* () {
        const { manifest, record } = yield* seeded(fake)
        const graph = yield* SnapshotGraph
        const built = yield* graph.build({ snapshotId: record.snapshot.id, causalLinks: [] })
        const active = yield* manifest.readActiveIndexSnapshot({
          tenant: scope.tenantId,
          uid: scope.uid
        })
        return { built, active }
      })
    )

    expect(result.built.state).toBe("VERIFIED")
    expect(result.built.verificationDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.built.graphRoots).toEqual([
      snapshotRootKey(scope, result.built.snapshot.id)
    ])
    expect(result.built.counts).toMatchObject({ sourceRevisions: 2 })
    // S03 never touches the active pointer.
    expect(result.active).toBeNull()

    const prefix = `${scopePrefix(scope)}|snap|${result.built.snapshot.id}`
    for (const [key, vertex] of fake.vertices) {
      if (!vertex.label.startsWith("Snapshot")) continue
      expect(key.startsWith(prefix)).toBe(true)
      expect(vertex.properties["snapshot_id"]).toBe(result.built.snapshot.id)
    }
    expect(
      [...fake.vertices.values()].filter((vertex) => vertex.label === "SnapshotClaim")
    ).toHaveLength(3)
    const revisions = [...fake.vertices.values()].filter(
      (vertex) => vertex.label === "SnapshotRevision"
    )
    expect(revisions.map((vertex) => vertex.properties["commit_id"]).sort()).toEqual(
      [...result.built.snapshot.sourceCommitIds].sort()
    )
    expect(
      revisions.every((vertex) => Number(vertex.properties["accepted_at_ms"] ?? 0) > 0)
    ).toBe(true)
    const evidence = [...fake.relations.values()].filter(
      (relation) => relation.type === "SNAPSHOT_EVIDENCE"
    )
    expect(evidence).toHaveLength(3)
    for (const relation of evidence) {
      expect(fake.vertices.get(relation.dstKey)?.label).toBe("SnapshotEvidence")
      expect(String(fake.vertices.get(relation.dstKey)?.properties["source_turn_key"])).toContain(
        `${scopePrefix(scope)}|srcsess|`
      )
    }
  })

  it("rebuilds an identical snapshot idempotently without rewriting", async () => {
    const fake = makeHydraMemory()
    const result = await run(
      fake,
      Effect.gen(function* () {
        const { record } = yield* seeded(fake)
        const graph = yield* SnapshotGraph
        const first = yield* graph.build({ snapshotId: record.snapshot.id, causalLinks: [] })
        const callsAfterFirst = { ...fake.calls }
        const second = yield* graph.build({ snapshotId: record.snapshot.id, causalLinks: [] })
        return { first, second, callsAfterFirst, callsAfterSecond: { ...fake.calls } }
      })
    )

    expect(result.first.state).toBe("VERIFIED")
    expect(result.second).toEqual(result.first)
    expect(result.callsAfterSecond).toEqual(result.callsAfterFirst)
  })

  it("detects a missing member on read-back and leaves the snapshot BUILDING", async () => {
    const fake = makeHydraMemory()
    const outcome = await run(
      fake,
      Effect.gen(function* () {
        const { manifest, revA, record } = yield* seeded(fake)
        const graph = yield* SnapshotGraph
        const droppedKey = snapshotClaimKey(
          scope,
          record.snapshot.id,
          revA.commitId,
          claimDigest(claimA1, sessionA.key)
        )
        let tampered = false
        fake.onRead = () => {
          if (tampered) return
          tampered = true
          fake.vertices.delete(droppedKey)
        }
        const built = yield* graph
          .build({ snapshotId: record.snapshot.id, causalLinks: [] })
          .pipe(Effect.result)
        const stored = yield* manifest.readUserIndexSnapshot(record.snapshot.id)
        const active = yield* manifest.readActiveIndexSnapshot({
          tenant: scope.tenantId,
          uid: scope.uid
        })
        return { built, stored, active }
      })
    )

    expect(outcome.built).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphVerifyRejected" }
    })
    expect(outcome.stored?.state).toBe("BUILDING")
    expect(outcome.active).toBeNull()
  })

  it("detects a missing relationship on read-back", async () => {
    const fake = makeHydraMemory()
    const outcome = await run(
      fake,
      Effect.gen(function* () {
        const { record } = yield* seeded(fake)
        const graph = yield* SnapshotGraph
        let tampered = false
        fake.onRead = () => {
          if (tampered) return
          tampered = true
          const fills = [...fake.relations.keys()].find((id) => id.includes("SNAPSHOT_FILLS"))
          if (fills !== undefined) fake.relations.delete(fills)
        }
        return yield* graph
          .build({ snapshotId: record.snapshot.id, causalLinks: [] })
          .pipe(Effect.result)
      })
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphVerifyRejected", reason: "missingRelationship" }
    })
  })

  it("detects an unexpected member reachable from the root", async () => {
    const fake = makeHydraMemory()
    const outcome = await run(
      fake,
      Effect.gen(function* () {
        const { record } = yield* seeded(fake)
        const graph = yield* SnapshotGraph
        const ghostKey = `${snapshotRootKey(scope, record.snapshot.id)}|token|5:ghost`
        fake.merge("SnapshotToken", ghostKey, {
          snapshot_id: record.snapshot.id,
          snapshot_token: ghostKey,
          tenant: scope.tenantId,
          uid: scope.uid,
          stem: "ghost",
          df: 1
        })
        fake.relations.set(relIdentity(snapshotRootKey(scope, record.snapshot.id), "SNAPSHOT_HAS_TOKEN", ghostKey), {
          type: "SNAPSHOT_HAS_TOKEN",
          srcKey: snapshotRootKey(scope, record.snapshot.id),
          dstKey: ghostKey,
          properties: { snapshot_id: record.snapshot.id, tenant: scope.tenantId, uid: scope.uid }
        })
        return yield* graph
          .build({ snapshotId: record.snapshot.id, causalLinks: [] })
          .pipe(Effect.result)
      })
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphVerifyRejected", reason: "unexpectedMember" }
    })
  })

  it("detects an unexpected relationship incoming to a member", async () => {
    const fake = makeHydraMemory()
    const outcome = await run(
      fake,
      Effect.gen(function* () {
        const { record, revA } = yield* seeded(fake)
        const graph = yield* SnapshotGraph
        const claimKey = snapshotClaimKey(
          scope,
          record.snapshot.id,
          revA.commitId,
          claimDigest(claimA1, sessionA.key)
        )
        const foreignKey = `${snapshotRootKey(scope, record.snapshot.id)}|entity|foreign`
        fake.merge("SnapshotEntity", foreignKey, {
          snapshot_id: record.snapshot.id,
          snapshot_entity: foreignKey,
          tenant: scope.tenantId,
          uid: scope.uid,
          canonical_identity_id: "foreign",
          canon: "Ghost",
          etype: "person",
          aliases: "",
          n_member_identities: 1
        })
        fake.relations.set(relIdentity(foreignKey, "SNAPSHOT_MENTIONS", claimKey), {
          type: "SNAPSHOT_MENTIONS",
          srcKey: foreignKey,
          dstKey: claimKey,
          properties: { snapshot_id: record.snapshot.id, tenant: scope.tenantId, uid: scope.uid }
        })
        return yield* graph
          .build({ snapshotId: record.snapshot.id, causalLinks: [] })
          .pipe(Effect.result)
      })
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphVerifyRejected", reason: "unexpectedRelationship" }
    })
  })

  it("rejects a snapshot whose listed revision has not completed enrichment", async () => {
    const fake = makeHydraMemory()
    const outcome = await run(
      fake,
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        let revision = (
          yield* manifest.begin(sourceRevisionInputForSession(scope, sessionA, EXTRACTION))
        ).revision
        revision = yield* manifest.advance({ revision, from: "RECEIVED", to: "SOURCE_DURABLE" })
        writeSourcePlane(fake, revision, sessionA)
        revision = yield* manifest.advance({ revision, from: "SOURCE_DURABLE", to: "INDEXED" })
        yield* manifest.storeExtractionArtifact({
          revision,
          artifact: artifactFor(revision, sessionA, [claimA1])
        })
        const snapshot = snapshotFor(scope, nateNathanView, [revision.commitId])
        const record = yield* registerSnapshot(manifest, snapshot, nateNathanView)
        const graph = yield* SnapshotGraph
        return yield* graph
          .build({ snapshotId: record.snapshot.id, causalLinks: [] })
          .pipe(Effect.result)
      })
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphPlanRejected", reason: "revisionNotReady" }
    })
  })

  it("rejects a FAILED snapshot until it is re-registered", async () => {
    const fake = makeHydraMemory()
    const result = await run(
      fake,
      Effect.gen(function* () {
        const { manifest, record } = yield* seeded(fake)
        const graph = yield* SnapshotGraph
        yield* manifest.failUserIndexSnapshot({ snapshotId: record.snapshot.id, code: "verify-mismatch" })
        const rejected = yield* graph
          .build({ snapshotId: record.snapshot.id, causalLinks: [] })
          .pipe(Effect.result)
        const reopened = yield* manifest.registerUserIndexSnapshot({ snapshot: record.snapshot })
        const rebuilt = yield* graph.build({ snapshotId: record.snapshot.id, causalLinks: [] })
        return { rejected, reopened, rebuilt }
      })
    )

    expect(result.rejected).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphBuildRejected", reason: "failedState" }
    })
    expect(result.reopened.state).toBe("BUILDING")
    expect(result.rebuilt.state).toBe("VERIFIED")
  })

  it("never lets one snapshot's namespace reach another's", async () => {
    const fake = makeHydraMemory()
    const result = await run(
      fake,
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const revA = yield* commitRevision(manifest, fake, sessionA, [claimA1, claimA2])
        const revB = yield* commitRevision(manifest, fake, sessionB, [claimB1])
        const flatView = viewFor(allClaims)
        const snapshotA = snapshotFor(scope, nateNathanView, [revA.commitId, revB.commitId])
        const snapshotB = snapshotFor(scope, flatView, [revA.commitId, revB.commitId])
        const recordA = yield* registerSnapshot(manifest, snapshotA, nateNathanView)
        const recordB = yield* registerSnapshot(manifest, snapshotB, flatView)
        const graph = yield* SnapshotGraph
        const builtA = yield* graph.build({ snapshotId: recordA.snapshot.id, causalLinks: [] })
        const builtB = yield* graph.build({ snapshotId: recordB.snapshot.id, causalLinks: [] })
        return { builtA, builtB }
      })
    )

    expect(result.builtA.state).toBe("VERIFIED")
    expect(result.builtB.state).toBe("VERIFIED")
    expect(result.builtA.snapshot.id).not.toBe(result.builtB.snapshot.id)
    expect(result.builtA.verificationDigest).not.toBe(result.builtB.verificationDigest)

    const prefixA = `|snap|${result.builtA.snapshot.id}`
    const prefixB = `|snap|${result.builtB.snapshot.id}`
    for (const [key, vertex] of fake.vertices) {
      if (!vertex.label.startsWith("Snapshot")) continue
      expect(key.includes(prefixA) !== key.includes(prefixB)).toBe(true)
    }
    for (const relation of fake.relations.values()) {
      if (!relation.type.startsWith("SNAPSHOT_")) continue
      const inA = relation.srcKey.includes(prefixA)
      const inB = relation.srcKey.includes(prefixB)
      expect(inA !== inB).toBe(true)
      expect(relation.dstKey.includes(inA ? prefixA : prefixB)).toBe(true)
    }
  })

  it("keeps a revision with no claims reachable through revision coverage", async () => {
    const fake = makeHydraMemory()
    const result = await run(
      fake,
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const revA = yield* commitRevision(manifest, fake, sessionA, [claimA1])
        const revB = yield* commitRevision(manifest, fake, sessionB, [])
        const snapshot = snapshotFor(scope, nateNathanView, [revA.commitId, revB.commitId])
        const record = yield* registerSnapshot(manifest, snapshot, nateNathanView)
        const graph = yield* SnapshotGraph
        const built = yield* graph.build({ snapshotId: record.snapshot.id, causalLinks: [] })
        return { record, built, revB }
      })
    )

    expect(result.built.state).toBe("VERIFIED")
    const revisionVertex = fake.vertices.get(
      `${snapshotRootKey(scope, result.record.snapshot.id)}|rev|${result.revB.commitId}`
    )
    expect(revisionVertex?.label).toBe("SnapshotRevision")
    expect(revisionVertex?.properties["n_claims"]).toBe(0)
    expect(result.built.counts?.sourceRevisions).toBe(2)
  })

  it("fails before any write when a stored claim collides with a foreign identity", async () => {
    const fake = makeHydraMemory()
    // The seeded snapshot's root key is only known after `begin` assigns commit
    // ids; the reducer resolves it lazily once the effect has registered it.
    let rootKey = ""
    const collisionLayer = makeIngestManifestTestLayer((key) =>
      key === "foreign-identity" ? vertexId(rootKey) : vertexId(key)
    )
    const outcome = await run(
      fake,
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const { record } = yield* seeded(fake)
        rootKey = snapshotRootKey(scope, record.snapshot.id)
        yield* manifest.claimGraphId({
          reducedId: vertexId(rootKey),
          kind: "vertex",
          canonicalIdentity: "foreign-identity"
        })
        const graph = yield* SnapshotGraph
        const built = yield* graph
          .build({ snapshotId: record.snapshot.id, causalLinks: [] })
          .pipe(Effect.result)
        const stored = yield* manifest.readUserIndexSnapshot(record.snapshot.id)
        const quarantine = yield* manifest.listGraphIdQuarantine()
        return { built, stored, quarantine }
      }),
      collisionLayer
    )

    expect(outcome.built).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GraphIdCollision", existingIdentity: "foreign-identity" }
    })
    expect(outcome.stored?.state).toBe("BUILDING")
    expect(outcome.quarantine).toHaveLength(1)
    expect([...fake.vertices.keys()].some((key) => key.includes("|snap|"))).toBe(false)
  })

  it("fails when the durable source session was never written", async () => {
    const fake = makeHydraMemory()
    const outcome = await run(
      fake,
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        let revision = (
          yield* manifest.begin(sourceRevisionInputForSession(scope, sessionA, EXTRACTION))
        ).revision
        revision = yield* manifest.advance({ revision, from: "RECEIVED", to: "SOURCE_DURABLE" })
        // Deliberately skip writeSourcePlane: the durable transcript is absent.
        revision = yield* manifest.advance({ revision, from: "SOURCE_DURABLE", to: "INDEXED" })
        yield* manifest.storeExtractionArtifact({
          revision,
          artifact: artifactFor(revision, sessionA, [claimA1])
        })
        revision = yield* manifest.advance({ revision, from: "INDEXED", to: "ENRICHED" })
        revision = yield* manifest.advance({ revision, from: "ENRICHED", to: "CONSOLIDATED" })
        revision = yield* manifest.advance({ revision, from: "CONSOLIDATED", to: "COMMITTED" })
        const snapshot = snapshotFor(scope, nateNathanView, [revision.commitId])
        const record = yield* registerSnapshot(manifest, snapshot, nateNathanView)
        const graph = yield* SnapshotGraph
        return yield* graph
          .build({ snapshotId: record.snapshot.id, causalLinks: [] })
          .pipe(Effect.result)
      })
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphBuildRejected", reason: "missingSourceSession" }
    })
  })
})
