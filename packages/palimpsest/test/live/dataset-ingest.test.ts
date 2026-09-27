import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath, loadQuestion } from "@palimpsest/dataset"
import { HydraMemory, HydraMemoryLive } from "@palimpsest/hydra"
import { Effect, Layer, Option } from "effect"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { Transcript } from "../../src/Transcript.js"

const hasOracle = existsSync(datasetPath("oracle"))

const layer = Transcript.layer.pipe(
  Layer.provideMerge(HydraMemoryLive),
  Layer.provide(NodeHttpClient.layerUndici)
)

const run = <A, E>(effect: Effect.Effect<A, E, Transcript | HydraMemory>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer))

const UID = "gpt4_2655b836"

describe.skipIf(!hasOracle)("ingesting a real LongMemEval user", () => {
  it("stores every turn verbatim, in timestamp order, and re-ingest is a no-op", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const transcript = yield* Transcript
        const question = yield* loadQuestion("oracle", UID).pipe(Effect.orDie)

        const report = yield* transcript.ingest(UID, question.sessions)
        const stored = yield* transcript.readSessions(UID)

        yield* transcript.ingest(UID, question.sessions)
        const storedAgain = yield* transcript.readSessions(UID)

        const mismatches: Array<string> = []
        for (const session of question.sessions) {
          for (const turn of session.turns) {
            const read = yield* transcript.readTurn(UID, session.sid, turn.turnIdx)
            if (Option.isNone(read) || read.value.text !== turn.text) {
              mismatches.push(`${session.sid}#${turn.turnIdx}`)
            }
          }
        }

        return { question, report, stored, storedAgain, mismatches }
      })
    )

    const { question, report, stored, storedAgain, mismatches } = outcome

    expect(mismatches).toEqual([])
    expect(report.sessions).toBe(question.sessions.length)
    expect(report.turns).toBe(question.sessions.reduce((n, s) => n + s.turns.length, 0))
    expect(storedAgain).toEqual(stored)

    expect(stored.map((s) => s.sid)).toEqual(["answer_4be1b6b4_3", "answer_4be1b6b4_1", "answer_4be1b6b4_2"])
    expect(stored.map((s) => s.sessionOrd)).toEqual([1, 2, 3])
    expect([...stored].sort((a, b) => a.ts - b.ts).map((s) => s.sid)).toEqual(stored.map((s) => s.sid))
  })
})
