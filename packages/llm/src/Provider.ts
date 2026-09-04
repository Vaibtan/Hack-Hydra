import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Layer, Redacted } from "effect"

const apiKey = Config.redacted("OPENAI_API_KEY").pipe(
  Config.map((value): Redacted.Redacted | undefined => value)
)

export const OpenAiLive = OpenAiClient.layerConfig({ apiKey }).pipe(
  Layer.provide(NodeHttpClient.layerUndici)
)

export const languageModelLayer = (model: string) =>
  OpenAiLanguageModel.layer({ model }).pipe(Layer.provide(OpenAiLive))
