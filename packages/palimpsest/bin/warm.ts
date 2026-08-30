import { NodeHttpClient } from "@effect/platform-node"
import { HydraClient } from "@palimpsest/hydra"
import { loadDotEnv } from "@palimpsest/llm"
import { Effect, Layer, Option } from "effect"
import { userKey, warmUser } from "@palimpsest/palimpsest"

/**
 * `warm --uid g3-001be529 [--uid …] [--deep]`
 *
 * Reads the blocks an ask will read, before the ask, so the demo's first
 * question is not the one that pays for them. The walk itself — and why it
 * touches Tokens by going backwards along `NAMES` rather than forwards from the
 * `User` root, which has no edge to a Token — is documented on `warmUser`.
 *
 * The server exposes the same function at `POST /users/:uid/warm`, so the demo
 * and this command cannot warm different things.
 *
 * Reads only. Warming twice is free and warming the wrong user is harmless.
 */
loadDotEnv()

const uids = process.argv.reduce<Array<string>>((acc, value, index) => {
  if (value === "--uid" && process.argv[index + 1] !== undefined) acc.push(process.argv[index + 1]!)
  return acc
}, [])
const deep = process.argv.includes("--deep")

if (uids.length === 0) {
  console.error("usage: warm --uid <uid> [--uid <uid> …] [--deep]")
  process.exit(2)
}

const AppLive = HydraClient.Default.pipe(Layer.provide(NodeHttpClient.layerUndici))

const program = Effect.gen(function* () {
  const hydra = yield* HydraClient

  for (const uid of uids) {
    const report = yield* warmUser(hydra, uid, { deep })
    if (Option.isNone(report)) {
      console.log(`${uid.padEnd(24)} no User vertex — nothing to warm`)
      continue
    }
    const it = report.value
    console.log(
      `${uid.padEnd(24)} ${String(it.entities).padStart(4)} entities  ` +
        `${String(it.slots).padStart(4)} slots  ${String(it.sessions).padStart(3)} sessions  ` +
        `${String(it.tokens).padStart(5)} tokens  ${String(it.slotClaims).padStart(5)} slot claims  ` +
        `${String(it.turns).padStart(5)} turns` +
        (deep ? `  ${String(it.hitClaims).padStart(6)} claims via HITS` : "") +
        `  ${it.ms} ms  (root key ${userKey(uid)})`
    )
  }
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
