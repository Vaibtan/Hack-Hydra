import {
  HydraMemory,
  type DiscoveryInput,
  type MemoryNode,
  type MemoryPath,
  type NodeLookup
} from "@palimpsest/hydra"
import { describeExecutionPlan, makeExecutionPlan } from "@palimpsest/hydra/testing"
import { Llm } from "@palimpsest/llm"
import { Effect, Layer, Option, Result } from "effect"
import { describe, expect, it } from "vitest"
import { answerInSnapshot, type SnapshotAnswerReader } from "../../src/Answer.js"
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
import { determinismHash, planFromArms } from "../../src/Plan.js"
import {
  parseQueryPrincipal,
  resolveQueryContext,
  type QueryPrincipal
} from "../../src/QueryContext.js"
import { Retrieve } from "../../src/Retrieve.js"
import { gatherInSnapshot, SnapshotSearch } from "../../src/SnapshotArms.js"
import {
  SNAPSHOT_GRAPH_FORMAT,
  snapshotClaimKey,
  snapshotRootKey,
  snapshotSlotKey
} from "../../src/SnapshotGraph.js"
import { createExtractionGeneration } from "../../src/SourceIdentity.js"
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

const UNDERSTANDING_JANUARY = { ...UNDERSTANDING, time_ref: "in january" }

const stubLlmFor = (value: typeof UNDERSTANDING | typeof UNDERSTANDING_JANUARY) =>
  Layer.succeed(Llm, behaviorFake<Llm>({
    model: "stub",
    cacheDir: "",
    concurrency: 1,
    generateObject: (options: { kind: string }) =>
      Effect.succeed({
        value: options.kind === "anchors" ? value : { keep: [] },
        cached: true,
        model: "stub",
        inputTokens: 0,
        outputTokens: 0
      }),
    usage: Effect.succeed({ inputTokens: 0, outputTokens: 0, calls: 0, cacheHits: 0 }),
    resetUsage: Effect.void
  }))

interface ClaimTemporals {
  readonly sessionDate: number
  readonly sessionOrd: number
  readonly acceptedAtMs: number
  readonly tEvent: number
  readonly tPrec: string
}

const claimNode = (
  id: number,
  ckey: string,
  commitId: string,
  logicalSessionId: string,
  sourceDigest: string,
  temporals: ClaimTemporals
): Node =>
  node(id, "SnapshotClaim", {
    snapshot_claim: ckey,
    commit_id: commitId,
    logical_session_id: logicalSessionId,
    source_digest: sourceDigest,
    text: `derived text for ${ckey}`,
    speaker: "user",
    ctype: "state",
    session_ord: temporals.sessionOrd,
    session_date: temporals.sessionDate,
    accepted_at_ms: temporals.acceptedAtMs,
    t_event: temporals.tEvent,
    t_prec: temporals.tPrec,
    sid: logicalSessionId,
    turn_idx: 1,
    cs: 0,
    ce: 5
  })

const tokenNode = (id: number, stem: string): Node =>
  node(id, "SnapshotToken", { token: stem, snapshot_token: stem, df: 2 })

const hit = (
  tokenId: number,
  claimId: number,
  stem: string,
  ckey: string,
  commitId: string,
  logicalSessionId: string,
  sourceDigest: string,
  temporals: ClaimTemporals
): MemoryPath =>
  pathOf(
    [tokenNode(tokenId, stem), claimNode(claimId, ckey, commitId, logicalSessionId, sourceDigest, temporals)],
    ["SNAPSHOT_HITS"]
  )

const rootRow = (snapshot: UserIndexSnapshot, nRevisions: number, nClaims: number): MemoryNode => ({
  id: 1,
  key: snapshotRootKey(memoryScope(scope.tenant, scope.uid), snapshot.id),
  labels: ["SnapshotRoot"],
  properties: {
    snapshot_id: snapshot.id,
    graph_format: SNAPSHOT_GRAPH_FORMAT,
    source_revisions_hash: snapshot.sourceRevisionsHash,
    n_revisions: nRevisions,
    n_claims: nClaims
  }
})

const maybe = <A>(value: A | undefined): Option.Option<A> =>
  value === undefined ? Option.none() : Option.some(value)

