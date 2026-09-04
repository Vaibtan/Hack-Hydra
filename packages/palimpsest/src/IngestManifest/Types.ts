import { Data } from "effect"
import type { EntityCanonicalView } from "../EntityCanonicalView.js"
import type { ExtractionArtifact, InvalidExtractionArtifact } from "../ExtractionArtifact.js"
import type { IndexGeneration, InvalidIndexGeneration } from "../IndexGeneration.js"
import type { UserStats } from "../User.js"

export const INGEST_STATES = [
  "RECEIVED",
  "SOURCE_DURABLE",
  "INDEXED",
  "ENRICHED",
  "CONSOLIDATED",
  "COMMITTED"
] as const

export type IngestState = (typeof INGEST_STATES)[number]

/** An extraction-generation id with the canonical descriptor bytes it names. */
export interface ExtractionGenerationReference {
  readonly id: string
  readonly canonicalJson: string
}

export interface SourceRevisionIdentity {
  readonly tenant: string
  readonly uid: string
  readonly logicalSessionId: string
  readonly sourceDigest: string
  readonly extractionGeneration: string
}

export interface BeginSourceRevision {
  readonly tenant: string
  readonly uid: string
  readonly logicalSessionId: string
  readonly sourceDigest: string
  readonly sourceBytes: number
  readonly extractionGeneration: ExtractionGenerationReference
}

export interface SourceRevision {
  readonly tenant: string
  readonly uid: string
  readonly logicalSessionId: string
  readonly sourceDigest: string
  readonly sourceBytes: number
  readonly extractionGeneration: string
  readonly sessionOrdinal: number
  readonly commitId: string
  readonly state: IngestState
  readonly manifestVersion: number
  readonly failureCode: string | null
  readonly failureRetryable: boolean | null
}

/** Commit-id-keyed delta for the rebuildable per-user projections. */
export interface ApplyProjectionDelta {
  readonly revision: SourceRevision
  readonly stats: UserStats
  readonly tokenDf: ReadonlyMap<string, number>
  readonly slotClaims: ReadonlyMap<string, number>
}

export interface ProjectionState {
  readonly tenant: string
  readonly uid: string
  readonly manifestVersion: number
  readonly lastCommitId: string | null
  readonly lastReconciledCommitId: string | null
  readonly stats: UserStats
  readonly consistency: "consistent" | "stale" | "unknown"
}

export interface ProjectionCounts {
  readonly tokenDf: ReadonlyMap<string, number>
  readonly slotClaims: ReadonlyMap<string, number>
}

export interface ProjectionReconciliation {
  readonly state: ProjectionState
  readonly outcome: "consistent" | "repaired" | "unknown"
}

export interface EntityCanonicalViewScope {
  readonly tenant: string
  readonly uid: string
}

export interface StoreEntityCanonicalView extends EntityCanonicalViewScope {
  readonly view: EntityCanonicalView
}

export interface ActivateEntityCanonicalView extends EntityCanonicalViewScope {
  readonly viewId: string
}

export interface IndexGenerationScope {
  readonly tenant: string
  readonly uid: string
}

export interface StoreIndexGeneration {
  readonly generation: IndexGeneration
}

export interface ActivateIndexGeneration extends IndexGenerationScope {
  readonly generationId: string
}

export interface StoreExtractionArtifact {
  readonly revision: SourceRevision
  readonly artifact: ExtractionArtifact
}

export interface BeginSourceRevisionResult {
  readonly disposition: "created" | "resumed" | "committed"
  readonly revision: SourceRevision
}

export interface AdvanceIngestState {
  readonly revision: SourceRevision
  readonly from: IngestState
  readonly to: IngestState
}

export interface RecordIngestFailure {
  readonly revision: SourceRevision
  readonly code: string
  readonly retryable: boolean
}

export class InvalidSourceRevision extends Data.TaggedError("InvalidSourceRevision")<{
  readonly field: keyof BeginSourceRevision
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid source revision ${this.field}: ${this.reason}`
  }
}

export class InvalidIngestTransition extends Data.TaggedError("InvalidIngestTransition")<{
  readonly commitId: string
  readonly current: IngestState
  readonly requestedFrom: IngestState
  readonly requestedTo: IngestState
}> {
  override get message(): string {
    return `Cannot advance ${this.commitId} from ${this.current} as ${this.requestedFrom} -> ${this.requestedTo}`
  }
}

export class IngestRevisionBlocked extends Data.TaggedError("IngestRevisionBlocked")<{
  readonly commitId: string
  readonly state: IngestState
  readonly failureCode: string
}> {
  override get message(): string {
    return `Source revision ${this.commitId} is blocked at ${this.state} by ${this.failureCode}`
  }
}

export class InvalidProjectionDelta extends Data.TaggedError("InvalidProjectionDelta")<{
  readonly field: "stats" | "tokenDf" | "slotClaims" | "revision"
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid projection delta ${this.field}: ${this.reason}`
  }
}

