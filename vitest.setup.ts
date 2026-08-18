import { loadDotEnv } from "./packages/llm/src/Env.js"

// The live suites talk to the real OpenAI account; the key lives in the
// gitignored .env at the workspace root.
loadDotEnv(import.meta.dirname)
