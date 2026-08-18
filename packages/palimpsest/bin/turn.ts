import { NodeHttpClient } from "@effect/platform-node"
import { HydraClient } from "@palimpsest/hydra"
import { Effect, Layer, Option } from "effect"
import { Transcript } from "../src/index.js"

/**
 * `turn --uid <question_id> --sid <session_id> --idx <turn_idx>`
 *
 * Reads one Turn's verbatim text back out of HydraDB, reassembling it if it was
 * chunked. This is what evidence hydration does, in one command.
 */
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const uid = arg("uid")
const sid = arg("sid")
const idx = Number(arg("idx") ?? "0")

if (uid === undefined || sid === undefined) {
  console.error("usage: turn --uid <question_id> --sid <session_id> --idx <turn_idx>")
  process.exit(2)
}

const program = Effect.gen(function* () {
  const transcript = yield* Transcript
  const stored = yield* transcript.readTurn(uid, sid, idx)
  if (Option.isNone(stored)) {
    console.error(`no turn ${uid} / ${sid} / ${idx}`)
    return yield* Effect.sync(() => process.exit(1))
  }
  const turn = stored.value
  console.log(`${turn.role}  session_ord ${turn.sessionOrd}  turn ${turn.turnIdx}  ${turn.text.length} chars`)
  console.log("---")
  console.log(turn.text)
})

Effect.runPromise(
  program.pipe(
    Effect.provide(
      Transcript.Default.pipe(
        Layer.provideMerge(HydraClient.Default),
        Layer.provide(NodeHttpClient.layerUndici)
      )
    )
  )
).catch((error) => {
  console.error(String(error))
  process.exit(1)
})
