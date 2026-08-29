import { NodeHttpClient } from "@effect/platform-node"
import { loadQuestion, type DatasetName } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive, loadDotEnv } from "@palimpsest/llm"
import {
  SourceIndex,
  SourceIndexLive,
  ingestGenerationConfig
} from "../src/index.js"
import { Effect, Layer } from "effect"

/**
 * `index-source --uid <question_id> [--dataset s|oracle] [--tenant default]`
 *
 * Writes only the immutable source and generation-scoped index planes through
 * `INDEXED`. It neither activates that generation for retrieval nor reports a
 * terminal `COMMITTED` ingest.
 */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const uid = arg("uid", "")
const dataset = arg("dataset", "s") as DatasetName
const tenant = arg("tenant", "default")

const RuntimeLive = NodeHttpClient.layerUndici.pipe(
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive())
)

const AppLive = RuntimeLive.pipe(Layer.provideMerge(SourceIndexLive))

const program = Effect.gen(function* () {
  if (uid === "") {
    console.error("usage: index-source --uid <question_id> [--dataset s|oracle] [--tenant default]")
    return yield* Effect.sync(() => process.exit(2))
  }
  const generation = yield* ingestGenerationConfig
  const sourceIndex = yield* SourceIndex
  const question = yield* loadQuestion(dataset, uid).pipe(Effect.orDie)

  console.log(`uid        ${question.questionId}  (${question.questionType})`)
  console.log(`dataset    ${dataset}`)
  console.log(`extract    ${generation.extractionGeneration.id}`)
  console.log(`index      ${generation.indexGeneration.id}`)

  for (const session of question.sessions) {
    const result = yield* sourceIndex.indexSession({
      tenant,
      uid: question.questionId,
      session,
      generation
    })
    console.log(
      `session    ${String(result.revision.sessionOrdinal).padStart(3)}  ${result.revision.logicalSessionId}` +
        `  ${result.revision.state}${result.alreadyAtTarget ? " (already indexed)" : ""}`
    )
  }
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch((error) => {
  console.error(String(error))
  process.exit(1)
})