export class ProjectionDeltaConflict extends Data.TaggedError("ProjectionDeltaConflict")<{
  readonly commitId: string
}> {
  override get message(): string {
    return `Projection delta for ${this.commitId} conflicts with its recorded bytes`
  }
}

export class ProjectionVersionConflict extends Data.TaggedError("ProjectionVersionConflict")<{
  readonly tenant: string
  readonly uid: string
  readonly expectedPreviousVersion: number
  readonly actualVersion: number
}> {
  override get message(): string {
    return `Projection for ${this.tenant}/${this.uid} expected version ${this.expectedPreviousVersion}, found ${this.actualVersion}`
  }
}

export class EntityCanonicalViewConflict extends Data.TaggedError("EntityCanonicalViewConflict")<{
  readonly tenant: string
  readonly uid: string
  readonly viewId: string
}> {
  override get message(): string {
    return `Entity canonical view ${this.viewId} conflicts for ${this.tenant}/${this.uid}`
  }
}

export class EntityCanonicalViewNotFound extends Data.TaggedError("EntityCanonicalViewNotFound")<{
  readonly tenant: string
  readonly uid: string
  readonly viewId: string
}> {
  override get message(): string {
    return `Entity canonical view ${this.viewId} was not found for ${this.tenant}/${this.uid}`
  }
}

export class IndexGenerationConflict extends Data.TaggedError("IndexGenerationConflict")<{
  readonly generationId: string
}> {
  override get message(): string {
    return `Index generation ${this.generationId} conflicts with its recorded definition`
  }
}

export class IndexGenerationExtractionNotFound extends Data.TaggedError(
  "IndexGenerationExtractionNotFound"
)<{
  readonly extractionGenerationId: string
}> {
  override get message(): string {
    return `Index generation references unknown extraction generation ${this.extractionGenerationId}`
  }
}

export class IndexGenerationNotFound extends Data.TaggedError("IndexGenerationNotFound")<{
  readonly generationId: string
}> {
  override get message(): string {
    return `Index generation ${this.generationId} was not found`
  }
}

export class ExtractionArtifactBindingMismatch extends Data.TaggedError(
  "ExtractionArtifactBindingMismatch"
)<{
  readonly commitId: string
  readonly reason: "unknownRevision" | "sourceDigest" | "extractionGeneration"
}> {
  override get message(): string {
    return `Extraction artifact ${this.commitId} has a ${this.reason} binding mismatch`
  }
}

export class ExtractionArtifactStateInvalid extends Data.TaggedError("ExtractionArtifactStateInvalid")<{
  readonly commitId: string
  readonly state: IngestState
}> {
  override get message(): string {
    return `Source revision ${this.commitId} cannot store extraction output at ${this.state}`
  }
}

export class ExtractionArtifactConflict extends Data.TaggedError("ExtractionArtifactConflict")<{
  readonly commitId: string
}> {
  override get message(): string {
    return `Extraction artifact for ${this.commitId} conflicts with its recorded bytes`
  }
}

export class IngestManifestUnavailable extends Data.TaggedError("IngestManifestUnavailable")<{
  readonly operation:
    | "open"
    | "begin"
    | "advance"
    | "recordFailure"
    | "read"
    | "readGeneration"
    | "applyProjectionDelta"
    | "readProjection"
    | "readProjectionCounts"
    | "reconcileProjection"
    | "storeEntityCanonicalView"
    | "activateEntityCanonicalView"
    | "readActiveEntityCanonicalView"
    | "storeIndexGeneration"
    | "activateIndexGeneration"
    | "readActiveIndexGeneration"
    | "storeExtractionArtifact"
    | "readExtractionArtifact"
  readonly cause: unknown
}> {
  override get message(): string {
    return `Ingest manifest is unavailable during ${this.operation}`
  }
}

export type IngestManifestError =
  | InvalidSourceRevision
  | InvalidIngestTransition
  | IngestRevisionBlocked
  | InvalidProjectionDelta
  | ProjectionDeltaConflict
  | ProjectionVersionConflict
  | EntityCanonicalViewConflict
  | EntityCanonicalViewNotFound
  | IndexGenerationConflict
  | IndexGenerationExtractionNotFound
  | IndexGenerationNotFound
  | InvalidIndexGeneration
  | InvalidExtractionArtifact
  | ExtractionArtifactBindingMismatch
  | ExtractionArtifactStateInvalid
  | ExtractionArtifactConflict
  | IngestManifestUnavailable
