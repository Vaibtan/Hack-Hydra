import { Config, Context, Effect, Layer } from "effect"
import type { NumericIdForKey } from "@palimpsest/hydra"
import { makeArtifactOperations, type ArtifactOperations } from "./IngestManifest/Artifacts.js"
import { makeCanonicalViewOperations, type CanonicalViewOperations } from "./IngestManifest/CanonicalView.js"
import { makeGenerationOperations, type GenerationOperations } from "./IngestManifest/Generations.js"
import { makeGraphClaimOperations, type GraphClaimOperations } from "./IngestManifest/GraphClaims.js"
import { makeProjectionOperations, type ProjectionOperations } from "./IngestManifest/Projection.js"
import { makeRevisionOperations, type RevisionOperations } from "./IngestManifest/Revisions.js"
import { createDatabase } from "./IngestManifest/Schema.js"
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
  InvalidSourceRevision,
  ProjectionDeltaConflict,
  ProjectionVersionConflict
} from "./IngestManifest/Types.js"
export type {
  ActivateEntityCanonicalView,
  ActivateIndexGeneration,
  AdvanceIngestState,
  ApplyProjectionDelta,
  BeginSourceRevision,
  BeginSourceRevisionResult,
  ClaimGraphId,
  CompleteGraphIdRekey,
  EntityCanonicalViewScope,
  ExtractionGenerationReference,
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
  SourceRevision,
  SourceRevisionIdentity,
  StoreEntityCanonicalView,
  StoreExtractionArtifact,
  StoreIndexGeneration
} from "./IngestManifest/Types.js"
export type { GraphClaimOperations } from "./IngestManifest/GraphClaims.js"

/** Transactional authority for source-revision state, per-user order, projections, generations and canonical views. */
export interface IngestManifestService
  extends RevisionOperations,
    ArtifactOperations,
    ProjectionOperations,
    GenerationOperations,
    CanonicalViewOperations,
    GraphClaimOperations {}

const makeService = (path: string, numericIdForKey?: NumericIdForKey) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => createDatabase(path),
      catch: (cause) => new IngestManifestUnavailable({ operation: "open", cause })
    }),
    (database) => Effect.sync(() => database.close())
  ).pipe(
    Effect.map((database) => ({
      ...makeRevisionOperations(database),
      ...makeArtifactOperations(database),
      ...makeProjectionOperations(database),
      ...makeGenerationOperations(database),
      ...makeCanonicalViewOperations(database),
      ...makeGraphClaimOperations(database, numericIdForKey)
    }))
  )

export class IngestManifest extends Context.Tag("palimpsest/IngestManifest")<
  IngestManifest,
  IngestManifestService
>() {}

export const IngestManifestLive = Layer.scoped(
  IngestManifest,
  Config.string("PALIMPSEST_INGEST_MANIFEST_PATH").pipe(
    Config.withDefault(".palimpsest/ingest-manifest.sqlite"),
    Effect.flatMap(makeService)
  )
)

export const IngestManifestLayerMemory = Layer.scoped(IngestManifest, makeService(":memory:"))

/** Build an isolated manifest layer with a deterministic graph-id reducer for collision tests. */
export const makeIngestManifestTestLayer = (numericIdForKey: NumericIdForKey) =>
  Layer.scoped(IngestManifest, makeService(":memory:", numericIdForKey))
