import type { DatasetSession } from "@palimpsest/dataset"
import { HydraClient, type HydraError } from "@palimpsest/hydra"
import { Effect, Option } from "effect"
import { sessionKey, turnChunkKey, turnKey } from "./Keys.js"
import { linkToUser, readUserVertices } from "./User.js"

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
            ts: session.date.ts,
            // Denormalised so `readSessions` never has to join HAS_TURN, which
            // measured 19.2 s at 26 users and grows with the whole store.
            n_turns: session.turns.length
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
      // By id, not `WHERE t.turn = $key`: the second is a scan of every Turn in
      // the store (246 750 of them at full scale) for one row.
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

  /**
   * The user's sessions, walked from the `User` root.
   *
   * The old form joined `(Session)-[:HAS_TURN]->(Turn)` under
   * `WHERE s.uid = $uid` to count turns and measured **19.2 s** on a 26-user
   * graph — paid by the as-of scrubber on every load. The turn count is a
   * Session property now, and the session set is one indexed `MSpaths` hop.
   */
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
