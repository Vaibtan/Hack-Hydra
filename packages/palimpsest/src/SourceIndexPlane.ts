/** The Index* write plane: written by ingest, not yet read by retrieval (ADR-0002). */
export {
  InvalidMemoryScope,
  frameSegment,
  memoryScopeFromRevision,
  memoryScopeKey,
  parseMemoryScope,
  scopePrefix
} from "./MemoryScope.js"
export type { MemoryScope } from "./MemoryScope.js"
export {
  claimIndexGraphWritePlan,
  claimSourceTranscriptPlan,
  claimWriteIdentities,
  recoverGraphIdCollision,
  relationshipIdentity
} from "./GraphIdClaims.js"
export type {
  ClaimWriteIdentitiesError,
  GraphIdRekeyTarget,
  GraphWriteRelation
} from "./GraphIdClaims.js"
export {
  IndexGraph,
  IndexGraphWriteRejected,
  indexClaimKey,
  indexEntityIdentityId,
  indexEntityKey,
  indexSlotKey,
  indexTokenKey,
  planIndexGraphWrite
} from "./IndexGraph.js"
export type {
  IndexGraphRelation,
  IndexGraphVertex,
  IndexGraphWritePlan,
  IndexGraphWriteReport,
  PlanIndexGraphWrite
} from "./IndexGraph.js"
export {
  EntityNotInCanonicalView,
  InvalidEntityCanonicalView,
  createEntityCanonicalView,
  parseEntityCanonicalView,
  resolveEntityInCanonicalView,
  serializeEntityCanonicalView
} from "./EntityCanonicalView.js"
export type {
  CreateEntityCanonicalView,
  EntityCanonicalView,
  EntityEquivalence,
  EntityIdentity,
  SameAsEdge
} from "./EntityCanonicalView.js"
export { InvalidIndexGeneration, createIndexGeneration, parseIndexGeneration } from "./IndexGeneration.js"
export type { IndexGeneration, IndexGenerationInput } from "./IndexGeneration.js"
export {
  SourceTranscript,
  SourceTranscriptRevisionMismatch,
  planSourceTranscriptWrite,
  sourceSessionKey,
  sourceTurnChunkKey,
  sourceTurnKey
} from "./SourceTranscript.js"
export type {
  SourceTranscriptRelation,
  SourceTranscriptReport,
  SourceTranscriptVertex,
  SourceTranscriptWritePlan
} from "./SourceTranscript.js"
export {
  SourceIndexGenerationMismatch,
  SourceIndexTargetExceeded,
  runTransactionalSourceIndex
} from "./TransactionalSourceIndex.js"
export type { RunTransactionalSourceIndex, SourceIndexStageError } from "./TransactionalSourceIndex.js"
export {
  EntityCanonicalViewConflict,
  EntityCanonicalViewNotFound,
  IndexGenerationConflict,
  IndexGenerationExtractionNotFound,
  IndexGenerationNotFound
} from "./IngestManifest/Types.js"
export type {
  ActivateEntityCanonicalView,
  ActivateIndexGeneration,
  EntityCanonicalViewScope,
  IndexGenerationScope,
  StoreEntityCanonicalView,
  StoreIndexGeneration
} from "./IngestManifest/Types.js"
export type { CanonicalViewOperations } from "./IngestManifest/CanonicalView.js"
export type { GenerationOperations } from "./IngestManifest/Generations.js"
