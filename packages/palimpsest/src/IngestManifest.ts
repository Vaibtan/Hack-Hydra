import { Config, Context, Effect, Layer } from "effect"
import type { NumericIdForKey } from "@palimpsest/hydra"
import { createArtifactOperations, type ArtifactOperations } from "./IngestManifest/Artifacts.js"
import { createCanonicalViewOperations, type CanonicalViewOperations } from "./IngestManifest/CanonicalView.js"
import { createEnrichmentOperations, type EnrichmentOperations } from "./IngestManifest/Enrichments.js"
import { createGenerationOperations, type GenerationOperations } from "./IngestManifest/Generations.js"
import { createGraphClaimOperations, type GraphClaimOperations } from "./IngestManifest/GraphClaims.js"
import { createProjectionOperations, type ProjectionOperations } from "./IngestManifest/Projection.js"
import { createRevisionOperations, type RevisionOperations } from "./IngestManifest/Revisions.js"
import { createDatabase } from "./IngestManifest/Schema.js"
import { createSnapshotOperations, type SnapshotOperations } from "./IngestManifest/Snapshots.js"
import { IngestManifestUnavailable } from "./IngestManifest/Types.js"

export {
  EntityCanonicalViewConflict,
  EntityCanonicalViewNotFound,
  ExtractionArtifactBindingMismatch,
  ExtractionArtifactConflict,
  ExtractionArtifactStateInvalid,
  GraphIdCollision,
  GraphIdRecoveryRejected,
  INGEST_STATES,
  IndexGenerationConflict,
  IndexGenerationExtractionNotFound,
  IndexGenerationNotFound,
  IngestManifestUnavailable,
  IngestRevisionBlocked,
  InvalidGraphIdClaim,
  InvalidIngestTransition,
  InvalidProjectionDelta,
  InvalidSnapshotTransition,
  InvalidSnapshotUpdate,
  InvalidSourceRevision,
  InvalidSupersessionDecisions,
  ProjectionDeltaConflict,
  ProjectionVersionConflict,
  SNAPSHOT_STATES,
  SnapshotActivePointerConflict,
  SnapshotActivationConflict,
  SnapshotRevisionCoverageMismatch,
  SnapshotRevisionNotCommitted,
  SnapshotScopeMismatch,
  SnapshotVerificationConflict,
  SupersessionDecisionConflict,
  UserIndexSnapshotBindingMismatch,
  UserIndexSnapshotConflict,
  UserIndexSnapshotNotFound
} from "./IngestManifest/Types.js"
export type {
  ActivateEntityCanonicalView,
  ActivateIndexGeneration,
  ActivateIndexSnapshot,
  ActiveIndexSnapshot,
  AdvanceIngestState,
  ApplyProjectionDelta,
  BeginSourceRevision,
  BeginSourceRevisionResult,
  ClaimGraphId,
  CommitAndActivateIndexSnapshot,
  CompleteGraphIdRekey,
  EntityCanonicalViewScope,
  ExtractionGenerationReference,
  FailUserIndexSnapshot,
  GraphIdClaim,
  GraphIdClaimDisposition,
  GraphIdKind,
  GraphIdQuarantineRecord,
  IndexGenerationScope,
  IngestManifestError,
  IngestState,
  ProjectionCounts,
  ProjectionReconciliation,
  ProjectionState,
  RecordIngestFailure,
  RegisterUserIndexSnapshot,
  SnapshotProjectionCounts,
  SnapshotState,
  SourceRevision,
  SourceRevisionIdentity,
  SourceRevisionScope,
  StoreEntityCanonicalView,
  StoreExtractionArtifact,
  StoreIndexGeneration,
  StoreSupersessionDecisions,
  SupersessionDecisionLink,
  SupersessionDecisions,
  SupersessionLinkEndpoint,
  UserIndexSnapshotRecord,
  UserIndexSnapshotScope,
  VerifyUserIndexSnapshot
} from "./IngestManifest/Types.js"
export type { EnrichmentOperations } from "./IngestManifest/Enrichments.js"
export type { GraphClaimOperations } from "./IngestManifest/GraphClaims.js"
export type { SnapshotOperations } from "./IngestManifest/Snapshots.js"
export { createUserIndexSnapshot, InvalidUserIndexSnapshot, parseUserIndexSnapshot } from "./UserIndexSnapshot.js"
export type { CreateUserIndexSnapshot, UserIndexSnapshot, UserIndexSnapshotDescriptor } from "./UserIndexSnapshot.js"

/** Transactional authority for source-revision state, per-user order, projections, generations, canonical views and index snapshots. */
export interface IngestManifestService
  extends RevisionOperations,
    ArtifactOperations,
    ProjectionOperations,
    GenerationOperations,
    CanonicalViewOperations,
    EnrichmentOperations,
    GraphClaimOperations,
    SnapshotOperations {}

const makeService = (path: string, numericIdForKey?: NumericIdForKey) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => createDatabase(path),
      catch: (cause) => new IngestManifestUnavailable({ operation: "open", cause })
    }),
    (database) => Effect.sync(() => database.close())
  ).pipe(
    Effect.map((database) => ({
      ...createRevisionOperations(database),
      ...createArtifactOperations(database),
      ...createProjectionOperations(database),
      ...createGenerationOperations(database),
      ...createCanonicalViewOperations(database),
      ...createEnrichmentOperations(database),
      ...createGraphClaimOperations(database, numericIdForKey),
      ...createSnapshotOperations(database)
    }))
  )

export class IngestManifest extends Context.Service<
  IngestManifest,
  IngestManifestService
>()("palimpsest/IngestManifest") {}

export const IngestManifestLive = Layer.effect(
  IngestManifest,
  Config.string("PALIMPSEST_INGEST_MANIFEST_PATH").pipe(
    Config.withDefault(".palimpsest/ingest-manifest.sqlite"),
    Effect.flatMap(makeService)
  )
)

export const IngestManifestLayerMemory = Layer.effect(IngestManifest, makeService(":memory:"))

/** Build an isolated manifest layer with a deterministic graph-id reducer for collision tests. */
export const makeIngestManifestTestLayer = (numericIdForKey: NumericIdForKey) =>
  Layer.effect(IngestManifest, makeService(":memory:", numericIdForKey))
