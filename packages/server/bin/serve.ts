import { NodeRuntime } from "@effect/platform-node"
import { loadDotEnv, verifyModelsAtStartup } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { ServerLive } from "../src/Server.js"

/** `serve [--port 8787]` — the API the demo talks to. */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const port = Number(arg("port", process.env["PALIMPSEST_PORT"] ?? "8787"))

// Before the port is bound, not on the first ask. The demo is the caller that
// can least afford to find out about a bad `PALIMPSEST_SELECT_MODEL` from a
// provider error in front of an audience, and it was the one caller with no
// check at all. Fails closed on an unknown id; a provider that cannot be
// reached warns and the server starts.
NodeRuntime.runMain(
  Effect.flatMap(verifyModelsAtStartup(), () => Layer.launch(ServerLive(port)))
)