interface GraphScript {
  readonly roots: Map<string, MemoryNode>
  readonly convergenceBySnapshot: Map<string, ReadonlyArray<MemoryPath>>
  setFills: (paths: ReadonlyArray<MemoryPath>) => void
  setMates: (paths: ReadonlyArray<MemoryPath>) => void
  readonly layer: Layer.Layer<HydraMemory>
}

const makeScript = (): GraphScript => {
  const roots = new Map<string, MemoryNode>()
  const convergenceBySnapshot = new Map<string, ReadonlyArray<MemoryPath>>()
  let fills: ReadonlyArray<MemoryPath> = []
  let mates: ReadonlyArray<MemoryPath> = []
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
        if (config.sourceLabel === "SnapshotClaim" && config.relTypes.includes("SNAPSHOT_FILLS")) {
          return { paths: fills, plan }
        }
        if (config.sourceLabel === "SnapshotSlot") {
          return { paths: mates, plan }
        }
        return { paths: [], plan }
      }),
    describeExecutionPlan,
    resolveNode: (lookup: NodeLookup) =>
      Effect.succeed(
        lookup.label === "SnapshotRoot" ? maybe(roots.get(lookup.key)) : Option.none()
      )
  }))
  return {
    roots,
    convergenceBySnapshot,
    setFills: (paths) => {
      fills = paths
    },
    setMates: (paths) => {
      mates = paths
    },
    layer
  }
}

const layersFor = (script: GraphScript, understanding: typeof UNDERSTANDING | typeof UNDERSTANDING_JANUARY) =>
  Retrieve.layer.pipe(
    Layer.provideMerge(SnapshotSearch.layer),
    Layer.provideMerge(script.layer),
    Layer.provideMerge(IngestManifestLayerMemory),
    Layer.provideMerge(stubLlmFor(understanding))
  )

const ASK_OPTIONS = { questionDate: QUESTION_DATE, ablations: { noDiscovery: true, noSelect: true } } as const

const STEADY: ClaimTemporals = {
  sessionDate: 20230101,
  sessionOrd: 1,
  acceptedAtMs: Date.UTC(2023, 0, 1),
  tEvent: 0,
  tPrec: "none"
}

