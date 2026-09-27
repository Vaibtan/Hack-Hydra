import type { DatasetSession } from "@palimpsest/dataset"
import { HydraMemory, type HydraError } from "@palimpsest/hydra"
import { Data, Effect } from "effect"
import type { InvalidEntityCanonicalView } from "./EntityCanonicalView.js"
import { createEntityCanonicalView } from "./EntityCanonicalView.js"
import type { ExtractionArtifact, PersistedSessionExtraction } from "./ExtractionArtifact.js"
import { claimIndexGraphWritePlan, claimSourceTranscriptPlan } from "./GraphIdClaims.js"
import { IndexGraph, IndexGraphWriteRejected, planIndexGraphWrite } from "./IndexGraph.js"
import type { IndexGeneration } from "./IndexGeneration.js"
import {
  IngestManifest,
  type ActiveIndexSnapshot,
  type BeginSourceRevision,
  type IngestManifestError,
  type IngestManifestService,
  type SourceRevision
} from "./IngestManifest.js"
import { MANIFEST_SCHEMA_VERSION } from "./IngestManifest/Schema.js"
import { InvalidMemoryScope, parseMemoryScope, type MemoryScope } from "./MemoryScope.js"
import {
  SnapshotGraph,
  SnapshotGraphBuildRejected,
  SnapshotGraphPlanRejected,
  SnapshotGraphVerifyRejected,
  type SnapshotCausalLink
} from "./SnapshotGraph.js"
import { createUserIndexSnapshot, type InvalidUserIndexSnapshot } from "./UserIndexSnapshot.js"
import { SourceTranscript, SourceTranscriptRevisionMismatch, planSourceTranscriptWrite } from "./SourceTranscript.js"
import {
  collectEntityIdentities,
  collectSupersessionChains,
  matchKeyEquivalences,
  pairsToDecisionLinks,
  type SupersessionChain,
  type SupersessionChainSource,
  type SupersessionIndexPair
} from "./SupersessionDecision.js"
import {
  IngestRetryBlocked,
  IngestStageFailed,
  runTransactionalIngestToStage,
  type IngestExecutionStage,
  type IngestFailure,
  type TransactionalIngestStageResult,
  type TransactionalIngestStages
} from "./TransactionalIngest.js"
import { IngestCommitLock, type IngestCommitLockUnavailable } from "./IngestCommitLock.js"
import { createExtractionArtifact } from "./ExtractionArtifact.js"

export class SourceIndexGenerationMismatch extends Data.TaggedError("SourceIndexGenerationMismatch")<{
  readonly sourceExtractionGeneration: string
  readonly indexExtractionGeneration: string
}> {
  override get message(): string {
    return "Source revision and index generation name different extraction generations"
  }
}

export class SourceIndexTargetExceeded extends Data.TaggedError("SourceIndexTargetExceeded")<{
  readonly stage: "ENRICHED" | "CONSOLIDATED" | "COMMITTED"
}> {
  override get message(): string {
    return `Source/index operation cannot execute ${this.stage}`
  }
}

/** A lifecycle invariant broke inside enrichment/consolidation/commit — durable state is inconsistent, not merely failed. */
export class SourceLifecycleRejected extends Data.TaggedError("SourceLifecycleRejected")<{
  readonly reason: "missingExtractionArtifact" | "activePointerMismatch"
  readonly commitId: string | null
  readonly snapshotId: string | null
}> {
  override get message(): string {
    return `Source lifecycle rejected: ${this.reason} (commit ${this.commitId ?? "none"}, snapshot ${this.snapshotId ?? "none"})`
  }
}

/** Every failure a stage can hand to `classifyFailure`. */
export type SourceIndexStageError<Error> =
  | Error
  | HydraError
  | IngestManifestError
  | SourceTranscriptRevisionMismatch
  | IndexGraphWriteRejected
  | SourceIndexTargetExceeded
  | SourceLifecycleRejected
  | InvalidEntityCanonicalView
  | InvalidUserIndexSnapshot
  | SnapshotGraphPlanRejected
  | SnapshotGraphBuildRejected
  | SnapshotGraphVerifyRejected

export interface RunTransactionalSourceIndex<Error, Requirements> {
  readonly sourceRevision: BeginSourceRevision
  readonly indexGeneration: IndexGeneration
  readonly session: DatasetSession
  readonly extract: (
    session: DatasetSession
  ) => Effect.Effect<PersistedSessionExtraction, Error, Requirements>
  readonly classifyFailure: (input: {
    readonly stage: IngestExecutionStage
    readonly error: SourceIndexStageError<Error>
  }) => IngestFailure
}

