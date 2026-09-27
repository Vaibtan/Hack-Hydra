import { NodeHttpClient } from "@effect/platform-node"
import { HydraMemoryLive } from "@palimpsest/hydra"
import { LlmLive, loadDotEnv, verifyModelsOrExit } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { LegacyG3Adapter } from "../src/LegacyG3Adapter.js"
import { Supersede } from "../src/Supersede.js"
import { Transcript } from "../src/Transcript.js"

/** `trajectory --uid <id> --question "..." [--date "..."] [--from 1] [--step 1]` */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const uid = arg("uid", "")
const question = arg("question", "")
const questionDate = arg("date", "unknown")
const from = Number(arg("from", "1"))
const step = Number(arg("step", "1"))
const concurrency = Number(arg("concurrency", "4"))

const AppLive = LegacyG3Adapter.layer.pipe(
  Layer.provideMerge(Supersede.layer),
  Layer.provideMerge(Transcript.layer),
  Layer.provideMerge(HydraMemoryLive),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  yield* verifyModelsOrExit({ quiet: true })
  const legacy = yield* LegacyG3Adapter

  const sessions = yield* legacy.readSessions(uid)
  const last = sessions.length
  const points: Array<number> = []
  for (let k = from; k <= last; k += step) points.push(k)

  console.log(`uid            ${uid}`)
  console.log(`question       ${question}`)
  console.log(`sessions       ${last}, asking at ${points.length} points`)
  console.log("")

  const answers = yield* Effect.forEach(
    points,
    (k) =>
      Effect.gen(function* () {
        const answered = yield* legacy.answer(uid, question, questionDate, { asOf: k })
        const evidence = answered.ask.evidence.length
        if (answered.read === null || answered.verdict === "ABSENT") {
          return { k, label: `ABSENT (${answered.reason})`, evidence, hash: answered.hash }
        }
        return {
          k,
          label: answered.read.notInMemory ? "NOT_IN_MEMORY" : answered.read.answer,
          evidence,
          hash: answered.hash
        }
      }),
    { concurrency }
  )

  let previous: string | null = null
  const changes: Array<{ k: number; label: string }> = []
  for (const answer of answers) {
    const marker = answer.label === previous ? " " : ">"
    if (answer.label !== previous) changes.push({ k: answer.k, label: answer.label })
    previous = answer.label
    const session = sessions[answer.k - 1]
    console.log(
      `${marker} as of s${String(answer.k).padStart(2)}  ${String(session?.dateInt ?? "").padEnd(9)}` +
        `${String(answer.evidence).padStart(3)} ev   ${answer.label}`
    )
  }

  console.log("")
  console.log(`distinct answers   ${changes.length}`)
  for (const change of changes) console.log(`  from session ${String(change.k).padStart(2)}: ${change.label}`)
})

Effect.runPromise(Effect.provide(program, AppLive)).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
