import type { MemoryNode, MemoryPath, PropertyValue } from "@palimpsest/hydra"
import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"
import { createEntityCanonicalView, type EntityCanonicalView } from "../../src/EntityCanonicalView.js"
import { createIndexGeneration } from "../../src/IndexGeneration.js"
import {
  IngestManifest,
  IngestManifestLayerMemory,
  type IngestManifestError,
  type SourceRevision
} from "../../src/IngestManifest.js"
import type { CanonicalViewOperations } from "../../src/IngestManifest/CanonicalView.js"
import type { GenerationOperations } from "../../src/IngestManifest/Generations.js"
import type { RevisionOperations } from "../../src/IngestManifest/Revisions.js"
import { MANIFEST_SCHEMA_VERSION } from "../../src/IngestManifest/Schema.js"
import type { SnapshotOperations } from "../../src/IngestManifest/Snapshots.js"
import { parseMemoryScope, type MemoryScope } from "../../src/MemoryScope.js"
import {
  parseQueryPrincipal,
  resolveQueryContext,
  type QueryContext,
  type QueryPrincipal
} from "../../src/QueryContext.js"
import { snapshotClaimKey, snapshotEvidenceKey, snapshotSlotKey } from "../../src/SnapshotGraph.js"
import {
  parseSnapshotSourceTurn,
  requireSnapshotProvenance,
  snapshotEvidenceLocators,
  snapshotReachedRows,
  snapshotSlotFills,
  snapshotSlotIndex,
  snapshotSlotIndexKey,
  snapshotSupersedeFold
} from "../../src/SnapshotRows.js"
import { createExtractionGeneration } from "../../src/SourceIdentity.js"
import { sourceTurnKey } from "../../src/SourceTranscript.js"
import { createUserIndexSnapshot, type UserIndexSnapshot } from "../../src/UserIndexSnapshot.js"

type Node = MemoryPath["nodes"][number]

const node = (id: number, label: string, properties: Node["properties"]): Node => ({
  id,
  key: `${label}:${id}`,
  labels: [label],
  properties
})

const pathOf = (
  nodes: ReadonlyArray<Node>,
  types: ReadonlyArray<string>,
  edgeProperties: ReadonlyArray<Node["properties"]> = []
): MemoryPath => ({
  nodes,
  relationships: types.map((type, i) => ({
    id: 100 + i,
    key: `${nodes[i]?.key ?? ""}|${type}|${nodes[i + 1]?.key ?? ""}`,
    type,
    src: nodes[i]?.id ?? 0,
    dst: nodes[i + 1]?.id ?? 0,
    properties: edgeProperties[i] ?? {}
  }))
})

const extraction = createExtractionGeneration({
  extractor: { id: "test-extractor", revision: "git:test" },
  model: { id: "test-model", revision: "snapshot:test" },
  tokenizer: { id: "test-tokenizer", revision: "v1" },
  promptTemplate: "test extraction prompt",
  outputSchema: { type: "object", version: 1 }
})

const indexGeneration = createIndexGeneration({
  extractionGeneration: extraction,
  graphWriter: { id: "test-writer", revision: "git:writer-1" },
  graphSchema: { id: "test-graph-schema", revision: "v1" }
})

const scope = { tenant: "tenant-a", uid: "user-a" } as const

const memoryScope = (tenant: string, uid: string): MemoryScope =>
  Result.getOrThrow(parseMemoryScope(tenant, uid))

const viewOf = (identities: ReadonlyArray<{ id: string; canon: string }>): EntityCanonicalView =>
  Result.getOrThrow(
    createEntityCanonicalView({
      identities: identities.map((identity) => ({ ...identity, etype: "person" })),
      equivalences: []
    })
  )

const view = viewOf([{ id: "identity-alice", canon: "alice" }])

type ManifestOps = RevisionOperations & GenerationOperations & CanonicalViewOperations & SnapshotOperations

const digest = (marker: string): string => marker.repeat(64)

