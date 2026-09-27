import {
  HydraMemory,
  type DiscoveryInput,
  type MemoryNode,
  type MemoryPath,
  type NodeLookup,
  type PropertyValue
} from "@palimpsest/hydra"
import { describeExecutionPlan, makeExecutionPlan } from "@palimpsest/hydra/testing"
import { Llm } from "@palimpsest/llm"
import { Effect, Layer, Option, Result } from "effect"
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
  type ClaimProvenance,
  type QueryPrincipal
} from "../../src/QueryContext.js"
import { Reader } from "../../src/Reader.js"
import { Retrieve } from "../../src/Retrieve.js"
import type { AsOfLabelled } from "../../src/Scoring.js"
import {
  gatherInSnapshot,
  readSnapshotClaimStats,
  SnapshotSearch
} from "../../src/SnapshotArms.js"
import {
  SNAPSHOT_GRAPH_FORMAT,
  snapshotClaimKey,
  snapshotEvidenceKey,
  snapshotRootKey
} from "../../src/SnapshotGraph.js"
import { createExtractionGeneration } from "../../src/SourceIdentity.js"
import { sourceTurnKey } from "../../src/SourceTranscript.js"
import { createUserIndexSnapshot, type UserIndexSnapshot } from "../../src/UserIndexSnapshot.js"
import { behaviorFake, runWithBehaviorFakes } from "../BehaviorFake.js"

type Node = MemoryPath["nodes"][number]

const node = (id: number, label: string, properties: Node["properties"]): Node => ({
  id,
  key: `${label}:${id}`,
  labels: [label],
  properties
})

