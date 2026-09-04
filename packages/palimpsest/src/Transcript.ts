import type { DatasetSession } from "@palimpsest/dataset"
import { HydraClient, type HydraError } from "@palimpsest/hydra"
import { Effect, Option } from "effect"
import { sessionKey, turnChunkKey, turnKey } from "./Keys.js"
import { linkToUser, readUserVertices } from "./User.js"
import { canonicalSessionSource } from "./SourceIdentity.js"
import { chunkText } from "./Chunk.js"

export interface StoredTurn {
  readonly sid: string
  readonly turnIdx: number
  readonly sessionOrd: number
  readonly role: string
  readonly text: string
}

export interface StoredSession {
  readonly sid: string
  readonly sessionOrd: number
  readonly dateInt: number
  readonly ts: number
  readonly turns: number
}

export interface TranscriptReport {
  readonly sessions: number
  readonly turns: number
  readonly bookmark: Option.Option<string>
}

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient

  const ingest = (
    uid: string,
    sessions: ReadonlyArray<DatasetSession>
  ): Effect.Effect<TranscriptReport, HydraError> =>
    Effect.gen(function* () {
      yield* hydra.batchMerge(
        "Session",
        sessions.map((session) => ({
          key: sessionKey(uid, session.key),
          properties: {
            sess: sessionKey(uid, session.key),
            uid,
            sid: session.sid,
            session_ord: session.sessionOrd,
            date: session.date.dateInt,
            ts: session.date.ts,
            n_turns: session.turns.length
          }
        }))
      )

      const turns = sessions.flatMap((session) => {
        const sourceDigest = canonicalSessionSource(session).sourceDigest
        return session.turns.map((turn) => ({
          session,
          turn,
          chunks: chunkText(turn.text),
          sourceDigest
        }))
      })

      yield* hydra.batchMerge(
        "Turn",
        turns.map(({ session, turn, chunks, sourceDigest }) => ({
          key: turnKey(uid, session.key, turn.turnIdx),
          properties: {
            turn: turnKey(uid, session.key, turn.turnIdx),
            uid,
            sid: session.sid,
            session_ord: session.sessionOrd,
            turn_idx: turn.turnIdx,
            role: turn.role,
            text: chunks[0] ?? "",
            chunks: chunks.length,
            source_digest: sourceDigest,
            source_session_id: session.key
          }
        }))
      )

      const overflow = turns.flatMap(({ session, turn, chunks }) =>
        chunks.slice(1).map((text, index) => ({ session, turn, text, chunkIdx: index + 1 }))
      )
      if (overflow.length > 0) {
        yield* hydra.batchMerge(
          "TurnChunk",
          overflow.map(({ session, turn, text, chunkIdx }) => ({
            key: turnChunkKey(uid, session.key, turn.turnIdx, chunkIdx),
            properties: {
              tchunk: turnChunkKey(uid, session.key, turn.turnIdx, chunkIdx),
              uid,
              chunk_idx: chunkIdx,
              text
            }
          }))
        )
        yield* hydra.batchRel(
          "HAS_CHUNK",
          overflow.map(({ session, turn, chunkIdx }) => ({
            srcLabel: "Turn",
            srcKey: turnKey(uid, session.key, turn.turnIdx),
            dstLabel: "TurnChunk",
            dstKey: turnChunkKey(uid, session.key, turn.turnIdx, chunkIdx)
          }))
        )
      }

      yield* hydra.batchRel(
        "HAS_TURN",
        turns.map(({ session, turn }) => ({
          srcLabel: "Session",
          srcKey: sessionKey(uid, session.key),
          dstLabel: "Turn",
          dstKey: turnKey(uid, session.key, turn.turnIdx)
        }))
      )

      yield* linkToUser(
        hydra,
        uid,
        "HAS_SESSION",
        "Session",
        sessions.map((session) => sessionKey(uid, session.key))
      )

      return {
        sessions: sessions.length,
        turns: turns.length,
        bookmark: yield* hydra.lastBookmark
      }
    })

  const readTurn = (
    uid: string,
    sid: string,
    turnIdx: number
  ): Effect.Effect<Option.Option<StoredTurn>, HydraError> =>
    Effect.gen(function* () {
      const found = yield* hydra.getById("Turn", turnKey(uid, sid, turnIdx), [
        "sid",
        "turn_idx",
        "session_ord",
        "role",
        "text",
        "chunks"
      ])
      if (found._tag === "None") return Option.none()
      const row = found.value

      let text = String(row["text"])
      if (Number(row["chunks"]) > 1) {
        const paths = yield* hydra.msPaths({
          sourceLabel: "Turn",
          sourceProperty: "turn",
          sourceValues: [turnKey(uid, sid, turnIdx)],
          relTypes: ["HAS_CHUNK"],
          relDirection: "outgoing",
          maxLen: 1
        })
        const chunks = paths
          .filter((path) => path.relationships.length === 1)
          .map((path) => path.nodes[path.nodes.length - 1])
          .map((node) => ({
            idx: Number(node?.properties["chunk_idx"] ?? 0),
            text: String(node?.properties["text"] ?? "")
          }))
          .sort((a, b) => a.idx - b.idx)
        text += chunks.map((chunk) => chunk.text).join("")
      }

      return Option.some({
        sid: String(row["sid"]),
        turnIdx: Number(row["turn_idx"]),
        sessionOrd: Number(row["session_ord"]),
        role: String(row["role"]),
        text
      })
    })

  const readSessions = (uid: string): Effect.Effect<ReadonlyArray<StoredSession>, HydraError> =>
    readUserVertices(hydra, uid, "HAS_SESSION").pipe(
      Effect.map((rows) =>
        rows
          .map((row) => ({
            sid: String(row["sid"] ?? ""),
            sessionOrd: Number(row["session_ord"] ?? 0),
            dateInt: Number(row["date"] ?? 0),
            ts: Number(row["ts"] ?? 0),
            turns: Number(row["n_turns"] ?? 0)
          }))
          .sort((a, b) => a.sessionOrd - b.sessionOrd)
      )
    )

  const remove = (uid: string): Effect.Effect<void, HydraError> =>
    Effect.gen(function* () {
      const keys: Array<string> = []
      for (const [label, property] of [
        ["Session", "sess"],
        ["Turn", "turn"],
        ["TurnChunk", "tchunk"]
      ] as const) {
        const result = yield* hydra.query(
          `MATCH (n:${label}) WHERE n.uid = $uid RETURN n.${property} AS key`,
          { uid }
        )
        keys.push(...result.rows.map((row) => String(row["key"])))
      }
      yield* hydra.deleteByKeys(keys)
    })

  return { ingest, readTurn, readSessions, remove } as const
})

export class Transcript extends Effect.Service<Transcript>()("palimpsest/Transcript", {
  effect: make
}) {}