const verification = (sourceRevisions: number, marker = "f") => ({
  verificationDigest: digest(marker),
  graphRoots: ["t9:tenant-a|u6:user-a|snapshot|root-1"],
  counts: { sourceRevisions, vertices: 12, relationships: 7 }
})

const snapshotFor = (
  sourceCommitIds: ReadonlyArray<string>,
  overrides?: {
    readonly scope?: MemoryScope
    readonly canonicalViewId?: string
    readonly manifestSchemaVersion?: number
  }
) =>
  Result.getOrThrow(
    createUserIndexSnapshot({
      scope: overrides?.scope ?? memoryScope(scope.tenant, scope.uid),
      indexGenerationId: indexGeneration.id,
      canonicalViewId: overrides?.canonicalViewId ?? view.id,
      sourceCommitIds,
      manifestSchemaVersion: overrides?.manifestSchemaVersion ?? MANIFEST_SCHEMA_VERSION
    })
  )

const STAGE_PATH = [
  ["RECEIVED", "SOURCE_DURABLE"],
  ["SOURCE_DURABLE", "INDEXED"],
  ["INDEXED", "ENRICHED"],
  ["ENRICHED", "CONSOLIDATED"],
  ["CONSOLIDATED", "COMMITTED"]
] as const

const commitRevision = (
  manifest: Pick<ManifestOps, "begin" | "advance">,
  logicalSessionId: string,
  sourceDigest: string
): Effect.Effect<SourceRevision, IngestManifestError> =>
  Effect.gen(function* () {
    let revision = (
      yield* manifest.begin({
        tenant: scope.tenant,
        uid: scope.uid,
        logicalSessionId,
        sourceDigest,
        sourceBytes: 100,
        extractionGeneration: { id: extraction.id, canonicalJson: extraction.canonicalJson }
      })
    ).revision
    for (const [from, to] of STAGE_PATH) {
      revision = yield* manifest.advance({ revision, from, to })
    }
    return revision
  })

const principalFor = (tenantId: string, subject = "test-caller"): QueryPrincipal =>
  Result.getOrThrow(parseQueryPrincipal(tenantId, subject))

interface BoundSnapshot {
  readonly query: QueryContext
  readonly revision: SourceRevision
  readonly snapshot: UserIndexSnapshot
  readonly logicalSessionId: string
  readonly sourceDigest: string
}

const setupBound = (): Promise<BoundSnapshot> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const logicalSessionId = "session-a"
        const sourceDigest = digest("a")
        const revision = yield* commitRevision(manifest, logicalSessionId, sourceDigest)
        yield* manifest.storeIndexGeneration({ generation: indexGeneration })
        yield* manifest.storeEntityCanonicalView({ ...scope, view })
        const snapshot = snapshotFor([revision.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot })
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: snapshot.id, ...verification(1) })
        const manifestVersion = yield* manifest.readManifestVersion(scope)
        yield* manifest.activateIndexSnapshot({
          ...scope,
          snapshotId: snapshot.id,
          expectedManifestVersion: manifestVersion,
          expectedActiveSnapshotId: null
        })
        const query = yield* resolveQueryContext({
          principal: principalFor(scope.tenant),
          requestedUid: scope.uid
        })
        return { query, revision, snapshot, logicalSessionId, sourceDigest }
      }).pipe(Effect.provide(IngestManifestLayerMemory))
    )
  )

const claimNode = (
  id: number,
  ckey: string,
  commitId: string,
  logicalSessionId: string,
  sourceDigest: string
): Node =>
  node(id, "SnapshotClaim", {
    snapshot_claim: ckey,
    commit_id: commitId,
    logical_session_id: logicalSessionId,
    source_digest: sourceDigest,
    text: `derived text for ${ckey}`,
    speaker: "user",
    ctype: "state",
    session_ord: 1,
    session_date: 20230101,
    accepted_at_ms: Date.UTC(2023, 0, 1),
    t_event: 0,
    t_prec: "none",
    sid: "session-a",
    turn_idx: 1,
    cs: 0,
    ce: 5
  })

