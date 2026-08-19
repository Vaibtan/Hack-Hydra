import { NodeRuntime } from "@effect/platform-node"
import { loadDotEnv } from "@palimpsest/llm"
import { Layer } from "effect"
import { ServerLive } from "../src/Server.js"

/** `serve [--port 8787]` — the API the demo talks to. */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const port = Number(arg("port", process.env["PALIMPSEST_PORT"] ?? "8787"))

NodeRuntime.runMain(Layer.launch(ServerLive(port)))
