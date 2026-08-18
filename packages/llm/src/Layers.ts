import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Layer, Redacted } from "effect"
import { Llm } from "./Llm.js"

/**
 * `.env` is where the key lives (gitignored). Nothing else in the workspace
 * reads it, and it never leaves this layer as anything but a `Redacted`.
 */
const apiKey = Config.redacted("OPENAI_API_KEY").pipe(
  Config.map((value): Redacted.Redacted | undefined => value)
)

export const OpenAiLive = OpenAiClient.layerConfig({ apiKey }).pipe(
  Layer.provide(NodeHttpClient.layerUndici)
)

/** The default stack: Llm over `gpt-5.6-luna` (override with `PALIMPSEST_MODEL`). */
export const languageModelLayer = (model: string) =>
  OpenAiLanguageModel.layer({ model }).pipe(Layer.provide(OpenAiLive))

export const LlmLive = (model = process.env["PALIMPSEST_MODEL"] ?? "gpt-5.6-luna") =>
  Layer.mergeAll(Llm.Default, languageModelLayer(model))
