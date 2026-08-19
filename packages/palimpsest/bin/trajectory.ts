import { NodeHttpClient } from "@effect/platform-node"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive, loadDotEnv } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { Reader, Retrieve, Supersede, Transcript } from "../src/index.js"

/**
 * `trajectory --uid <id> --question "..." [--date "..."] [--from 1] [--step 1]`
 *
 * Asks the same question as of every session in turn and prints what the memory
 * believed at each step. This is the as-of scrubber as a command: one graph, no
 * re-ingest, no snapshots — just `session_ord ≤ k` and `at_session ≤ k`.
 */
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

const AppLive = Retrieve.Default.pipe(
  Layer.provideMerge(Reader.Default),
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(Transcript.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  const retrieve = yield* Retrieve
  const reader = yield* Reader
  const transcript = yield* Transcript

  const sessions = yield* transcript.readSessions(uid)
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
        const result = yield* retrieve.ask(uid, question, { asOf: k })
        if (result.verdict === "ABSENT") {
          return { k, label: `ABSENT (${result.reason})`, evidence: 0, hash: result.hash }
        }
        const answer = yield* reader.read(question, questionDate, result.evidence)
        return {
          k,
          label: answer.notInMemory ? "NOT_IN_MEMORY" : answer.answer,
          evidence: result.evidence.length,
          hash: result.hash
        }
      }),
    { concurrency }
  )

  // Only the steps where the belief actually changed are interesting; the rest
  // are the memory holding still, which is the point.
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

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
