import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath, loadQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { Effect, Layer, Option } from "effect"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { Transcript } from "../../src/index.js"

/**
 * The same ingest, but against a real LongMemEval user rather than a fixture —
 * this is what proves the loader's ordering and the client's chunking survive
 * the actual data. Skipped when `data/` is absent, since it is gitignored.
 */
const hasOracle = existsSync(datasetPath("oracle"))

const layer = Transcript.Default.pipe(
  Layer.provideMerge(HydraClient.Default),
  Layer.provide(NodeHttpClient.layerUndici)
)

const run = <A, E>(effect: Effect.Effect<A, E, Transcript | HydraClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>)

/** A `temporal-reasoning` question whose three sessions are out of order in the file. */
const UID = "gpt4_2655b836"

describe.skipIf(!hasOracle)("ingesting a real LongMemEval user", () => {
  it("stores every turn verbatim, in timestamp order, and re-ingest is a no-op", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const transcript = yield* Transcript
        const question = yield* loadQuestion("oracle", UID).pipe(Effect.orDie)

        const report = yield* transcript.ingest(UID, question.sessions)
        const stored = yield* transcript.readSessions(UID)

        // Re-ingest, then re-read: nothing may change.
        yield* transcript.ingest(UID, question.sessions)
        const storedAgain = yield* transcript.readSessions(UID)

        // Every single turn must come back byte-identical.
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

    // The file lists these sessions as _2, _3, _1; chronologically they are _3, _1, _2.
    expect(stored.map((s) => s.sid)).toEqual(["answer_4be1b6b4_3", "answer_4be1b6b4_1", "answer_4be1b6b4_2"])
    expect(stored.map((s) => s.sessionOrd)).toEqual([1, 2, 3])
    // Non-decreasing timestamps is the property that matters, not these ids.
    expect([...stored].sort((a, b) => a.ts - b.ts).map((s) => s.sid)).toEqual(stored.map((s) => s.sid))
  })
})
