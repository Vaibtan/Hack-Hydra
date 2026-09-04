import { Layer } from "effect"
import { Llm } from "./Llm.js"
import { DEFAULT_MODEL, configuredModel } from "./Models.js"
import { languageModelLayer } from "./Provider.js"

export { OpenAiLive, languageModelLayer } from "./Provider.js"

/** The default stack: Llm over `DEFAULT_MODEL`, or `PALIMPSEST_MODEL`. */
export const LlmLive = (model = configuredModel("PALIMPSEST_MODEL") ?? DEFAULT_MODEL) =>
  Layer.mergeAll(Llm.Default, languageModelLayer(model))
