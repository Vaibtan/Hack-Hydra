import type { DatasetSession } from "@palimpsest/dataset"
import { HydraClient, type HydraError, type Scalar } from "@palimpsest/hydra"
import { Data, Effect, Either, Option } from "effect"
import type { SourceRevision } from "./IngestManifest.js"
import { canonicalSessionSource } from "./SourceIdentity.js"
import { linkToUser } from "./User.js"

/** HydraDB's safe per-property text payload, leaving room for relation metadata. */
const CHUNK_BYTES = 30_000

/** Immutable key for a source revision's session vertex. */
export const sourceSessionKey = (
  uid: string,
  logicalSessionId: string,
  sourceDigest: string
): string => `${uid}|srcsess|${sourceDigest}|${logicalSessionId}`

/** Immutable key for one turn inside a source revision. */
export const sourceTurnKey = (
  uid: string,
  logicalSessionId: string,
  sourceDigest: string,
  turnIdx: number
): string => `${sourceSessionKey(uid, logicalSessionId, sourceDigest)}|turn|${turnIdx}`

/** Immutable key for one overflow chunk inside a source turn. */
export const sourceTurnChunkKey = (
  uid: string,
  logicalSessionId: string,
  sourceDigest: string,
  turnIdx: number,
  chunkIdx: number
): string => `${sourceTurnKey(uid, logicalSessionId, sourceDigest, turnIdx)}|chunk|${chunkIdx}`

/** The caller tried to persist bytes that are not the manifest-claimed source revision. */
export class SourceTranscriptRevisionMismatch extends Data.TaggedError(
  "SourceTranscriptRevisionMismatch"
)<{
  readonly field: "logicalSessionId" | "sourceDigest" | "sourceBytes"
}> {
  override get message(): string {
    return `Source transcript does not match claimed ${this.field}`
  }
}

/** One immutable source vertex write prepared before touching the graph. */
export interface SourceTranscriptVertex {
  readonly key: string
  readonly properties: Readonly<Record<string, Scalar>>
}

/** One source-internal edge prepared before touching the graph. */
export interface SourceTranscriptRelation {
  readonly type: "SOURCE_HAS_CHUNK" | "SOURCE_HAS_TURN"
  readonly srcLabel: "SourceSession" | "SourceTurn"
  readonly srcKey: string
  readonly dstLabel: "SourceTurn" | "SourceTurnChunk"
  readonly dstKey: string
}

/** The complete, immutable graph write for one manifest source revision. */
export interface SourceTranscriptWritePlan {
  readonly sourceDigest: string
  readonly session: SourceTranscriptVertex
  readonly turns: ReadonlyArray<SourceTranscriptVertex>
  readonly chunks: ReadonlyArray<SourceTranscriptVertex>
  readonly relations: ReadonlyArray<SourceTranscriptRelation>
}

/** Outcome of persisting one immutable source revision. */
export interface SourceTranscriptReport {
  readonly sourceDigest: string
  readonly sessions: 1
  readonly turns: number
  /** The causal floor to use for a following graph stage. */
  readonly bookmark: Option.Option<string>
}

const chunkText = (text: string): ReadonlyArray<string> => {
  if (Buffer.byteLength(text, "utf8") <= CHUNK_BYTES) return [text]
  const chunks: Array<string> = []
  let current = ""
  let bytes = 0
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8")
    if (bytes + size > CHUNK_BYTES) {
      chunks.push(current)
      current = ""
      bytes = 0
    }
    current += codePoint
    bytes += size
  }
  chunks.push(current)
  return chunks
}

/**
 * Creates a full immutable source write from a manifest-owned revision.
 *
 * `SourceRevision` includes extraction state today, but the source graph key
 * deliberately excludes it: re-extracting the same source must not replace or
 * duplicate its verbatim transcript.
 */
