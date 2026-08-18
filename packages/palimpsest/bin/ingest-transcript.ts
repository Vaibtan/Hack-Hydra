import { NodeHttpClient } from "@effect/platform-node"
import { loadQuestion, type DatasetName } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { Effect, Layer, Option } from "effect"
import { Transcript } from "../src/index.js"

/**
 * `ingest-transcript --uid <question_id> [--dataset oracle|s] [--reset]`
 *
 * Writes one benchmark user's verbatim transcript — Sessions, Turns, HAS_TURN —
 * under that user's key prefix. Re-running is a no-op.
 */
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const uid = arg("uid")
const dataset = (arg("dataset") ?? "oracle") as DatasetName
const reset = process.argv.includes("--reset")

if (uid === undefined) {
  console.error("usage: ingest-transcript --uid <question_id> [--dataset oracle|s] [--reset]")
  process.exit(2)
}

const program = Effect.gen(function* () {
  const transcript = yield* Transcript
  const question = yield* loadQuestion(dataset, uid)
  if (reset) yield* transcript.remove(uid)

  const started = Date.now()
  const report = yield* transcript.ingest(uid, question.sessions)
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  console.log(`uid            ${question.questionId}  (${question.questionType})`)
  console.log(`question       ${question.question}`)
  console.log(`sessions       ${report.sessions}  turns ${report.turns}  in ${elapsed}s`)
  console.log(`answer in      ${question.answerSessionIds.join(", ") || "(none — abstention)"}`)
  console.log(`bookmark       ${Option.getOrElse(report.bookmark, () => "(none)")}`)

  const stored = yield* transcript.readSessions(uid)
  for (const session of stored.slice(0, 5)) {
    console.log(`  ord ${String(session.sessionOrd).padStart(2)}  ${session.dateInt}  ${session.turns} turns  ${session.sid}`)
  }
  if (stored.length > 5) console.log(`  … ${stored.length - 5} more`)
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
