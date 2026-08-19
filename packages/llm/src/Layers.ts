import { Layer } from "effect"
import { Llm } from "./Llm.js"
import { languageModelLayer } from "./Provider.js"

export { OpenAiLive, languageModelLayer } from "./Provider.js"

/** The default stack: Llm over `gpt-5.6-luna` (override with `PALIMPSEST_MODEL`). */
export const LlmLive = (model = process.env["PALIMPSEST_MODEL"] ?? "gpt-5.6-luna") =>
  Layer.mergeAll(Llm.Default, languageModelLayer(model))