export interface RunTransactionalSourceCommit<Error, Requirements>
  extends RunTransactionalSourceIndex<Error, Requirements> {
  /** Decides replacement pairs inside one contested slot chain; completed calls are checkpointed by chain before the next call. */
  readonly decideSupersession: (
    chain: SupersessionChain
  ) => Effect.Effect<ReadonlyArray<SupersessionIndexPair>, Error, Requirements>
}

export interface TransactionalSourceCommitResult {
  readonly revision: SourceRevision
  readonly alreadyCommitted: boolean
  /** The active snapshot's id after the commit read-back, or null when none is active. */
  readonly snapshotId: string | null
  /** True only when the post-commit read-back shows the active pointer covering this revision. */
  readonly queryVisible: boolean
}

/** Errors the consolidate/commit path can produce outside per-stage classification. */
export type SourceCommitError =
  | HydraError
  | IngestManifestError
  | InvalidEntityCanonicalView
  | InvalidUserIndexSnapshot
  | SnapshotGraphPlanRejected
  | SnapshotGraphBuildRejected
  | SnapshotGraphVerifyRejected
  | SourceLifecycleRejected

interface ConsolidatedScope {
  readonly snapshotId: string
  readonly coveredCommitIds: ReadonlyArray<string>
}

const targetExceeded = (
  stage: "ENRICHED" | "CONSOLIDATED" | "COMMITTED"
): Effect.Effect<never, SourceIndexTargetExceeded> =>
  Effect.fail(new SourceIndexTargetExceeded({ stage }))

const scopeInput = (scope: MemoryScope) => ({ tenant: scope.tenantId, uid: scope.uid })

const checkGeneration = <Error, Requirements>(input: RunTransactionalSourceIndex<Error, Requirements>) =>
  input.sourceRevision.extractionGeneration.id === input.indexGeneration.extractionGenerationId
    ? Effect.void
    : Effect.fail(
        new SourceIndexGenerationMismatch({
          sourceExtractionGeneration: input.sourceRevision.extractionGeneration.id,
          indexExtractionGeneration: input.indexGeneration.extractionGenerationId
        })
      )

const indexStages = <Error, Requirements>(
  input: RunTransactionalSourceIndex<Error, Requirements>,
  manifest: IngestManifestService,
  sourceTranscript: SourceTranscript,
  indexGraph: IndexGraph,
  hydra: HydraMemory
): Pick<
  TransactionalIngestStages<SourceIndexStageError<Error>, Requirements | IngestManifest>,
  "SOURCE_DURABLE" | "INDEXED"
> => ({
  SOURCE_DURABLE: (revision) =>
    Effect.gen(function* () {
      // Durable id claims precede the upsert (S01): a retry re-claims
      // idempotently, a collision fails before ambiguous data is written.
      const transcriptPlan = planSourceTranscriptWrite(revision, input.session)
      if (transcriptPlan._tag === "Failure") return yield* Effect.fail(transcriptPlan.failure)
      yield* claimSourceTranscriptPlan(manifest, hydra, transcriptPlan.success)
      return yield* sourceTranscript.write(revision, input.session)
    }),
  INDEXED: (revision) =>
    Effect.gen(function* () {
      const existing = yield* manifest.readExtractionArtifact(revision)
      const artifact: ExtractionArtifact =
        existing ??
        (yield* input.extract(input.session).pipe(
          Effect.flatMap((extraction) =>
            manifest.storeExtractionArtifact({
              revision,
              artifact: createExtractionArtifact({
                commitId: revision.commitId,
                sourceDigest: revision.sourceDigest,
                extractionGeneration: revision.extractionGeneration,
                extraction: {
                  sid: input.session.sid,
                  sessionOrd: revision.sessionOrdinal,
                  claims: extraction.claims,
                  dropped: extraction.dropped
                }
              })
            })
          )
        ))
      const indexPlan = planIndexGraphWrite({
        generation: input.indexGeneration,
        revision,
        session: input.session,
        claims: artifact.extraction.claims
      })
      if (indexPlan._tag === "Failure") return yield* Effect.fail(indexPlan.failure)
      yield* claimIndexGraphWritePlan(manifest, hydra, indexPlan.success)
      return yield* indexGraph.write({
        generation: input.indexGeneration,
        revision,
        session: input.session,
        claims: artifact.extraction.claims
      })
    })
})