const pathOf = (nodes: ReadonlyArray<Node>, types: ReadonlyArray<string>): MemoryPath => ({
  nodes,
  relationships: types.map((type, i) => ({
    id: 100 + i,
    key: `${nodes[i]?.key ?? ""}|${type}|${nodes[i + 1]?.key ?? ""}`,
    type,
    src: nodes[i]?.id ?? 0,
    dst: nodes[i + 1]?.id ?? 0,
    properties: {}
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

const snapshotFor = (sourceCommitIds: ReadonlyArray<string>) =>
  Result.getOrThrow(
    createUserIndexSnapshot({
      scope: memoryScope(scope.tenant, scope.uid),
      indexGenerationId: indexGeneration.id,
      canonicalViewId: view.id,
      sourceCommitIds,
      manifestSchemaVersion: MANIFEST_SCHEMA_VERSION
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

const seedManifest = (manifest: ManifestOps): Effect.Effect<void, IngestManifestError> =>
  Effect.gen(function* () {
    yield* manifest.storeIndexGeneration({ generation: indexGeneration })
    yield* manifest.storeEntityCanonicalView({ ...scope, view })
  })

const registerActive = (
  manifest: ManifestOps,
  snapshot: UserIndexSnapshot,
  sourceRevisions: number,
  expectedActiveSnapshotId: string | null
): Effect.Effect<void, IngestManifestError> =>
  Effect.gen(function* () {
    yield* manifest.registerUserIndexSnapshot({ snapshot })
    yield* manifest.verifyUserIndexSnapshot({ snapshotId: snapshot.id, ...verification(sourceRevisions) })
    const manifestVersion = yield* manifest.readManifestVersion(scope)
    yield* manifest.activateIndexSnapshot({
      ...scope,
      snapshotId: snapshot.id,
      expectedManifestVersion: manifestVersion,
      expectedActiveSnapshotId
    })
  })

const principalFor = (tenantId: string, subject = "test-caller"): QueryPrincipal =>
  Result.getOrThrow(parseQueryPrincipal(tenantId, subject))

const QUESTION_DATE = "2023/05/01 (Mon) 10:00"

const UNDERSTANDING = {
  anchor_terms: ["mortgage", "wells"],
  historical: false,
  wants_count: false,
  time_ref: null,
  route: "fact",
  sub_questions: [],
  probes: []
}

const stubLlm = Layer.succeed(Llm, behaviorFake<Llm>({
  model: "stub",
  cacheDir: "",
  concurrency: 1,
  generateObject: (options: { kind: string }) =>
    Effect.succeed({
      value: options.kind === "anchors" ? UNDERSTANDING : { keep: [] },
      cached: true,
      model: "stub",
      inputTokens: 0,
      outputTokens: 0
    }),
  usage: Effect.succeed({ inputTokens: 0, outputTokens: 0, calls: 0, cacheHits: 0 }),
  resetUsage: Effect.void
}))

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
    sid: logicalSessionId,
    turn_idx: 1,
    cs: 0,
    ce: 5
  })

const tokenNode = (id: number, stem: string): Node =>
  node(id, "SnapshotToken", { token: stem, snapshot_token: stem, df: 2 })

/** Two anchors reach one claim, so it grounds at the convergence threshold. */
const convergencePaths = (
  ckey: string,
  commitId: string,
  logicalSessionId: string,
  sourceDigest: string
): ReadonlyArray<MemoryPath> => [
  pathOf(
    [tokenNode(1, "mortgage"), claimNode(10, ckey, commitId, logicalSessionId, sourceDigest)],
    ["SNAPSHOT_HITS"]
  ),
  pathOf(
    [tokenNode(2, "wells"), claimNode(11, ckey, commitId, logicalSessionId, sourceDigest)],
    ["SNAPSHOT_HITS"]
  )
]

const rootRow = (
  snapshot: UserIndexSnapshot,
  nRevisions: number,
  nClaims: number,
  over: Readonly<Record<string, PropertyValue>> = {}
): MemoryNode => ({
  id: 1,
  key: snapshotRootKey(memoryScope(scope.tenant, scope.uid), snapshot.id),
  labels: ["SnapshotRoot"],
  properties: {
    snapshot_id: snapshot.id,
    graph_format: SNAPSHOT_GRAPH_FORMAT,
    source_revisions_hash: snapshot.sourceRevisionsHash,
    n_revisions: nRevisions,
    n_claims: nClaims,
    ...over
  }
})

const maybe = <A>(value: A | undefined): Option.Option<A> =>
  value === undefined ? Option.none() : Option.some(value)

interface GraphScript {
  readonly roots: Map<string, MemoryNode>
  readonly convergenceBySnapshot: Map<string, ReadonlyArray<MemoryPath>>
  readonly turns: Map<string, MemoryNode>
  setEvidencePaths: (paths: ReadonlyArray<MemoryPath>) => void
  readonly layer: Layer.Layer<HydraMemory>
}

/** A Hydra fake whose graph state the test declares after seeding the manifest. */
const makeScript = (): GraphScript => {
  const roots = new Map<string, MemoryNode>()
  const convergenceBySnapshot = new Map<string, ReadonlyArray<MemoryPath>>()
  const turns = new Map<string, MemoryNode>()
  let evidencePaths: ReadonlyArray<MemoryPath> = []
  const plan = makeExecutionPlan({ queryText: "", parameters: {} })
  const layer = Layer.succeed(HydraMemory, behaviorFake<HydraMemory>({
    discoverPaths: (config: DiscoveryInput) =>
      Effect.sync(() => {
        if (config.sourceLabel === "SnapshotToken") {
          return {
            paths: convergenceBySnapshot.get(config.targetValues?.[0] ?? "") ?? [],
            plan
          }
        }
        if (config.sourceLabel === "SnapshotClaim" && config.relTypes.includes("SNAPSHOT_EVIDENCE")) {
          return { paths: evidencePaths, plan }
        }
        return { paths: [], plan }
      }),
    describeExecutionPlan,
    resolveNode: (lookup: NodeLookup) =>
      Effect.succeed(
        lookup.label === "SnapshotRoot"
          ? maybe(roots.get(lookup.key))
          : lookup.label === "SourceTurn"
            ? maybe(turns.get(lookup.key))
            : Option.none()
      )
  }))
  return {
    roots,
    convergenceBySnapshot,
    turns,
    setEvidencePaths: (paths) => {
      evidencePaths = paths
    },
    layer
  }
}

const retrieveLayers = (script: GraphScript) =>
  Retrieve.layer.pipe(
    Layer.provideMerge(SnapshotSearch.layer),
    Layer.provideMerge(script.layer),
    Layer.provideMerge(IngestManifestLayerMemory),
    Layer.provideMerge(stubLlm)
  )

const readerLayers = (script: GraphScript) =>
  Reader.layer.pipe(
    Layer.provideMerge(script.layer),
    Layer.provideMerge(IngestManifestLayerMemory),
    Layer.provideMerge(stubLlm)
  )

const ASK_OPTIONS = { questionDate: QUESTION_DATE, ablations: { noDiscovery: true, noSelect: true } } as const

describe("snapshot ask", () => {
  it("binds one request to exactly one snapshot and labels every evidence item with it", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const revision = yield* commitRevision(manifest, "session-a", digest("a"))
          yield* seedManifest(manifest)
          const snapshot = snapshotFor([revision.commitId])
          yield* registerActive(manifest, snapshot, 1, null)
          const ckey = snapshotClaimKey(
            memoryScope(scope.tenant, scope.uid),
            snapshot.id,
            revision.commitId,
            "claim-digest"
          )
          yield* Effect.sync(() => {
            script.roots.set(snapshotRootKey(memoryScope(scope.tenant, scope.uid), snapshot.id), rootRow(snapshot, 1, 10))
            script.convergenceBySnapshot.set(
              snapshot.id,
              convergencePaths(ckey, revision.commitId, "session-a", digest("a"))
            )
          })
          const retrieve = yield* Retrieve
          const result = yield* retrieve.ask(
            principalFor(scope.tenant),
            scope.uid,
            "Where is my mortgage?",
            ASK_OPTIONS
          )
          return { result, snapshot, revision }
        }),
        retrieveLayers(script)
      )
    )

    expect(outcome.result.verdict).toBe("ANSWER")
    expect(outcome.result.query.snapshot.id).toBe(outcome.snapshot.id)
    expect(outcome.result.evidence.length).toBeGreaterThan(0)
    for (const item of outcome.result.evidence) {
      expect(item.provenance).toMatchObject({
        snapshotId: outcome.snapshot.id,
        commitId: outcome.revision.commitId,
        sourceDigest: digest("a"),
        logicalSessionId: "session-a",
        indexGenerationId: outcome.snapshot.indexGenerationId,
        canonicalViewId: outcome.snapshot.canonicalViewId
      })
    }
  })

  it("fails typed when the scope has no active snapshot instead of reporting absence", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          yield* commitRevision(manifest, "session-a", digest("a"))
          const retrieve = yield* Retrieve
          return yield* Effect.result(
            retrieve.ask(principalFor(scope.tenant), scope.uid, "Where is my mortgage?", ASK_OPTIONS)
          )
        }),
        retrieveLayers(script)
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "NoActiveSnapshot", tenant: scope.tenant, uid: scope.uid }
    })
  })

  it("rejects another tenant's rows at read time", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const revision = yield* commitRevision(manifest, "session-a", digest("a"))
          yield* seedManifest(manifest)
          const snapshot = snapshotFor([revision.commitId])
          yield* registerActive(manifest, snapshot, 1, null)
          const foreign = snapshotClaimKey(
            memoryScope("tenant-b", scope.uid),
            snapshot.id,
            revision.commitId,
            "claim-digest"
          )
          yield* Effect.sync(() => {
            script.roots.set(snapshotRootKey(memoryScope(scope.tenant, scope.uid), snapshot.id), rootRow(snapshot, 1, 10))
            script.convergenceBySnapshot.set(
              snapshot.id,
              convergencePaths(foreign, revision.commitId, "session-a", digest("a"))
            )
          })
          const retrieve = yield* Retrieve
          return yield* Effect.result(
            retrieve.ask(principalFor(scope.tenant), scope.uid, "Where is my mortgage?", ASK_OPTIONS)
          )
        }),
        retrieveLayers(script)
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotScopeViolation", reason: "foreignScope" }
    })
  })

  it("changes the whole visible state when activation lands between two asks", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const first = yield* commitRevision(manifest, "session-a", digest("a"))
          yield* seedManifest(manifest)
          const snapshotA = snapshotFor([first.commitId])
          yield* registerActive(manifest, snapshotA, 1, null)
          const scopeMem = memoryScope(scope.tenant, scope.uid)
          const ckeyA = snapshotClaimKey(scopeMem, snapshotA.id, first.commitId, "claim-a")
          yield* Effect.sync(() => {
            script.roots.set(snapshotRootKey(scopeMem, snapshotA.id), rootRow(snapshotA, 1, 10))
            script.convergenceBySnapshot.set(
              snapshotA.id,
              convergencePaths(ckeyA, first.commitId, "session-a", digest("a"))
            )
          })
          const retrieve = yield* Retrieve
          const before = yield* retrieve.ask(
            principalFor(scope.tenant),
            scope.uid,
            "Where is my mortgage?",
            ASK_OPTIONS
          )
          const second = yield* commitRevision(manifest, "session-b", digest("b"))
          const snapshotB = snapshotFor([first.commitId, second.commitId])
          yield* registerActive(manifest, snapshotB, 2, snapshotA.id)
          const ckeyB = snapshotClaimKey(scopeMem, snapshotB.id, second.commitId, "claim-b")
          yield* Effect.sync(() => {
            script.roots.set(snapshotRootKey(scopeMem, snapshotB.id), rootRow(snapshotB, 2, 11))
            script.convergenceBySnapshot.set(
              snapshotB.id,
              convergencePaths(ckeyB, second.commitId, "session-b", digest("b"))
            )
          })
          const after = yield* retrieve.ask(
            principalFor(scope.tenant),
            scope.uid,
            "Where is my mortgage now?",
            ASK_OPTIONS
          )
          return { before, after, snapshotA, snapshotB }
        }),
        retrieveLayers(script)
      )
    )

    expect(outcome.before.query.snapshot.id).toBe(outcome.snapshotA.id)
    expect(outcome.after.query.snapshot.id).toBe(outcome.snapshotB.id)
    expect(outcome.before.query.snapshot.id).not.toBe(outcome.after.query.snapshot.id)
    for (const item of outcome.after.evidence) {
      expect(item.provenance?.snapshotId).toBe(outcome.snapshotB.id)
    }
  })

  it("lets an in-flight binding keep reading its snapshot while rejecting the successor's rows", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const hydra = yield* HydraMemory
          const first = yield* commitRevision(manifest, "session-a", digest("a"))
          yield* seedManifest(manifest)
          const snapshotA = snapshotFor([first.commitId])
          yield* registerActive(manifest, snapshotA, 1, null)
          const scopeMem = memoryScope(scope.tenant, scope.uid)
          const context = yield* resolveQueryContext({
            principal: principalFor(scope.tenant),
            requestedUid: scope.uid
          })
          const second = yield* commitRevision(manifest, "session-b", digest("b"))
          const snapshotB = snapshotFor([first.commitId, second.commitId])
          yield* registerActive(manifest, snapshotB, 2, snapshotA.id)
          const ckeyA = snapshotClaimKey(scopeMem, snapshotA.id, first.commitId, "claim-a")
          const ckeyB = snapshotClaimKey(scopeMem, snapshotB.id, second.commitId, "claim-b")
          yield* Effect.sync(() => {
            script.roots.set(snapshotRootKey(scopeMem, snapshotA.id), rootRow(snapshotA, 1, 10))
            script.convergenceBySnapshot.set(
              snapshotA.id,
              convergencePaths(ckeyA, first.commitId, "session-a", digest("a"))
            )
          })
          const steady = yield* Effect.result(
            gatherInSnapshot(hydra, context, "Where is my mortgage?", {
              questionDate: QUESTION_DATE,
              ablations: { noDiscovery: true }
            })
          )
          yield* Effect.sync(() => {
            script.convergenceBySnapshot.set(
              snapshotA.id,
              convergencePaths(ckeyB, second.commitId, "session-b", digest("b"))
            )
          })
          const mixed = yield* Effect.result(
            gatherInSnapshot(hydra, context, "Where is my mortgage?", {
              questionDate: QUESTION_DATE,
              ablations: { noDiscovery: true }
            })
          )
          return { steady, mixed, context, snapshotA }
        }),
        retrieveLayers(script)
      )
    )

    expect(outcome.context.snapshot.id).toBe(outcome.snapshotA.id)
    expect(outcome.steady).toMatchObject({ _tag: "Success" })
    expect(outcome.mixed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotScopeViolation", reason: "foreignSnapshot" }
    })
  })

  it("surfaces a missing snapshot root as a typed graph mismatch, not an absence", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const revision = yield* commitRevision(manifest, "session-a", digest("a"))
          yield* seedManifest(manifest)
          const snapshot = snapshotFor([revision.commitId])
          yield* registerActive(manifest, snapshot, 1, null)
          const retrieve = yield* Retrieve
          return yield* Effect.result(
            retrieve.ask(principalFor(scope.tenant), scope.uid, "Where is my mortgage?", ASK_OPTIONS)
          )
        }),
        retrieveLayers(script)
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphMismatch", reason: "missingRoot" }
    })
  })
})

