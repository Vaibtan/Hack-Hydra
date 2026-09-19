import { Data } from "effect"
import type { EntityCanonicalView } from "../EntityCanonicalView.js"
import type { ExtractionArtifact, InvalidExtractionArtifact } from "../ExtractionArtifact.js"
import type { IndexGeneration, InvalidIndexGeneration } from "../IndexGeneration.js"
import type { InvalidMemoryScope } from "../MemoryScope.js"
import type { InvalidUserIndexSnapshot, UserIndexSnapshot } from "../UserIndexSnapshot.js"
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

export const SNAPSHOT_STATES = [
  "BUILDING",
  "VERIFIED",
  "ACTIVE",
  "SUPERSEDED",
  "FAILED"
] as const

/** Lifecycle of one immutable user index snapshot (D1, ADR-0003). */
export type SnapshotState = (typeof SNAPSHOT_STATES)[number]

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

/** Durable claim of one reduced Hydra graph id for one canonical identity (S01). */
export type GraphIdKind = "vertex" | "relationship"

export interface ClaimGraphId {
  readonly reducedId: number
  readonly kind: GraphIdKind
  readonly canonicalIdentity: string
}

export type GraphIdClaimDisposition = "claimed" | "idempotent"

export interface GraphIdClaim extends ClaimGraphId {
  readonly claimedAtMs: number
}

export interface GraphIdQuarantineRecord {
  readonly reducedId: number
  readonly kind: GraphIdKind
  readonly existingIdentity: string
  readonly rejectedIdentity: string
  readonly detectedAtMs: number
}

/** Evidence required to resolve a quarantined collision after verified rekey. */
export interface CompleteGraphIdRekey {
  readonly reducedId: number
  readonly kind: GraphIdKind
  readonly rejectedIdentity: string
  readonly replacementReducedId: number
  readonly replacementCanonicalIdentity: string
}

export interface UserIndexSnapshotScope {
  readonly tenant: string
  readonly uid: string
}

/** Read-back evidence recorded when a build transitions BUILDING -> VERIFIED. */
export interface SnapshotProjectionCounts {
  readonly sourceRevisions: number
  readonly vertices: number
  readonly relationships: number
}

/** Persist a content-addressed snapshot identity as a new BUILDING row. */
export interface RegisterUserIndexSnapshot {
  readonly snapshot: UserIndexSnapshot
}

/** Verification evidence produced by the aggregate build's read-back (S03). */
export interface VerifyUserIndexSnapshot {
  readonly snapshotId: string
  readonly verificationDigest: string
  readonly graphRoots: ReadonlyArray<string>
  readonly counts: SnapshotProjectionCounts
}

export interface FailUserIndexSnapshot {
  readonly snapshotId: string
  readonly code: string
}

/**
 * Compare-and-swap the per-scope active pointer. `expectedManifestVersion`
 * proves the snapshot was verified against the current committed revision set;
 * `expectedActiveSnapshotId` proves no competing activation changed the
 * pointer after the caller read it. Use `null` when no snapshot is active.
 */
export interface ActivateIndexSnapshot extends UserIndexSnapshotScope {
  readonly snapshotId: string
  readonly expectedManifestVersion: number
  readonly expectedActiveSnapshotId: string | null
}

/**
 * The durable manifest record for one immutable per-user projection. It
 * reconstructs the snapshot's full content without reading mutable session
 * counters: identity, ordered committed revisions, build/verification outputs,
 * and lifecycle state.
 */
export interface UserIndexSnapshotRecord {
  readonly snapshot: UserIndexSnapshot
  readonly state: SnapshotState
  readonly buildAttempt: number
  readonly verificationDigest: string | null
  readonly graphRoots: ReadonlyArray<string> | null
  readonly counts: SnapshotProjectionCounts | null
  readonly failureCode: string | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

/** The resolved per-scope active pointer plus the snapshot row it names. */
export interface ActiveIndexSnapshot {
  readonly record: UserIndexSnapshotRecord
  readonly manifestVersion: number
  readonly activatedAtMs: number
}

export class InvalidGraphIdClaim extends Data.TaggedError("InvalidGraphIdClaim")<{
  readonly field: "reducedId" | "kind" | "canonicalIdentity"
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid graph id claim ${this.field}: ${this.reason}`
  }
}

export class GraphIdCollision extends Data.TaggedError("GraphIdCollision")<{
  readonly reducedId: number
  readonly kind: GraphIdKind
  readonly existingIdentity: string
  readonly rejectedIdentity: string
}> {
  override get message(): string {
    return `Graph id ${this.reducedId} (${this.kind}) is claimed by a different identity`
  }
}

/** A collision cannot be cleared because its rebuild/rekey evidence is incomplete. */
export class GraphIdRecoveryRejected extends Data.TaggedError("GraphIdRecoveryRejected")<{
  readonly reducedId: number
  readonly kind: GraphIdKind
  readonly reason: "missingQuarantine" | "sameReducedId" | "replacementClaimMismatch" | "readBackMismatch"
}> {
  override get message(): string {
    return `Graph id ${this.reducedId} (${this.kind}) recovery was rejected: ${this.reason}`
  }
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

export class UserIndexSnapshotConflict extends Data.TaggedError("UserIndexSnapshotConflict")<{
  readonly snapshotId: string
}> {
  override get message(): string {
    return `User index snapshot ${this.snapshotId} conflicts with its recorded definition`
  }
}

export class UserIndexSnapshotNotFound extends Data.TaggedError("UserIndexSnapshotNotFound")<{
  readonly snapshotId: string
}> {
  override get message(): string {
    return `User index snapshot ${this.snapshotId} was not found`
  }
}

export class InvalidSnapshotTransition extends Data.TaggedError("InvalidSnapshotTransition")<{
  readonly snapshotId: string
  readonly current: SnapshotState
  readonly requested: SnapshotState
}> {
  override get message(): string {
    return `Cannot move user index snapshot ${this.snapshotId} from ${this.current} to ${this.requested}`
  }
}

/** A verify/fail/activate input failed validation before any transition. */
export class InvalidSnapshotUpdate extends Data.TaggedError("InvalidSnapshotUpdate")<{
  readonly snapshotId: string
  readonly field:
    | "verificationDigest"
    | "graphRoots"
    | "counts"
    | "failureCode"
    | "expectedManifestVersion"
    | "expectedActiveSnapshotId"
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid user index snapshot update ${this.field}: ${this.reason}`
  }
}

