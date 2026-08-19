import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Layer, Redacted } from "effect"

/**
 * The OpenAI transport, on its own so both `Llm` (which needs to build a layer
 * for a per-call model override) and `Layers` (which assembles the default
 * stack) can reach it without importing each other.
 *
 * `.env` is where the key lives (gitignored). Nothing else in the workspace
 * reads it, and it never leaves this module as anything but a `Redacted`.
 */
const apiKey = Config.redacted("OPENAI_API_KEY").pipe(
  Config.map((value): Redacted.Redacted | undefined => value)
)

export const OpenAiLive = OpenAiClient.layerConfig({ apiKey }).pipe(
  Layer.provide(NodeHttpClient.layerUndici)
)

/**
 * A `LanguageModel` for one named model, carrying its own client — so a layer
 * for the judge can be built beside the one for the reader without either
 * knowing about the other.
 */
export const languageModelLayer = (model: string) =>
  OpenAiLanguageModel.layer({ model }).pipe(Layer.provide(OpenAiLive))
