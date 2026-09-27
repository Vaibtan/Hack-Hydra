import { NodeHttpClient } from "@effect/platform-node"
import { loadQuestion, parseDatasetName } from "@palimpsest/dataset"
import { HydraMemoryLive } from "@palimpsest/hydra"
import { LlmLive, loadDotEnv, verifyModelsOrExit } from "@palimpsest/llm"
import { ingestGenerationConfig } from "../src/GenerationConfig.js"
import { SourceIndex, SourceIndexLive } from "../src/SourceIndexing.js"
import { Effect, Layer } from "effect"

/** `index-source --uid <question_id> [--dataset s|oracle] [--tenant default]` */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const uid = arg("uid", "")
const dataset = parseDatasetName(arg("dataset", "s"))
const tenant = arg("tenant", "default")

const HttpLive = NodeHttpClient.layerUndici
const HydraLive = HydraMemoryLive.pipe(Layer.provide(HttpLive))
const LlmStackLive = LlmLive().pipe(Layer.provide(HttpLive))
const SourceIndexStackLive = SourceIndexLive.pipe(Layer.provide(HydraLive))
const AppLive = Layer.mergeAll(HydraLive, LlmStackLive, SourceIndexStackLive)

const program = Effect.gen(function* () {
  yield* verifyModelsOrExit({ quiet: true })
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

Effect.runPromise(Effect.provide(program, AppLive)).catch((error) => {
  console.error(String(error))
  process.exit(1)
})