/** Drives a source revision through SOURCE_DURABLE and INDEXED only; later stages are refused. */
export const runTransactionalSourceIndex = <Error, Requirements>(
  input: RunTransactionalSourceIndex<Error, Requirements>
): Effect.Effect<
  TransactionalIngestStageResult,
  | SourceIndexGenerationMismatch
  | IngestManifestError
  | IngestStageFailed
  | IngestRetryBlocked
  | IngestCommitLockUnavailable,
  Requirements | SourceTranscript | IndexGraph | IngestManifest | IngestCommitLock | HydraMemory
> =>
  Effect.gen(function* () {
    yield* checkGeneration(input)
    const manifest = yield* IngestManifest
    yield* manifest.begin(input.sourceRevision)
    yield* manifest.storeIndexGeneration({ generation: input.indexGeneration })
    const sourceTranscript = yield* SourceTranscript
    const indexGraph = yield* IndexGraph
    const hydra = yield* HydraMemory
    const stages: TransactionalIngestStages<SourceIndexStageError<Error>, Requirements | IngestManifest> = {
      ...indexStages(input, manifest, sourceTranscript, indexGraph, hydra),
      ENRICHED: () => targetExceeded("ENRICHED"),
      CONSOLIDATED: () => targetExceeded("CONSOLIDATED"),
      COMMITTED: () => targetExceeded("COMMITTED")
    }
    return yield* runTransactionalIngestToStage({
      sourceRevision: input.sourceRevision,
      target: "INDEXED",
      stages,
      classifyFailure: input.classifyFailure
    })
  })

// ---------------------------------------------------------------------------
// S04 lifecycle: ENRICHED (per-revision supersession decisions), CONSOLIDATED
// (per-user canonical view + registered, verified snapshot), COMMITTED
// (atomic manifest commit + activation compare-and-swap).
// ---------------------------------------------------------------------------

/**
 * The coverage set for per-user consolidation: every committed revision, every
 * consolidated revision still committable (no non-retryable failure), plus any
 * in-flight revision the caller names — the revision running its own
 * CONSOLIDATED stage is still ENRICHED when it calls this.
 */
const coveredRevisions = (
  revisions: ReadonlyArray<SourceRevision>,
  includeCommitIds: ReadonlyArray<string>
): ReadonlyArray<SourceRevision> => {
  const include = new Set(includeCommitIds)
  return revisions.filter(
    (revision) =>
      revision.state === "COMMITTED" ||
      (revision.state === "CONSOLIDATED" && revision.failureRetryable !== false) ||
      include.has(revision.commitId)
  )
}

/**
 * Fold every covered revision into a fresh canonical view, register the
 * covering snapshot, build its graph, and verify it by read-back. Purely
 * idempotent: equal inputs re-derive the same view/snapshot ids and `build`
 * returns the already-verified record.
 */
const consolidateScope = (
  scope: MemoryScope,
  indexGeneration: IndexGeneration,
  includeCommitIds: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const manifest = yield* IngestManifest
    const revisions = yield* manifest.listScopeRevisions(scopeInput(scope))
    const covered = coveredRevisions(revisions, includeCommitIds)
    if (covered.length === 0) return null

    const sources: Array<SupersessionChainSource> = []
    for (const revision of covered) {
      const artifact = yield* manifest.readExtractionArtifact(revision)
      if (artifact === null) {
        return yield* Effect.fail(
          new SourceLifecycleRejected({
            reason: "missingExtractionArtifact",
            commitId: revision.commitId,
            snapshotId: null
          })
        )
      }
      sources.push({ revision, artifact })
    }

    const identities = collectEntityIdentities(sources)
    const view = createEntityCanonicalView({
      identities: [...identities.entries()].map(([id, entity]) => ({
        id,
        canon: entity.canon,
        etype: entity.etype
      })),
      equivalences: matchKeyEquivalences(identities)
    })
    if (view._tag === "Failure") return yield* Effect.fail(view.failure)
    yield* manifest.storeEntityCanonicalView({ ...scopeInput(scope), view: view.success })
    yield* manifest.storeIndexGeneration({ generation: indexGeneration })

    const coveredCommitIds = covered.map((revision) => revision.commitId)
    const snapshot = createUserIndexSnapshot({
      scope,
      indexGenerationId: indexGeneration.id,
      canonicalViewId: view.success.id,
      sourceCommitIds: coveredCommitIds,
      manifestSchemaVersion: MANIFEST_SCHEMA_VERSION
    })
    if (snapshot._tag === "Failure") return yield* Effect.fail(snapshot.failure)
    yield* manifest.registerUserIndexSnapshot({ snapshot: snapshot.success })

    const coveredIds = new Set(coveredCommitIds)
    const causalLinks: Array<SnapshotCausalLink> = []
    for (const revision of covered) {
      const decisions = yield* manifest.readSupersessionDecisions(revision)
      if (decisions === null) continue
      for (const link of decisions.links) {
        if (coveredIds.has(link.older.commitId) && coveredIds.has(link.newer.commitId)) {
          causalLinks.push(link)
        }
      }
    }

    const snapshotGraph = yield* SnapshotGraph
    yield* snapshotGraph.build({ snapshotId: snapshot.success.id, causalLinks })
    return { snapshotId: snapshot.success.id, coveredCommitIds } satisfies ConsolidatedScope
  })