describe("temporal perspective at ask time", () => {
  it("returns different answers for recorded and valid time on a late arrival", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const revision = yield* commitRevision(manifest, "session-a", digest("a"))
          yield* seedManifest(manifest)
          const snapshot = snapshotFor([revision.commitId])
          yield* registerActive(manifest, snapshot, 1, null)
          const scopeMem = memoryScope(scope.tenant, scope.uid)
          const ckey = snapshotClaimKey(scopeMem, snapshot.id, revision.commitId, "claim-late")
          const late: ClaimTemporals = {
            sessionDate: 20230115,
            sessionOrd: 9,
            acceptedAtMs: Date.UTC(2023, 5, 1),
            tEvent: 20230115,
            tPrec: "day"
          }
          yield* Effect.sync(() => {
            script.roots.set(snapshotRootKey(scopeMem, snapshot.id), rootRow(snapshot, 1, 10))
            script.convergenceBySnapshot.set(snapshot.id, [
              hit(1, 10, "mortgage", ckey, revision.commitId, "session-a", digest("a"), late),
              hit(2, 11, "wells", ckey, revision.commitId, "session-a", digest("a"), late)
            ])
          })
          const retrieve = yield* Retrieve
          const recorded = yield* retrieve.ask(
            principalFor(scope.tenant),
            scope.uid,
            "Where was my mortgage in January?",
            ASK_OPTIONS
          )
          const valid = yield* retrieve.ask(
            principalFor(scope.tenant),
            scope.uid,
            "Where was my mortgage in January?",
            { ...ASK_OPTIONS, perspective: "valid-time" }
          )
          return { recorded, valid, snapshot, revision }
        }),
        layersFor(script, UNDERSTANDING_JANUARY)
      )
    )

    expect(outcome.recorded.verdict).toBe("ABSENT")
    expect(outcome.recorded.reason).toBe("A1_no_anchors")
    expect(outcome.recorded.plan.temporal).toMatchObject({
      perspective: "recorded-time",
      completeness: { complete: true, perspectiveFiltered: 1 }
    })
    expect(outcome.valid.verdict).toBe("ANSWER")
    expect(outcome.valid.evidence).toHaveLength(1)
    expect(outcome.valid.evidence[0]?.provenance?.snapshotId).toBe(outcome.snapshot.id)
    expect(outcome.valid.plan.temporal?.perspective).toBe("valid-time")
  })

  it("keeps an earlier recorded-time result identical after a successor activates", async () => {
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
          const ckey = snapshotClaimKey(scopeMem, snapshotA.id, first.commitId, "claim-a")
          yield* Effect.sync(() => {
            script.roots.set(snapshotRootKey(scopeMem, snapshotA.id), rootRow(snapshotA, 1, 10))
            script.convergenceBySnapshot.set(snapshotA.id, [
              hit(1, 10, "mortgage", ckey, first.commitId, "session-a", digest("a"), STEADY),
              hit(2, 11, "wells", ckey, first.commitId, "session-a", digest("a"), STEADY)
            ])
          })
          const readGrounded = (label: string) =>
            Effect.gen(function* () {
              const gathered = yield* gatherInSnapshot(hydra, context, "Where is my mortgage?", {
                questionDate: QUESTION_DATE,
                ablations: { noDiscovery: true }
              })
              const planned = planFromArms({
                ...gathered,
                temporal: {
                  perspective: context.perspective,
                  snapshotId: context.snapshot.id,
                  coverage: { revisionsCovered: 1, scopeRevisions: 1, uncommitted: 0 },
                  stats: gathered.stats,
                  upstreamFiltered: gathered.perspectiveFiltered
                }
              })
              return {
                label,
                hash: determinismHash(planned.grounded.map((candidate) => candidate.ckey)),
                scores: planned.grounded.map((candidate) => [candidate.ckey, candidate.score] as const)
              }
            })
          const before = yield* readGrounded("before")
          const second = yield* commitRevision(manifest, "session-b", digest("b"))
          const snapshotB = snapshotFor([first.commitId, second.commitId])
          yield* registerActive(manifest, snapshotB, 2, snapshotA.id)
          const after = yield* readGrounded("after")
          return { before, after }
        }),
        layersFor(script, UNDERSTANDING)
      )
    )

    expect(outcome.after.hash).toBe(outcome.before.hash)
    expect(outcome.after.scores).toEqual(outcome.before.scores)
  })

  it("declares coverage and uncommitted revisions on every answer", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const revision = yield* commitRevision(manifest, "session-a", digest("a"))
          yield* seedManifest(manifest)
          const snapshot = snapshotFor([revision.commitId])
          yield* registerActive(manifest, snapshot, 1, null)
          const scopeMem = memoryScope(scope.tenant, scope.uid)
          const ckey = snapshotClaimKey(scopeMem, snapshot.id, revision.commitId, "claim-a")
          yield* Effect.sync(() => {
            script.roots.set(snapshotRootKey(scopeMem, snapshot.id), rootRow(snapshot, 1, 10))
            script.convergenceBySnapshot.set(snapshot.id, [
              hit(1, 10, "mortgage", ckey, revision.commitId, "session-a", digest("a"), STEADY),
              hit(2, 11, "wells", ckey, revision.commitId, "session-a", digest("a"), STEADY)
            ])
          })
          const retrieve = yield* Retrieve
          const covered = yield* retrieve.ask(
            principalFor(scope.tenant),
            scope.uid,
            "Where is my mortgage?",
            ASK_OPTIONS
          )
          const pending = (
            yield* manifest.begin({
              tenant: scope.tenant,
              uid: scope.uid,
              logicalSessionId: "session-b",
              sourceDigest: digest("b"),
              sourceBytes: 100,
              extractionGeneration: { id: extraction.id, canonicalJson: extraction.canonicalJson }
            })
          ).revision
          yield* manifest.advance({ revision: pending, from: "RECEIVED", to: "SOURCE_DURABLE" })
          const partial = yield* retrieve.ask(
            principalFor(scope.tenant),
            scope.uid,
            "Where is my mortgage?",
            ASK_OPTIONS
          )
          return { covered, partial, snapshot }
        }),
        layersFor(script, UNDERSTANDING)
      )
    )

    expect(outcome.covered.plan.temporal).toMatchObject({
      watermark: "COMMITTED",
      coverage: { revisionsCovered: 1, scopeRevisions: 1, uncommitted: 0 },
      stats: { snapshotId: outcome.snapshot.id, totalClaims: 10 }
    })
    expect(outcome.partial.plan.temporal).toMatchObject({
      coverage: { revisionsCovered: 1, scopeRevisions: 2, uncommitted: 1 }
    })
    expect(outcome.partial.verdict).toBe("ANSWER")
  })
})