describe("readSnapshotClaimStats", () => {
  const seed = () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const revision = yield* commitRevision(manifest, "session-a", digest("a"))
          yield* seedManifest(manifest)
          const snapshot = snapshotFor([revision.commitId])
          yield* registerActive(manifest, snapshot, 1, null)
          const query = yield* resolveQueryContext({
            principal: principalFor(scope.tenant),
            requestedUid: scope.uid
          })
          return { query, snapshot }
        }),
        IngestManifestLayerMemory
      )
    )

  const statsWith = (row: MemoryNode | undefined, seenKeys: Array<string> = []) => {
    const hydra = behaviorFake<HydraMemory>({
      resolveNode: (lookup: NodeLookup) =>
        Effect.sync(() => {
          seenKeys.push(lookup.key)
          return maybe(row)
        })
    })
    return hydra
  }

  it("returns the claim denominator from the bound snapshot's root", async () => {
    const seeded = await seed()
    const seenKeys: Array<string> = []
    const outcome = await Effect.runPromise(
      Effect.result(
        readSnapshotClaimStats(
          statsWith(rootRow(seeded.snapshot, 1, 10), seenKeys),
          seeded.query
        )
      )
    )

    expect(outcome).toMatchObject({ _tag: "Success", success: { totalClaims: 10 } })
    expect(seenKeys).toEqual([snapshotRootKey(seeded.query.scope, seeded.snapshot.id)])
  })

  it("fails when the bound snapshot has no root in the graph", async () => {
    const seeded = await seed()
    const outcome = await Effect.runPromise(
      Effect.result(readSnapshotClaimStats(statsWith(undefined), seeded.query))
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphMismatch", reason: "missingRoot" }
    })
  })

  it("fails when the root names a different snapshot", async () => {
    const seeded = await seed()
    const outcome = await Effect.runPromise(
      Effect.result(
        readSnapshotClaimStats(
          statsWith(rootRow(seeded.snapshot, 1, 10, { snapshot_id: "snapshot-other" })),
          seeded.query
        )
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphMismatch", reason: "rootMismatch" }
    })
  })

  it("fails closed on a pre-recorded-time snapshot graph format", async () => {
    const seeded = await seed()
    const outcome = await Effect.runPromise(
      Effect.result(
        readSnapshotClaimStats(
          statsWith(rootRow(seeded.snapshot, 1, 10, { graph_format: "palimpsest.snapshot-graph.v1" })),
          seeded.query
        )
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphMismatch", reason: "graphFormatMismatch" }
    })
  })

  it("fails when the root's revision hash disagrees with the bound record", async () => {
    const seeded = await seed()
    const outcome = await Effect.runPromise(
      Effect.result(
        readSnapshotClaimStats(
          statsWith(rootRow(seeded.snapshot, 1, 10, { source_revisions_hash: "deadbeef" })),
          seeded.query
        )
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphMismatch", reason: "revisionsHashMismatch" }
    })
  })

  it("fails when the root's revision count disagrees with the bound record", async () => {
    const seeded = await seed()
    const outcome = await Effect.runPromise(
      Effect.result(
        readSnapshotClaimStats(statsWith(rootRow(seeded.snapshot, 2, 10)), seeded.query)
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphMismatch", reason: "countsMismatch" }
    })
  })
})

