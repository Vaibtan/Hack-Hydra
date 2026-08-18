import { NodeHttpClient } from "@effect/platform-node"
import { HydraClient } from "@palimpsest/hydra"
import type { DatasetSession } from "@palimpsest/dataset"
import { Effect, Layer, Option } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Transcript, turnKey } from "../../src/index.js"

const layer = Transcript.Default.pipe(
  Layer.provideMerge(HydraClient.Default),
  Layer.provide(NodeHttpClient.layerUndici)
)

const run = <A, E>(effect: Effect.Effect<A, E, Transcript | HydraClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>)

const UID_A = "probe-transcript-a"
const UID_B = "probe-transcript-b"

/** The longest turn in longmemeval_s_cleaned.json is 76 560 chars. */
const HUGE_TURN = Array.from({ length: 7656 }, (_, i) => `line ${i} — ünïcödé 'quote' \\slash\n`)
  .join("")
  .slice(0, 76_560)

const sessions: ReadonlyArray<DatasetSession> = [
  {
    sid: "shared_session_1",
    sessionOrd: 1,
    date: { raw: "2023/04/10 (Mon) 14:47", ts: Date.UTC(2023, 3, 10, 14, 47) / 1000, dateInt: 20230410 },
    turns: [
      { turnIdx: 0, role: "user", text: "I got my car serviced on March 15th.", hasAnswer: true },
      { turnIdx: 1, role: "assistant", text: HUGE_TURN, hasAnswer: false }
    ]
  },
  {
    sid: "shared_session_2",
    sessionOrd: 2,
    date: { raw: "2023/04/10 (Mon) 17:15", ts: Date.UTC(2023, 3, 10, 17, 15) / 1000, dateInt: 20230410 },
    turns: [{ turnIdx: 0, role: "user", text: "The GPS stopped working.", hasAnswer: true }]
  }
]

const wipe = Effect.gen(function* () {
  const transcript = yield* Transcript
  yield* transcript.remove(UID_A)
  yield* transcript.remove(UID_B)
})

beforeAll(() => run(wipe))
afterAll(() => run(wipe))

describe("Transcript ingest against the live node", () => {
  it("writes sessions, turns and HAS_TURN edges under the user's key prefix", async () => {
    const report = await run(
      Effect.gen(function* () {
        const transcript = yield* Transcript
        return yield* transcript.ingest(UID_A, sessions)
      })
    )
    expect(report).toMatchObject({ sessions: 2, turns: 3 })
    expect(Option.isSome(report.bookmark)).toBe(true)
  })

  it("round-trips a 76 560-char turn byte-identically", async () => {
    const stored = await run(
      Effect.gen(function* () {
        const transcript = yield* Transcript
        return yield* transcript.readTurn(UID_A, "shared_session_1", 1)
      })
    )
    expect(Option.isSome(stored)).toBe(true)
    const turn = Option.getOrThrow(stored)
    expect(turn.text.length).toBe(76_560)
    expect(turn.text).toBe(HUGE_TURN)
    expect(turn.role).toBe("assistant")
    expect(turn.sessionOrd).toBe(1)
  })

  it("lists a user's sessions in session_ord order with their dates", async () => {
    const listed = await run(
      Effect.gen(function* () {
        const transcript = yield* Transcript
        return yield* transcript.readSessions(UID_A)
      })
    )
    expect(listed).toEqual([
      { sid: "shared_session_1", sessionOrd: 1, dateInt: 20230410, ts: Date.UTC(2023, 3, 10, 14, 47) / 1000, turns: 2 },
      { sid: "shared_session_2", sessionOrd: 2, dateInt: 20230410, ts: Date.UTC(2023, 3, 10, 17, 15) / 1000, turns: 1 }
    ])
  })

  it("is a no-op on re-ingest: the same statement, no new vertices", async () => {
    const [before, after] = await run(
      Effect.gen(function* () {
        const transcript = yield* Transcript
        const a = yield* transcript.readSessions(UID_A)
        yield* transcript.ingest(UID_A, sessions)
        const b = yield* transcript.readSessions(UID_A)
        return [a, b] as const
      })
    )
    expect(after).toEqual(before)
  })

  it("keeps two users' copies of the same shared session apart", async () => {
    const [a, b] = await run(
      Effect.gen(function* () {
        const transcript = yield* Transcript
        yield* transcript.ingest(UID_B, [
          {
            ...sessions[0]!,
            turns: [{ turnIdx: 0, role: "user", text: "a different transcript entirely", hasAnswer: false }]
          }
        ])
        const first = yield* transcript.readTurn(UID_A, "shared_session_1", 0)
        const second = yield* transcript.readTurn(UID_B, "shared_session_1", 0)
        return [first, second] as const
      })
    )
    expect(Option.getOrThrow(a).text).toBe("I got my car serviced on March 15th.")
    expect(Option.getOrThrow(b).text).toBe("a different transcript entirely")
    expect(turnKey(UID_A, "shared_session_1", 0)).not.toBe(turnKey(UID_B, "shared_session_1", 0))
  })

  it("reports nothing for a turn that was never written", async () => {
    const missing = await run(
      Effect.gen(function* () {
        const transcript = yield* Transcript
        return yield* transcript.readTurn(UID_A, "shared_session_1", 99)
      })
    )
    expect(Option.isNone(missing)).toBe(true)
  })
})