const tokenNode = (id: number, stem: string): Node =>
  node(id, "SnapshotToken", { token: stem, snapshot_token: stem, df: 2 })

describe("snapshotReachedRows", () => {
  it("parses in-snapshot claims with full snapshot provenance", async () => {
    const bound = await setupBound()
    const ckey = snapshotClaimKey(
      bound.query.scope,
      bound.snapshot.id,
      bound.revision.commitId,
      "claim-digest"
    )
    const paths = [
      pathOf(
        [tokenNode(1, "mortgage"), claimNode(10, ckey, bound.revision.commitId, bound.logicalSessionId, bound.sourceDigest)],
        ["SNAPSHOT_HITS"]
      )
    ]

    const parsed = snapshotReachedRows(paths, bound.query)

    expect(Result.isSuccess(parsed) && parsed.success).toHaveLength(1)
    expect(Result.isSuccess(parsed) && parsed.success[0]).toMatchObject({
      anchor: "mortgage",
      df: 2,
      hops: 1,
      claim: {
        ckey,
        acceptedAtMs: Date.UTC(2023, 0, 1),
        provenance: {
          snapshotId: bound.snapshot.id,
          commitId: bound.revision.commitId,
          sourceDigest: bound.sourceDigest,
          logicalSessionId: bound.logicalSessionId,
          indexGenerationId: bound.snapshot.indexGenerationId,
          canonicalViewId: bound.snapshot.canonicalViewId
        }
      }
    })
  })

  it("rejects a claim from a superseded snapshot instead of mixing it in", async () => {
    const bound = await setupBound()
    const foreign = snapshotClaimKey(
      bound.query.scope,
      "snapshot-superseded",
      bound.revision.commitId,
      "claim-digest"
    )
    const paths = [
      pathOf(
        [tokenNode(1, "mortgage"), claimNode(10, foreign, bound.revision.commitId, bound.logicalSessionId, bound.sourceDigest)],
        ["SNAPSHOT_HITS"]
      )
    ]

    const parsed = snapshotReachedRows(paths, bound.query)

    expect(parsed).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SnapshotScopeViolation",
        reason: "foreignSnapshot",
        expectedSnapshotId: bound.snapshot.id
      }
    })
  })

  it("rejects another tenant's claim as foreign scope", async () => {
    const bound = await setupBound()
    const foreign = snapshotClaimKey(
      memoryScope("tenant-b", scope.uid),
      bound.snapshot.id,
      bound.revision.commitId,
      "claim-digest"
    )
    const paths = [
      pathOf(
        [tokenNode(1, "mortgage"), claimNode(10, foreign, bound.revision.commitId, bound.logicalSessionId, bound.sourceDigest)],
        ["SNAPSHOT_HITS"]
      )
    ]

    const parsed = snapshotReachedRows(paths, bound.query)

    expect(parsed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotScopeViolation", reason: "foreignScope" }
    })
  })

  it("rejects a claim whose revision the bound snapshot does not cover", async () => {
    const bound = await setupBound()
    const ckey = snapshotClaimKey(
      bound.query.scope,
      bound.snapshot.id,
      "commit-uncovered",
      "claim-digest"
    )
    const paths = [
      pathOf(
        [tokenNode(1, "mortgage"), claimNode(10, ckey, "commit-uncovered", bound.logicalSessionId, bound.sourceDigest)],
        ["SNAPSHOT_HITS"]
      )
    ]

    const parsed = snapshotReachedRows(paths, bound.query)

    expect(parsed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphMismatch", reason: "uncoveredRevision" }
    })
  })

  it("skips empty claim keys like the legacy parser", async () => {
    const bound = await setupBound()
    const paths = [pathOf([tokenNode(1, "mortgage"), node(10, "SnapshotClaim", {})], ["SNAPSHOT_HITS"])]

    const parsed = snapshotReachedRows(paths, bound.query)

    expect(Result.isSuccess(parsed) && parsed.success).toEqual([])
  })
})