describe("incomplete memory", () => {
  const INCOMPLETE_FIXTURE = Effect.gen(function* () {
    const manifest = yield* IngestManifest
    const revision = yield* commitRevision(manifest, "session-a", digest("a"))
    yield* seedManifest(manifest)
    const snapshot = snapshotFor([revision.commitId])
    yield* registerActive(manifest, snapshot, 1, null)
    return { manifest, revision, snapshot }
  })

  const seedCappedExpansion = (
    script: GraphScript,
    scopeMem: MemoryScope,
    snapshot: UserIndexSnapshot,
    revision: SourceRevision
  ) =>
    Effect.sync(() => {
      const ckey1 = snapshotClaimKey(scopeMem, snapshot.id, revision.commitId, "claim-1")
      const ckey2 = snapshotClaimKey(scopeMem, snapshot.id, revision.commitId, "claim-2")
      const skey = snapshotSlotKey(scopeMem, snapshot.id, "identity-alice", "residence")
      script.roots.set(snapshotRootKey(scopeMem, snapshot.id), rootRow(snapshot, 1, 10))
      script.convergenceBySnapshot.set(snapshot.id, [
        hit(1, 10, "mortgage", ckey1, revision.commitId, "session-a", digest("a"), STEADY),
        hit(2, 11, "wells", ckey2, revision.commitId, "session-a", digest("a"), STEADY)
      ])
      script.setFills([
        pathOf(
          [node(10, "SnapshotClaim", { snapshot_claim: ckey1 }), node(20, "SnapshotSlot", { snapshot_slot: skey })],
          ["SNAPSHOT_FILLS"]
        )
      ])
      script.setMates(
        Array.from({ length: 6 }, (_, index) => {
          const mate = snapshotClaimKey(scopeMem, snapshot.id, revision.commitId, `mate-${index}`)
          return pathOf(
            [
              node(20, "SnapshotSlot", { snapshot_slot: skey }),
              claimNode(30 + index, mate, revision.commitId, "session-a", digest("a"), STEADY)
            ],
            ["SNAPSHOT_FILLS"]
          )
        })
      )
      return { ckey1, ckey2 }
    })

  it("reports INCOMPLETE instead of absence when slot expansion is capped", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const { revision, snapshot } = yield* INCOMPLETE_FIXTURE
          const scopeMem = memoryScope(scope.tenant, scope.uid)
          yield* seedCappedExpansion(script, scopeMem, snapshot, revision)
          const retrieve = yield* Retrieve
          return yield* retrieve.ask(
            principalFor(scope.tenant),
            scope.uid,
            "Where is my mortgage?",
            ASK_OPTIONS
          )
        }),
        layersFor(script, UNDERSTANDING)
      )
    )

    expect(outcome.verdict).toBe("INCOMPLETE")
    expect(outcome.reason).toBe("INCOMPLETE_MEMORY")
    expect(outcome.evidence).toEqual([])
    expect(outcome.plan.temporal?.completeness).toMatchObject({
      complete: false,
      slotMateCapped: true
    })
    expect(outcome.receipt.temporal).toEqual(outcome.plan.temporal)
  })

  it("propagates INCOMPLETE through the answer loop without reading", async () => {
    const script = makeScript()
    const outcome = await runWithBehaviorFakes(
      Effect.provide(
        Effect.gen(function* () {
          const { revision, snapshot } = yield* INCOMPLETE_FIXTURE
          const scopeMem = memoryScope(scope.tenant, scope.uid)
          yield* seedCappedExpansion(script, scopeMem, snapshot, revision)
          const retrieve = yield* Retrieve
          const reader = behaviorFake<SnapshotAnswerReader>({})
          return yield* answerInSnapshot(
            retrieve,
            reader,
            principalFor(scope.tenant),
            scope.uid,
            "Where is my mortgage?",
            QUESTION_DATE,
            { maxLen: 2, profile: "full", ablations: { noDiscovery: true, noSelect: true } }
          )
        }),
        layersFor(script, UNDERSTANDING)
      )
    )

    expect(outcome.verdict).toBe("INCOMPLETE")
    expect(outcome.reason).toBe("INCOMPLETE_MEMORY")
    expect(outcome.read).toBeNull()
    expect(outcome.ask.reason).toBe("INCOMPLETE_MEMORY")
  })
})
