import { NodeHttpClient } from "@effect/platform-node"
import { HydraClient } from "@palimpsest/hydra"
import { loadDotEnv } from "@palimpsest/llm"
import { Effect, Layer, Option } from "effect"
import { readUserStats, readUserVertices, userKey } from "@palimpsest/palimpsest"

/**
 * `warm --uid g3-001be529 [--uid …]`
 *
 * Touches a user's root and its `HAS_SLOT` / `HAS_ENTITY` / `HAS_SESSION`
 * fan-out so the first real ask is not paying for a page-cache fault.
 *
 * This matters more than it sounds on the benchmark runtime: the SlateDB disk
 * read cache is deliberately disabled in the Compose profile, so a cold vertex
 * is an object-store round trip rather than a page fault, and the demo's first
 * question would otherwise be several seconds slower than every question after
 * it — which is exactly the number a viewer remembers.
 *
 * Reads only. Nothing here writes, so warming a user twice is free and warming
 * the wrong one is harmless.
 */
loadDotEnv()

const uids = process.argv.reduce<Array<string>>((acc, value, index) => {
  if (value === "--uid" && process.argv[index + 1] !== undefined) acc.push(process.argv[index + 1]!)
  return acc
}, [])

if (uids.length === 0) {
  console.error("usage: warm --uid <uid> [--uid <uid> …]")
  process.exit(2)
}

const AppLive = HydraClient.Default.pipe(Layer.provide(NodeHttpClient.layerUndici))

const program = Effect.gen(function* () {
  const hydra = yield* HydraClient

  for (const uid of uids) {
    const started = Date.now()
    const stats = yield* readUserStats(hydra, uid)
    if (Option.isNone(stats)) {
      console.log(`${uid.padEnd(24)} no User vertex — nothing to warm`)
      continue
    }
    // The three fan-outs an ask walks, in one `MSpaths` round trip each from
    // the single `uid|user` source. Concurrent because they are independent.
    const [entities, slots, sessions] = yield* Effect.all(
      [
        readUserVertices(hydra, uid, "HAS_ENTITY"),
        readUserVertices(hydra, uid, "HAS_SLOT"),
        readUserVertices(hydra, uid, "HAS_SESSION")
      ],
      { concurrency: 3 }
    )
    console.log(
      `${uid.padEnd(24)} ${String(stats.value.claims).padStart(6)} claims  ` +
        `${String(entities.length).padStart(4)} entities  ${String(slots.length).padStart(4)} slots  ` +
        `${String(sessions.length).padStart(3)} sessions  ${Date.now() - started} ms` +
        `  (root key ${userKey(uid)})`
    )
  }
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