/**
 * The terminal commit for one scope: consolidate the current coverage, then run
 * the atomic manifest transaction that commits pending CONSOLIDATED revisions
 * and moves the active pointer, then read the pointer back. Returns the active
 * pointer's record (null when the scope has never activated). Callers inside
 * the stage loop hold the per-user lock already; the exported `commitScope`
 * entry acquires it.
 */
const commitScopeInternal = (scope: MemoryScope, indexGeneration: IndexGeneration) =>
  Effect.gen(function* () {
    const manifest = yield* IngestManifest
    const revisions = yield* manifest.listScopeRevisions(scopeInput(scope))
    const pendingCommit = revisions.some(
      (revision) => revision.state === "CONSOLIDATED" && revision.failureRetryable !== false
    )
    const active = yield* manifest.readActiveIndexSnapshot(scopeInput(scope))
    const coveredIds = active?.record.snapshot.sourceCommitIds ?? []
    const uncoveredCommitted = revisions.some(
      (revision) => revision.state === "COMMITTED" && !coveredIds.includes(revision.commitId)
    )
    if (!pendingCommit && !uncoveredCommitted) return active

    const consolidated = yield* consolidateScope(scope, indexGeneration, [])
    if (consolidated === null) return active
    const expectedManifestVersion = yield* manifest.readManifestVersion(scopeInput(scope))
    yield* manifest.commitAndActivateIndexSnapshot({
      ...scopeInput(scope),
      snapshotId: consolidated.snapshotId,
      expectedManifestVersion,
      expectedActiveSnapshotId: active?.record.snapshot.id ?? null
    })
    const readBack = yield* manifest.readActiveIndexSnapshot(scopeInput(scope))
    if (readBack === null || readBack.record.snapshot.id !== consolidated.snapshotId) {
      return yield* Effect.fail(
        new SourceLifecycleRejected({
          reason: "activePointerMismatch",
          commitId: null,
          snapshotId: consolidated.snapshotId
        })
      )
    }
    return readBack
  })

export interface CommitScopeInput {
  readonly tenant: string
  readonly uid: string
  readonly indexGeneration: IndexGeneration
}

/**
 * Repair/report entry: converge a scope's pending consolidated revisions to
 * COMMITTED and activate the covering snapshot, under the per-user commit
 * lock. Idempotent — returns the active pointer unchanged when nothing is
 * pending and coverage is already complete.
 */
export const commitScope = (
  input: CommitScopeInput
): Effect.Effect<
  ActiveIndexSnapshot | null,
  | InvalidMemoryScope
  | IngestCommitLockUnavailable
  | SourceCommitError,
  IngestManifest | IngestCommitLock | SnapshotGraph
> =>
  Effect.gen(function* () {
    const parsed = parseMemoryScope(input.tenant, input.uid)
    if (parsed._tag === "Failure") return yield* Effect.fail(parsed.failure)
    const commitLock = yield* IngestCommitLock
    return yield* commitLock.withUserLock(
      { tenant: input.tenant, uid: input.uid },
      commitScopeInternal(parsed.success, input.indexGeneration)
    )
  })