describe("snapshot hydration", () => {
  const SOURCE_TEXT = "The mortgage is with Wells Fargo."

  const evidenceClaim = (
    ckey: string,
    turnIdx: number,
    cs: number,
    ce: number,
    provenance?: ClaimProvenance
  ): AsOfLabelled => {
    const claimed: AsOfLabelled = {
      ckey,
      text: "DERIVED CLAIM TEXT that must never surface as evidence",
      speaker: "user",
      ctype: "state",
      sessionOrd: 1,
      sessionDate: 20230101,
      tEvent: 0,
      tPrec: "none",
      sid: "session-a",
      sessionKey: "session-a",
      turnIdx,
      cs,
      ce,
      anchors: [],
      convergence: 2,
      score: 1,
      hops: 1,
      status: "CURRENT",
      supersededBy: null,
      atSession: null
    }
    if (provenance === undefined) return claimed
    return { ...claimed, provenance }
  }

  const evidencePath = (
    ckey: string,
    commitId: string,
    logicalSessionId: string,
    sourceDigest: string,
    turnIdx: number,
    turnKey: string,
    evidenceKey: string
  ): MemoryPath =>
    pathOf(
      [
        node(10, "SnapshotClaim", { snapshot_claim: ckey }),
        node(30, "SnapshotEvidence", {
          snapshot_evidence: evidenceKey,
          commit_id: commitId,
          logical_session_id: logicalSessionId,
          source_digest: sourceDigest,
          turn_idx: turnIdx,
          source_turn_key: turnKey
        })
      ],
      ["SNAPSHOT_EVIDENCE"]
    )

  const turnRow = (turnIdx: number, over: Readonly<Record<string, PropertyValue>> = {}): MemoryNode => ({
    id: 2,
    key: sourceTurnKey(memoryScope(scope.tenant, scope.uid), "session-a", digest("a"), turnIdx),
    labels: ["SourceTurn"],
    properties: {
      tenant: scope.tenant,
      uid: scope.uid,
      logical_session_id: "session-a",
      source_digest: digest("a"),
      text: SOURCE_TEXT,
      chunks: 1,
      role: "user",
      turn_idx: turnIdx,
      ...over
    }
  })

  it("hydrates spans from immutable source bytes with snapshot provenance", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const revision = yield* commitRevision(manifest, "session-a", digest("a"))
          yield* seedManifest(manifest)
          const snapshot = snapshotFor([revision.commitId])
          yield* registerActive(manifest, snapshot, 1, null)
          const query = yield* resolveQueryContext({
            principal: principalFor(scope.tenant),
            requestedUid: scope.uid
          })
          const scopeMem = memoryScope(scope.tenant, scope.uid)
          const ckey = snapshotClaimKey(scopeMem, snapshot.id, revision.commitId, "claim-digest")
          const turnKey = sourceTurnKey(scopeMem, "session-a", digest("a"), 1)
          const provenance: ClaimProvenance = {
            snapshotId: snapshot.id,
            commitId: revision.commitId,
            sourceDigest: digest("a"),
            logicalSessionId: "session-a",
            indexGenerationId: snapshot.indexGenerationId,
            canonicalViewId: snapshot.canonicalViewId
          }
          yield* Effect.sync(() => {
            script.setEvidencePaths([
              evidencePath(
                ckey,
                revision.commitId,
                "session-a",
                digest("a"),
                1,
                turnKey,
                snapshotEvidenceKey(scopeMem, snapshot.id, revision.commitId, 1)
              )
            ])
            script.turns.set(turnKey, turnRow(1))
          })
          const reader = yield* Reader
          const spans = yield* reader.hydrate(query, [evidenceClaim(ckey, 1, 4, 12, provenance)])
          return { spans, snapshot, revision, turnKey }
        }),
        readerLayers(script)
      )
    )

    expect(outcome.spans).toHaveLength(1)
    expect(outcome.spans[0]?.excerpt).toContain("mortgage")
    expect(outcome.spans[0]).toMatchObject({
      provenance: {
        snapshotId: outcome.snapshot.id,
        commitId: outcome.revision.commitId,
        sourceDigest: digest("a"),
        logicalSessionId: "session-a",
        sourceTurnKey: outcome.turnKey
      }
    })
    expect(outcome.spans[0]?.excerpt).not.toContain("DERIVED")
  })

  it("rejects a locator that disagrees with the candidate's provenance", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const revision = yield* commitRevision(manifest, "session-a", digest("a"))
          yield* seedManifest(manifest)
          const snapshot = snapshotFor([revision.commitId])
          yield* registerActive(manifest, snapshot, 1, null)
          const query = yield* resolveQueryContext({
            principal: principalFor(scope.tenant),
            requestedUid: scope.uid
          })
          const scopeMem = memoryScope(scope.tenant, scope.uid)
          const ckey = snapshotClaimKey(scopeMem, snapshot.id, revision.commitId, "claim-digest")
          const turnKey = sourceTurnKey(scopeMem, "session-a", digest("a"), 1)
          const provenance: ClaimProvenance = {
            snapshotId: snapshot.id,
            commitId: "commit-disagree",
            sourceDigest: digest("a"),
            logicalSessionId: "session-a",
            indexGenerationId: snapshot.indexGenerationId,
            canonicalViewId: snapshot.canonicalViewId
          }
          yield* Effect.sync(() => {
            script.setEvidencePaths([
              evidencePath(
                ckey,
                revision.commitId,
                "session-a",
                digest("a"),
                1,
                turnKey,
                snapshotEvidenceKey(scopeMem, snapshot.id, revision.commitId, 1)
              )
            ])
            script.turns.set(turnKey, turnRow(1))
          })
          const reader = yield* Reader
          return yield* Effect.result(reader.hydrate(query, [evidenceClaim(ckey, 1, 4, 12, provenance)]))
        }),
        readerLayers(script)
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphMismatch", reason: "evidenceMismatch" }
    })
  })

  it("rejects a source turn row from another tenant", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const revision = yield* commitRevision(manifest, "session-a", digest("a"))
          yield* seedManifest(manifest)
          const snapshot = snapshotFor([revision.commitId])
          yield* registerActive(manifest, snapshot, 1, null)
          const query = yield* resolveQueryContext({
            principal: principalFor(scope.tenant),
            requestedUid: scope.uid
          })
          const scopeMem = memoryScope(scope.tenant, scope.uid)
          const ckey = snapshotClaimKey(scopeMem, snapshot.id, revision.commitId, "claim-digest")
          const turnKey = sourceTurnKey(scopeMem, "session-a", digest("a"), 1)
          const provenance: ClaimProvenance = {
            snapshotId: snapshot.id,
            commitId: revision.commitId,
            sourceDigest: digest("a"),
            logicalSessionId: "session-a",
            indexGenerationId: snapshot.indexGenerationId,
            canonicalViewId: snapshot.canonicalViewId
          }
          yield* Effect.sync(() => {
            script.setEvidencePaths([
              evidencePath(
                ckey,
                revision.commitId,
                "session-a",
                digest("a"),
                1,
                turnKey,
                snapshotEvidenceKey(scopeMem, snapshot.id, revision.commitId, 1)
              )
            ])
            script.turns.set(turnKey, turnRow(1, { tenant: "tenant-b" }))
          })
          const reader = yield* Reader
          return yield* Effect.result(reader.hydrate(query, [evidenceClaim(ckey, 1, 4, 12, provenance)]))
        }),
        readerLayers(script)
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotGraphMismatch", reason: "sourceTurnMismatch" }
    })
  })

  it("rejects evidence with no snapshot provenance at all", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const revision = yield* commitRevision(manifest, "session-a", digest("a"))
          yield* seedManifest(manifest)
          const snapshot = snapshotFor([revision.commitId])
          yield* registerActive(manifest, snapshot, 1, null)
          const query = yield* resolveQueryContext({
            principal: principalFor(scope.tenant),
            requestedUid: scope.uid
          })
          const scopeMem = memoryScope(scope.tenant, scope.uid)
          const ckey = snapshotClaimKey(scopeMem, snapshot.id, revision.commitId, "claim-digest")
          const reader = yield* Reader
          return yield* Effect.result(reader.hydrate(query, [evidenceClaim(ckey, 1, 4, 12)]))
        }),
        readerLayers(script)
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotScopeViolation", reason: "missingProvenance" }
    })
  })

  it("rejects evidence provenanced to another snapshot", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const revision = yield* commitRevision(manifest, "session-a", digest("a"))
          yield* seedManifest(manifest)
          const snapshot = snapshotFor([revision.commitId])
          yield* registerActive(manifest, snapshot, 1, null)
          const query = yield* resolveQueryContext({
            principal: principalFor(scope.tenant),
            requestedUid: scope.uid
          })
          const scopeMem = memoryScope(scope.tenant, scope.uid)
          const ckey = snapshotClaimKey(scopeMem, snapshot.id, revision.commitId, "claim-digest")
          const reader = yield* Reader
          return yield* Effect.result(
            reader.hydrate(query, [
              evidenceClaim(ckey, 1, 4, 12, {
                snapshotId: "snapshot-superseded",
                commitId: revision.commitId,
                sourceDigest: digest("a"),
                logicalSessionId: "session-a",
                indexGenerationId: snapshot.indexGenerationId,
                canonicalViewId: snapshot.canonicalViewId
              })
            ])
          )
        }),
        readerLayers(script)
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotScopeViolation", reason: "foreignSnapshot" }
    })
  })
})