describe("snapshotSlotFills", () => {
  it("parses in-snapshot slot fills in either direction", async () => {
    const bound = await setupBound()
    const skey = snapshotSlotKey(bound.query.scope, bound.snapshot.id, "identity-alice", "residence")
    const ckey = snapshotClaimKey(
      bound.query.scope,
      bound.snapshot.id,
      bound.revision.commitId,
      "claim-digest"
    )
    const paths = [
      pathOf([node(20, "SnapshotSlot", { snapshot_slot: skey }), node(10, "SnapshotClaim", { snapshot_claim: ckey })], ["SNAPSHOT_FILLS"])
    ]

    const parsed = snapshotSlotFills(paths, bound.query)

    expect(Result.isSuccess(parsed) && parsed.success).toEqual([{ skey, ckey }])
  })

  it("rejects a fill whose slot names another snapshot", async () => {
    const bound = await setupBound()
    const skey = snapshotSlotKey(bound.query.scope, "snapshot-superseded", "identity-alice", "residence")
    const paths = [
      pathOf([node(20, "SnapshotSlot", { snapshot_slot: skey }), node(10, "SnapshotClaim", {})], ["SNAPSHOT_FILLS"])
    ]

    const parsed = snapshotSlotFills(paths, bound.query)

    expect(parsed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotScopeViolation", reason: "foreignSnapshot" }
    })
  })
})

describe("snapshotEvidenceLocators", () => {
  it("parses locators carrying the source-plane turn key", async () => {
    const bound = await setupBound()
    const ckey = snapshotClaimKey(
      bound.query.scope,
      bound.snapshot.id,
      bound.revision.commitId,
      "claim-digest"
    )
    const evidenceKey = snapshotEvidenceKey(
      bound.query.scope,
      bound.snapshot.id,
      bound.revision.commitId,
      1
    )
    const turnKey = sourceTurnKey(
      bound.query.scope,
      bound.logicalSessionId,
      bound.sourceDigest,
      1
    )
    const paths = [
      pathOf(
        [
          node(10, "SnapshotClaim", { snapshot_claim: ckey }),
          node(30, "SnapshotEvidence", {
            snapshot_evidence: evidenceKey,
            commit_id: bound.revision.commitId,
            logical_session_id: bound.logicalSessionId,
            source_digest: bound.sourceDigest,
            turn_idx: 1,
            source_turn_key: turnKey
          })
        ],
        ["SNAPSHOT_EVIDENCE"]
      )
    ]

    const parsed = snapshotEvidenceLocators(paths, bound.query)

    expect(Result.isSuccess(parsed) && parsed.success).toEqual([
      {
        ckey,
        commitId: bound.revision.commitId,
        logicalSessionId: bound.logicalSessionId,
        sourceDigest: bound.sourceDigest,
        turnIdx: 1,
        sourceTurnKey: turnKey
      }
    ])
  })

  it("rejects a locator pointing outside the scope's source plane", async () => {
    const bound = await setupBound()
    const ckey = snapshotClaimKey(
      bound.query.scope,
      bound.snapshot.id,
      bound.revision.commitId,
      "claim-digest"
    )
    const evidenceKey = snapshotEvidenceKey(
      bound.query.scope,
      bound.snapshot.id,
      bound.revision.commitId,
      1
    )
    const foreignTurnKey = sourceTurnKey(
      memoryScope("tenant-b", scope.uid),
      bound.logicalSessionId,
      bound.sourceDigest,
      1
    )
    const paths = [
      pathOf(
        [
          node(10, "SnapshotClaim", { snapshot_claim: ckey }),
          node(30, "SnapshotEvidence", {
            snapshot_evidence: evidenceKey,
            commit_id: bound.revision.commitId,
            logical_session_id: bound.logicalSessionId,
            source_digest: bound.sourceDigest,
            turn_idx: 1,
            source_turn_key: foreignTurnKey
          })
        ],
        ["SNAPSHOT_EVIDENCE"]
      )
    ]

    const parsed = snapshotEvidenceLocators(paths, bound.query)

    expect(parsed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotScopeViolation", reason: "foreignScope" }
    })
  })
})

