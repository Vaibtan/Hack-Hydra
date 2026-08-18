import { loadDataset, type DatasetName } from "@palimpsest/dataset"
import { Llm, LlmLive, loadDotEnv } from "@palimpsest/llm"
import { extractSession, mergeEntities, type ExtractedEntity } from "@palimpsest/palimpsest"
import { Effect } from "effect"
import { stratifiedSlice } from "../src/index.js"

/** `drops --slice 20 [--show 10]` — why extraction dropped the spans it dropped. */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const program = Effect.gen(function* () {
  yield* Llm
  const questions = yield* loadDataset(arg("dataset", "oracle") as DatasetName).pipe(Effect.orDie)
  const slice = stratifiedSlice(questions, Number(arg("slice", "20")))

  const reasons = new Map<string, number>()
  const samples: Array<string> = []

  yield* Effect.forEach(
    slice,
    (question) =>
      Effect.gen(function* () {
        let known: ReadonlyArray<ExtractedEntity> = []
        for (const session of question.sessions) {
          const extraction = yield* extractSession(session, known)
          known = mergeEntities(known, extraction.claims)
          for (const drop of extraction.dropped) {
            reasons.set(drop.reason, (reasons.get(drop.reason) ?? 0) + 1)
            if (samples.length < Number(arg("show", "10"))) {
              const turn = session.turns[drop.turnIdx]
              samples.push(
                [
                  `reason  ${drop.reason}  (${question.questionId} ${session.sid}#${drop.turnIdx})`,
                  `claim   ${drop.text}`,
                  `quote   ${JSON.stringify(drop.quote.slice(0, 220))}`,
                  `turn    ${JSON.stringify((turn?.text ?? "(no such turn)").slice(0, 220))}`,
                  ""
                ].join("\n")
              )
            }
          }
        }
      }),
    { concurrency: 8 }
  )

  console.log("drop reasons")
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(20)}${count}`)
  }
  console.log("")
  console.log(samples.join("\n"))
})

Effect.runPromise(Effect.provide(program, LlmLive()) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
