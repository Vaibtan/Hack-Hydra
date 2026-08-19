import type { DatasetSession } from "@palimpsest/dataset"
import { HydraClient, type HydraError } from "@palimpsest/hydra"
import { Effect, Option } from "effect"
import { sessionKey, turnChunkKey, turnKey } from "./Keys.js"

/**
 * HydraDB stores at most 32 743 UTF-8 bytes in a string property. Four of the
 * 246 750 turns in `longmemeval_s_cleaned.json` are longer than that, and they
 * are exactly the long assistant outputs the `single-session-assistant`
 * questions ask about, so they cannot be dropped. A turn over the cap keeps its
 * first chunk on the `Turn` vertex and hangs the rest off `HAS_CHUNK`; Span
 * offsets stay absolute in the reassembled text, and nothing above `readTurn`
 * knows this happened.
 */
const CHUNK_BYTES = 30_000

const chunkText = (text: string): ReadonlyArray<string> => {
  if (Buffer.byteLength(text, "utf8") <= CHUNK_BYTES) return [text]
  const chunks: Array<string> = []
  let current = ""
  let bytes = 0
  // Iterating the string yields whole code points, so a surrogate pair is never
  // split across two chunks.
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
 * The verbatim transcript, in HydraDB.
 *
 * The graph is an index *over* the transcript, so the transcript has to live in
 * the same store — otherwise "HydraDB-only retrieval" would quietly mean
 * "HydraDB plus a file of turn texts". Hydration of an evidence Span is then a
 * batched read of `Turn.text`, nothing more.
 */

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
  /** The causal floor to read at, so a following ask sees these writes. */
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
            ts: session.date.ts
          }
        }))
      )

      const turns = sessions.flatMap((session) =>
        session.turns.map((turn) => ({ session, turn, chunks: chunkText(turn.text) }))
      )

      yield* hydra.batchMerge(
        "Turn",
        turns.map(({ session, turn, chunks }) => ({
          key: turnKey(uid, session.key, turn.turnIdx),
          properties: {
            turn: turnKey(uid, session.key, turn.turnIdx),
            uid,
            sid: session.sid,
            session_ord: session.sessionOrd,
            turn_idx: turn.turnIdx,
            role: turn.role,
            text: chunks[0] ?? "",
            chunks: chunks.length
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
      const result = yield* hydra.query(
        "MATCH (t:Turn) WHERE t.turn = $key RETURN t.sid AS sid, t.turn_idx AS turn_idx, " +
          "t.session_ord AS session_ord, t.role AS role, t.text AS text, t.chunks AS chunks",
        { key: turnKey(uid, sid, turnIdx) }
      )
      const row = result.rows[0]
      if (row === undefined) return Option.none()

      let text = String(row["text"])
      if (Number(row["chunks"]) > 1) {
        const rest = yield* hydra.query(
          "MATCH (t:Turn)-[:HAS_CHUNK]->(c:TurnChunk) WHERE t.turn = $key " +
            "RETURN c.chunk_idx AS chunk_idx, c.text AS text ORDER BY chunk_idx",
          { key: turnKey(uid, sid, turnIdx) }
        )
        text += rest.rows.map((chunk) => String(chunk["text"])).join("")
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
    Effect.gen(function* () {
      const result = yield* hydra.query(
        "MATCH (s:Session)-[:HAS_TURN]->(t:Turn) WHERE s.uid = $uid " +
          "RETURN s.sid AS sid, s.session_ord AS session_ord, s.date AS date, s.ts AS ts, " +
          "count(*) AS turns ORDER BY session_ord",
        { uid }
      )
      return result.rows.map((row) => ({
        sid: String(row["sid"]),
        sessionOrd: Number(row["session_ord"]),
        dateInt: Number(row["date"]),
        ts: Number(row["ts"]),
        turns: Number(row["turns"])
      }))
    })

  /** Drops a user's transcript. Used by tests and by a forced re-ingest. */
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