/** Drives a source revision through the full S04 lifecycle to COMMITTED with atomic activation. */
export const runTransactionalSourceCommit = <Error, Requirements>(
  input: RunTransactionalSourceCommit<Error, Requirements>
): Effect.Effect<
  TransactionalSourceCommitResult,
  | SourceIndexGenerationMismatch
  | InvalidMemoryScope
  | IngestStageFailed
  | IngestRetryBlocked
  | IngestCommitLockUnavailable
  | SourceCommitError,
  | Requirements
  | SourceTranscript
  | IndexGraph
  | SnapshotGraph
  | IngestManifest
  | IngestCommitLock
  | HydraMemory
> =>
  Effect.gen(function* () {
    yield* checkGeneration(input)
    const parsedScope = parseMemoryScope(input.sourceRevision.tenant, input.sourceRevision.uid)
    if (parsedScope._tag === "Failure") return yield* Effect.fail(parsedScope.failure)
    const scope = parsedScope.success
    const manifest = yield* IngestManifest
    yield* manifest.begin(input.sourceRevision)
    yield* manifest.storeIndexGeneration({ generation: input.indexGeneration })
    const sourceTranscript = yield* SourceTranscript
    const indexGraph = yield* IndexGraph
    const snapshotGraph = yield* SnapshotGraph
    const hydra = yield* HydraMemory

    const stages: TransactionalIngestStages<
      SourceIndexStageError<Error>,
      Requirements | IngestManifest | SnapshotGraph
    > = {
      ...indexStages(input, manifest, sourceTranscript, indexGraph, hydra),
      ENRICHED: (revision) =>
        Effect.gen(function* () {
          const existing = yield* manifest.readSupersessionDecisions(revision)
          if (existing !== null) return
          const artifact = yield* manifest.readExtractionArtifact(revision)
          if (artifact === null) {
            return yield* Effect.fail(
              new SourceLifecycleRejected({
                reason: "missingExtractionArtifact",
                commitId: revision.commitId,
                snapshotId: null
              })
            )
          }
          const revisions = yield* manifest.listScopeRevisions(scopeInput(scope))
          const chainSources: Array<SupersessionChainSource> = []
          for (const candidate of revisions) {
            if (candidate.sessionOrdinal > revision.sessionOrdinal) continue
            if (candidate.failureRetryable === false) continue
            if (candidate.state === "RECEIVED" || candidate.state === "SOURCE_DURABLE") continue
            const candidateArtifact = yield* manifest.readExtractionArtifact(candidate)
            if (candidateArtifact === null) {
              return yield* Effect.fail(
                new SourceLifecycleRejected({
                  reason: "missingExtractionArtifact",
                  commitId: candidate.commitId,
                  snapshotId: null
                })
              )
            }
            chainSources.push({ revision: candidate, artifact: candidateArtifact })
          }
          const chains = collectSupersessionChains(chainSources, revision.commitId)
          const decided: Array<ReadonlyArray<SnapshotCausalLink>> = []
          for (const chain of chains) {
            const stored = yield* manifest.readSupersessionChainDecisions(revision, chain.id)
            if (stored !== null) {
              decided.push(stored.links)
              continue
            }
            const pairs = yield* input.decideSupersession(chain)
            const chainDecisions = yield* manifest.storeSupersessionChainDecisions({
              revision,
              chainId: chain.id,
              links: pairsToDecisionLinks(chain, pairs)
            })
            decided.push(chainDecisions.links)
          }
          yield* manifest.storeSupersessionDecisions({ revision, links: decided.flat() })
        }),
      CONSOLIDATED: (revision) =>
        consolidateScope(scope, input.indexGeneration, [revision.commitId]).pipe(Effect.asVoid),
      COMMITTED: () => commitScopeInternal(scope, input.indexGeneration).pipe(Effect.asVoid)
    }
    const stageResult = yield* runTransactionalIngestToStage({
      sourceRevision: input.sourceRevision,
      target: "COMMITTED",
      stages,
      classifyFailure: input.classifyFailure
    })

    // Post-loop repair/report: also covers the already-committed entry path,
    // where no stage callback ran and a stale uncovered commit is converged.
    const active = yield* commitScope({
      tenant: input.sourceRevision.tenant,
      uid: input.sourceRevision.uid,
      indexGeneration: input.indexGeneration
    }).pipe(
      Effect.provideService(SnapshotGraph, snapshotGraph)
    )
    const commitId = stageResult.revision.commitId
    return {
      revision: stageResult.revision,
      alreadyCommitted: stageResult.alreadyAtTarget,
      snapshotId: active?.record.snapshot.id ?? null,
      queryVisible:
        active !== null && active.record.snapshot.sourceCommitIds.includes(commitId)
    }
  })