export const planSourceTranscriptWrite = (
  revision: SourceRevision,
  session: DatasetSession
): Either.Either<SourceTranscriptWritePlan, SourceTranscriptRevisionMismatch> => {
  if (session.key !== revision.logicalSessionId) {
    return Either.left(new SourceTranscriptRevisionMismatch({ field: "logicalSessionId" }))
  }
  const canonical = canonicalSessionSource(session)
  if (canonical.sourceDigest !== revision.sourceDigest) {
    return Either.left(new SourceTranscriptRevisionMismatch({ field: "sourceDigest" }))
  }
  if (canonical.sourceBytes !== revision.sourceBytes) {
    return Either.left(new SourceTranscriptRevisionMismatch({ field: "sourceBytes" }))
  }

  const sessionKey = sourceSessionKey(revision.uid, revision.logicalSessionId, revision.sourceDigest)
  const sessionProperties = {
    source_session: sessionKey,
    tenant: revision.tenant,
    uid: revision.uid,
    logical_session_id: revision.logicalSessionId,
    source_digest: revision.sourceDigest,
    source_bytes: revision.sourceBytes,
    sid: session.sid,
    session_ord: revision.sessionOrdinal,
    date: session.date.dateInt,
    ts: session.date.ts,
    n_turns: session.turns.length
  } satisfies Record<string, Scalar>

  const turnWrites: Array<SourceTranscriptVertex> = []
  const chunkWrites: Array<SourceTranscriptVertex> = []
  const relations: Array<SourceTranscriptRelation> = []
  for (const turn of session.turns) {
    const key = sourceTurnKey(revision.uid, revision.logicalSessionId, revision.sourceDigest, turn.turnIdx)
    const chunks = chunkText(turn.text)
    turnWrites.push({
      key,
      properties: {
        source_turn: key,
        tenant: revision.tenant,
        uid: revision.uid,
        logical_session_id: revision.logicalSessionId,
        source_digest: revision.sourceDigest,
        sid: session.sid,
        session_ord: revision.sessionOrdinal,
        turn_idx: turn.turnIdx,
        role: turn.role,
        text: chunks[0] ?? "",
        chunks: chunks.length
      }
    })
    relations.push({
      type: "SOURCE_HAS_TURN",
      srcLabel: "SourceSession",
      srcKey: sessionKey,
      dstLabel: "SourceTurn",
      dstKey: key
    })
    for (let index = 1; index < chunks.length; index++) {
      const chunkIdx = index
      const chunkKey = sourceTurnChunkKey(
        revision.uid,
        revision.logicalSessionId,
        revision.sourceDigest,
        turn.turnIdx,
        chunkIdx
      )
      chunkWrites.push({
        key: chunkKey,
        properties: {
          source_turn_chunk: chunkKey,
          tenant: revision.tenant,
          uid: revision.uid,
          source_digest: revision.sourceDigest,
          chunk_idx: chunkIdx,
          text: chunks[chunkIdx] ?? ""
        }
      })
      relations.push({
        type: "SOURCE_HAS_CHUNK",
        srcLabel: "SourceTurn",
        srcKey: key,
        dstLabel: "SourceTurnChunk",
        dstKey: chunkKey
      })
    }
  }

  return Either.right({
    sourceDigest: revision.sourceDigest,
    session: { key: sessionKey, properties: sessionProperties },
    turns: turnWrites,
    chunks: chunkWrites,
    relations
  })
}

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient

  const write = (
    revision: SourceRevision,
    session: DatasetSession
  ): Effect.Effect<SourceTranscriptReport, HydraError | SourceTranscriptRevisionMismatch> =>
    Effect.gen(function* () {
      const plan = planSourceTranscriptWrite(revision, session)
      if (plan._tag === "Left") return yield* Effect.fail(plan.left)

      yield* hydra.batchMerge("SourceSession", [plan.right.session])
      yield* hydra.batchMerge("SourceTurn", plan.right.turns)
      if (plan.right.chunks.length > 0) {
        yield* hydra.batchMerge("SourceTurnChunk", plan.right.chunks)
      }
      const turnRelations = plan.right.relations.filter((relation) => relation.type === "SOURCE_HAS_TURN")
      if (turnRelations.length > 0) yield* hydra.batchRel("SOURCE_HAS_TURN", turnRelations)
      const chunkRelations = plan.right.relations.filter((relation) => relation.type === "SOURCE_HAS_CHUNK")
      if (chunkRelations.length > 0) yield* hydra.batchRel("SOURCE_HAS_CHUNK", chunkRelations)
      yield* linkToUser(hydra, revision.uid, "HAS_SOURCE_REVISION", "SourceSession", [plan.right.session.key])

      return {
        sourceDigest: plan.right.sourceDigest,
        sessions: 1,
        turns: plan.right.turns.length,
        bookmark: yield* hydra.lastBookmark
      }
    })

  return { write } as const
})

/** Persisted, content-addressed source plane used by transactional ingest. */
export class SourceTranscript extends Effect.Service<SourceTranscript>()("palimpsest/SourceTranscript", {
  effect: make
}) {}