describe("snapshotSupersedeFold", () => {
  it("keeps the earliest replacement regardless of path order, like the legacy fold", async () => {
    const bound = await setupBound()
    const older = snapshotClaimKey(bound.query.scope, bound.snapshot.id, bound.revision.commitId, "older")
    const middle = snapshotClaimKey(bound.query.scope, bound.snapshot.id, bound.revision.commitId, "middle")
    const newer = snapshotClaimKey(bound.query.scope, bound.snapshot.id, bound.revision.commitId, "newer")
    const edge = (target: string, atSession: number) =>
      pathOf(
        [node(10, "SnapshotClaim", { snapshot_claim: older }), node(11, "SnapshotClaim", { snapshot_claim: target })],
        ["SNAPSHOT_SUPERSEDED_BY"],
        [{ at_session: atSession }]
      )
    const forward = snapshotSupersedeFold([edge(middle, 3), edge(newer, 1)], bound.query)
    const reversed = snapshotSupersedeFold([edge(newer, 1), edge(middle, 3)], bound.query)

    expect(Result.isSuccess(forward) && forward.success.get(older)).toEqual({ newer, atSession: 1 })
    expect(reversed).toEqual(forward)
  })

  it("rejects an edge that names a claim outside the bound snapshot", async () => {
    const bound = await setupBound()
    const older = snapshotClaimKey(bound.query.scope, bound.snapshot.id, bound.revision.commitId, "older")
    const foreign = snapshotClaimKey(bound.query.scope, "snapshot-superseded", bound.revision.commitId, "newer")
    const paths = [
      pathOf(
        [node(10, "SnapshotClaim", { snapshot_claim: older }), node(12, "SnapshotClaim", { snapshot_claim: foreign })],
        ["SNAPSHOT_SUPERSEDED_BY"],
        [{ at_session: 1 }]
      )
    ]

    const parsed = snapshotSupersedeFold(paths, bound.query)

    expect(parsed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotScopeViolation", reason: "foreignSnapshot" }
    })
  })
})

describe("snapshotSlotIndex", () => {
  it("indexes slots by framed entity and attribute", async () => {
    const bound = await setupBound()
    const skey = snapshotSlotKey(bound.query.scope, bound.snapshot.id, "identity-alice", "residence")
    const paths = [
      pathOf(
        [node(1, "SnapshotRoot", {}), node(20, "SnapshotSlot", { snapshot_slot: skey, entity_canon: "alice", attr: "residence" })],
        ["SNAPSHOT_HAS_SLOT"]
      )
    ]

    const parsed = snapshotSlotIndex(paths, bound.query)

    expect(Result.isSuccess(parsed) && parsed.success.get(snapshotSlotIndexKey("alice", "residence"))).toBe(skey)
  })

  it("rejects a slot from another tenant's namespace", async () => {
    const bound = await setupBound()
    const skey = snapshotSlotKey(memoryScope("tenant-b", scope.uid), bound.snapshot.id, "identity-alice", "residence")
    const paths = [
      pathOf(
        [node(1, "SnapshotRoot", {}), node(20, "SnapshotSlot", { snapshot_slot: skey, entity_canon: "alice", attr: "residence" })],
        ["SNAPSHOT_HAS_SLOT"]
      )
    ]

    const parsed = snapshotSlotIndex(paths, bound.query)

    expect(parsed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotScopeViolation", reason: "foreignScope" }
    })
  })
})

