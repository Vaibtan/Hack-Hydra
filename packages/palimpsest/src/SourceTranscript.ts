import type { DatasetSession } from "@palimpsest/dataset"
import { HydraClient, type HydraError, type Scalar } from "@palimpsest/hydra"
import { Context, Data, Effect, Layer, Option, Result } from "effect"
import type { SourceRevision } from "./IngestManifest.js"
import { chunkText } from "./Chunk.js"
import {
  frameSegment,
  memoryScopeFromRevision,
  memoryScopeKey,
  scopePrefix,
  type MemoryScope
} from "./MemoryScope.js"
import { canonicalSessionSource } from "./SourceIdentity.js"

/** New-plane source keys are tenant-scoped (S01); the `uid` is never a bare key prefix. */
export const sourceSessionKey = (
  scope: MemoryScope,
  logicalSessionId: string,
  sourceDigest: string
): string => `${scopePrefix(scope)}|srcsess|${sourceDigest}|${frameSegment(logicalSessionId)}`

export const sourceTurnKey = (
  scope: MemoryScope,
  logicalSessionId: string,
  sourceDigest: string,
  turnIdx: number
): string => `${sourceSessionKey(scope, logicalSessionId, sourceDigest)}|turn|${turnIdx}`

export const sourceTurnChunkKey = (
  scope: MemoryScope,
  logicalSessionId: string,
  sourceDigest: string,
  turnIdx: number,
  chunkIdx: number
): string => `${sourceTurnKey(scope, logicalSessionId, sourceDigest, turnIdx)}|chunk|${chunkIdx}`

export class SourceTranscriptRevisionMismatch extends Data.TaggedError(
  "SourceTranscriptRevisionMismatch"
)<{
  readonly field: "logicalSessionId" | "sourceDigest" | "sourceBytes"
}> {
  override get message(): string {
    return `Source transcript does not match claimed ${this.field}`
  }
}

export interface SourceTranscriptVertex {
  readonly key: string
  readonly properties: Readonly<Record<string, Scalar>>
}

export interface SourceTranscriptRelation {
  readonly type: "HAS_SOURCE_REVISION" | "SOURCE_HAS_CHUNK" | "SOURCE_HAS_TURN"
  readonly srcLabel: "MemoryScope" | "SourceSession" | "SourceTurn"
  readonly srcKey: string
  readonly dstLabel: "SourceSession" | "SourceTurn" | "SourceTurnChunk"
  readonly dstKey: string
}

export interface SourceTranscriptWritePlan {
  readonly sourceDigest: string
  readonly scope: SourceTranscriptVertex
  readonly session: SourceTranscriptVertex
  readonly turns: ReadonlyArray<SourceTranscriptVertex>
  readonly chunks: ReadonlyArray<SourceTranscriptVertex>
  readonly relations: ReadonlyArray<SourceTranscriptRelation>
}

export interface SourceTranscriptReport {
  readonly sourceDigest: string
  readonly sessions: 1
  readonly turns: number
  readonly bookmark: Option.Option<string>
}

export const planSourceTranscriptWrite = (
  revision: SourceRevision,
  session: DatasetSession
): Result.Result<SourceTranscriptWritePlan, SourceTranscriptRevisionMismatch> => {
  if (session.key !== revision.logicalSessionId) {
    return Result.fail(new SourceTranscriptRevisionMismatch({ field: "logicalSessionId" }))
  }
  const canonical = canonicalSessionSource(session)
  if (canonical.sourceDigest !== revision.sourceDigest) {
    return Result.fail(new SourceTranscriptRevisionMismatch({ field: "sourceDigest" }))
  }
  if (canonical.sourceBytes !== revision.sourceBytes) {
    return Result.fail(new SourceTranscriptRevisionMismatch({ field: "sourceBytes" }))
  }

  const scope = memoryScopeFromRevision(revision)
  const rootKey = memoryScopeKey(scope)
  const sessionKey = sourceSessionKey(scope, revision.logicalSessionId, revision.sourceDigest)
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
  relations.push({
    type: "HAS_SOURCE_REVISION",
    srcLabel: "MemoryScope",
    srcKey: rootKey,
    dstLabel: "SourceSession",
    dstKey: sessionKey
  })
  for (const turn of session.turns) {
    const key = sourceTurnKey(scope, revision.logicalSessionId, revision.sourceDigest, turn.turnIdx)
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
        scope,
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

  return Result.succeed({
    sourceDigest: revision.sourceDigest,
    scope: {
      key: rootKey,
      properties: {
        memory_scope: rootKey,
        tenant: revision.tenant,
        uid: revision.uid
      }
    },
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
      if (plan._tag === "Failure") return yield* Effect.fail(plan.failure)

      yield* hydra.batchMerge("MemoryScope", [plan.success.scope])
      yield* hydra.batchMerge("SourceSession", [plan.success.session])
      yield* hydra.batchMerge("SourceTurn", plan.success.turns)
      if (plan.success.chunks.length > 0) {
        yield* hydra.batchMerge("SourceTurnChunk", plan.success.chunks)
      }
      const turnRelations = plan.success.relations.filter((relation) => relation.type === "SOURCE_HAS_TURN")
      if (turnRelations.length > 0) yield* hydra.batchRel("SOURCE_HAS_TURN", turnRelations)
      const chunkRelations = plan.success.relations.filter((relation) => relation.type === "SOURCE_HAS_CHUNK")
      if (chunkRelations.length > 0) yield* hydra.batchRel("SOURCE_HAS_CHUNK", chunkRelations)
      const scopeRelations = plan.success.relations.filter((relation) => relation.type === "HAS_SOURCE_REVISION")
      if (scopeRelations.length > 0) yield* hydra.batchRel("HAS_SOURCE_REVISION", scopeRelations)

      return {
        sourceDigest: plan.success.sourceDigest,
        sessions: 1,
        turns: plan.success.turns.length,
        bookmark: yield* hydra.lastBookmark
      }
    })

  return { write } as const
})

export type SourceTranscript = Effect.Success<typeof make>
const SourceTranscriptTag = Context.Service<SourceTranscript>("palimpsest/SourceTranscript")
export const SourceTranscript = Object.assign(SourceTranscriptTag, { layer: Layer.effect(SourceTranscriptTag, make) })