/** A stored revision reference did not bind to the snapshot's own scope. */
export class UserIndexSnapshotBindingMismatch extends Data.TaggedError(
  "UserIndexSnapshotBindingMismatch"
)<{
  readonly snapshotId: string
  readonly commitId: string
  readonly reason: "unknownRevision" | "scopeMismatch"
}> {
  override get message(): string {
    return `User index snapshot ${this.snapshotId} has a ${this.reason} binding mismatch on ${this.commitId}`
  }
}

/** A repeated verification reported different evidence than the stored one. */
export class SnapshotVerificationConflict extends Data.TaggedError(
  "SnapshotVerificationConflict"
)<{
  readonly snapshotId: string
}> {
  override get message(): string {
    return `User index snapshot ${this.snapshotId} verification conflicts with its recorded evidence`
  }
}

/** A snapshot references a source revision that has not reached COMMITTED. */
export class SnapshotRevisionNotCommitted extends Data.TaggedError(
  "SnapshotRevisionNotCommitted"
)<{
  readonly snapshotId: string
  readonly commitId: string
  readonly state: IngestState
}> {
  override get message(): string {
    return `User index snapshot ${this.snapshotId} lists ${this.commitId} at ${this.state}, not COMMITTED`
  }
}

/** A verified snapshot cannot activate while committed revisions are uncovered. */
export class SnapshotRevisionCoverageMismatch extends Data.TaggedError(
  "SnapshotRevisionCoverageMismatch"
)<{
  readonly snapshotId: string
  readonly missingCommitIds: ReadonlyArray<string>
}> {
  override get message(): string {
    return `User index snapshot ${this.snapshotId} does not cover committed revisions ${this.missingCommitIds.join(", ")}`
  }
}

export class SnapshotScopeMismatch extends Data.TaggedError("SnapshotScopeMismatch")<{
  readonly snapshotId: string
  readonly tenant: string
  readonly uid: string
}> {
  override get message(): string {
    return `User index snapshot ${this.snapshotId} does not belong to ${this.tenant}/${this.uid}`
  }
}

/** The active-pointer compare-and-swap observed a newer committed manifest. */
export class SnapshotActivationConflict extends Data.TaggedError("SnapshotActivationConflict")<{
  readonly tenant: string
  readonly uid: string
  readonly snapshotId: string
  readonly expectedManifestVersion: number
  readonly actualManifestVersion: number
}> {
  override get message(): string {
    return `Activating ${this.snapshotId} for ${this.tenant}/${this.uid} expected manifest version ${this.expectedManifestVersion}, found ${this.actualManifestVersion}`
  }
}

/** The active-pointer compare-and-swap observed a different current snapshot. */
export class SnapshotActivePointerConflict extends Data.TaggedError(
  "SnapshotActivePointerConflict"
)<{
  readonly tenant: string
  readonly uid: string
  readonly snapshotId: string
  readonly expectedActiveSnapshotId: string | null
  readonly actualActiveSnapshotId: string | null
}> {
  override get message(): string {
    return `Activating ${this.snapshotId} for ${this.tenant}/${this.uid} expected active snapshot ${this.expectedActiveSnapshotId ?? "none"}, found ${this.actualActiveSnapshotId ?? "none"}`
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
    | "claimGraphId"
    | "readGraphIdClaim"
    | "readGraphIdQuarantine"
    | "listGraphIdQuarantine"
    | "completeGraphIdRekey"
    | "registerUserIndexSnapshot"
    | "verifyUserIndexSnapshot"
    | "failUserIndexSnapshot"
    | "readUserIndexSnapshot"
    | "listUserIndexSnapshots"
    | "readActiveIndexSnapshot"
    | "activateIndexSnapshot"
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
  | InvalidGraphIdClaim
  | GraphIdCollision
  | GraphIdRecoveryRejected
  | InvalidMemoryScope
  | InvalidUserIndexSnapshot
  | UserIndexSnapshotConflict
  | UserIndexSnapshotNotFound
  | InvalidSnapshotTransition
  | InvalidSnapshotUpdate
  | UserIndexSnapshotBindingMismatch
  | SnapshotVerificationConflict
  | SnapshotRevisionNotCommitted
  | SnapshotRevisionCoverageMismatch
  | SnapshotScopeMismatch
  | SnapshotActivationConflict
  | SnapshotActivePointerConflict
  | IngestManifestUnavailable