describe("parseSnapshotSourceTurn", () => {
  const rowFor = (bound: BoundSnapshot, over: Readonly<Record<string, PropertyValue>> = {}): MemoryNode => ({
    id: 2,
    key: sourceTurnKey(bound.query.scope, bound.logicalSessionId, bound.sourceDigest, 1),
    labels: ["SourceTurn"],
    properties: {
      tenant: scope.tenant,
      uid: scope.uid,
      logical_session_id: bound.logicalSessionId,
      source_digest: bound.sourceDigest,
      text: "immutable source bytes",
      chunks: 1,
      role: "user",
      turn_idx: 1,
      ...over
    }
  })

  it("accepts a row that matches the locator", async () => {
    const bound = await setupBound()

    const parsed = parseSnapshotSourceTurn("turn-key", rowFor(bound), bound.query, {
      logicalSessionId: bound.logicalSessionId,
      sourceDigest: bound.sourceDigest
    })

    expect(Result.isSuccess(parsed) && parsed.success).toMatchObject({
      key: "turn-key",
      text: "immutable source bytes",
      role: "user",
      turnIdx: 1
    })
  })

  it("rejects tenant, uid, session, and digest drift as a graph mismatch", async () => {
    const bound = await setupBound()
    const expected = { logicalSessionId: bound.logicalSessionId, sourceDigest: bound.sourceDigest }
    const mutations: ReadonlyArray<Record<string, PropertyValue>> = [
      { tenant: "tenant-b" },
      { uid: "user-b" },
      { logical_session_id: "session-b" },
      { source_digest: digest("b") }
    ]

    for (const mutation of mutations) {
      const row = rowFor(bound, mutation)
      const parsed = parseSnapshotSourceTurn("turn-key", row, bound.query, expected)
      expect(parsed).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "SnapshotGraphMismatch", reason: "sourceTurnMismatch" }
      })
    }
  })
})

describe("requireSnapshotProvenance", () => {
  it("accepts candidates carrying the bound snapshot", async () => {
    const bound = await setupBound()
    const candidates = [
      {
        ckey: "ckey-a",
        provenance: {
          snapshotId: bound.snapshot.id,
          commitId: bound.revision.commitId,
          sourceDigest: bound.sourceDigest,
          logicalSessionId: bound.logicalSessionId,
          indexGenerationId: bound.snapshot.indexGenerationId,
          canonicalViewId: bound.snapshot.canonicalViewId
        }
      }
    ]

    expect(requireSnapshotProvenance(candidates, bound.query)).toMatchObject({ _tag: "Success" })
  })

  it("rejects a candidate with no provenance at all", async () => {
    const bound = await setupBound()

    const parsed = requireSnapshotProvenance([{ ckey: "ckey-a" }], bound.query)

    expect(parsed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotScopeViolation", reason: "missingProvenance", key: "ckey-a" }
    })
  })

  it("rejects a candidate provenanced to another snapshot", async () => {
    const bound = await setupBound()
    const candidates = [
      {
        ckey: "ckey-a",
        provenance: {
          snapshotId: "snapshot-superseded",
          commitId: bound.revision.commitId,
          sourceDigest: bound.sourceDigest,
          logicalSessionId: bound.logicalSessionId,
          indexGenerationId: bound.snapshot.indexGenerationId,
          canonicalViewId: bound.snapshot.canonicalViewId
        }
      }
    ]

    const parsed = requireSnapshotProvenance(candidates, bound.query)

    expect(parsed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotScopeViolation", reason: "foreignSnapshot" }
    })
  })

  it("rejects a candidate from another generation or canonical view", async () => {
    const bound = await setupBound()
    const provenanceFor = (over: { indexGenerationId?: string; canonicalViewId?: string }) => ({
      snapshotId: bound.snapshot.id,
      commitId: bound.revision.commitId,
      sourceDigest: bound.sourceDigest,
      logicalSessionId: bound.logicalSessionId,
      indexGenerationId: over.indexGenerationId ?? bound.snapshot.indexGenerationId,
      canonicalViewId: over.canonicalViewId ?? bound.snapshot.canonicalViewId
    })

    for (const provenance of [
      provenanceFor({ indexGenerationId: "generation-other" }),
      provenanceFor({ canonicalViewId: "view-other" })
    ]) {
      const parsed = requireSnapshotProvenance([{ ckey: "ckey-a", provenance }], bound.query)
      expect(parsed).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "SnapshotScopeViolation", reason: "foreignSnapshot" }
      })
    }
  })
})
