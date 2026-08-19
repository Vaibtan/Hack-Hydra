import { NodeHttpClient } from "@effect/platform-node"
import { HydraClient } from "@palimpsest/hydra"
import { loadDotEnv } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { ClaimGraph, Supersede } from "../src/index.js"

/** `stats --uid <question_id> [--slots] [--tokens]` — what a user's graph actually holds. */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const uid = arg("uid", "")
const showSlots = process.argv.includes("--slots")
const showTokens = process.argv.includes("--tokens")

const AppLive = ClaimGraph.Default.pipe(
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  const claimGraph = yield* ClaimGraph
  const hydra = yield* HydraClient
  const s = yield* claimGraph.stats(uid)

  console.log(`uid              ${uid}`)
  console.log(`sessions         ${s.sessions}`)
  console.log(`turns            ${s.turns}`)
  console.log(`claims           ${s.claims}`)
  console.log(`entities         ${s.entities}`)
  console.log(`slots            ${s.slots}`)
  console.log(`  >= 2 claims    ${s.contestedSlots}`)
  console.log(`tokens           ${s.tokens}`)
  console.log(`supersessions    ${s.supersessions}`)

  if (showSlots) {
    const supersede = yield* Supersede
    const slots = yield* supersede.contestedSlots(uid)
    console.log("")
    console.log("slots by claim count")
    for (const slot of [...slots].sort((a, b) => b.nClaims - a.nClaims)) {
      console.log(`  ${String(slot.nClaims).padStart(3)}  ${slot.entityName} | ${slot.attr}`)
    }
  }

  // The only remaining store-wide scan in the repo, and it is opt-in: there is
  // no `HAS_TOKEN` edge (a user has thousands of Tokens and they are only ever
  // reached from the question side), so a top-df listing has to read the Token
  // label. It cost 8.7 s at 26 users and will exceed the 30 s cap well before
  // 500 — which is exactly why nothing on the product path does this.
  if (showTokens) {
    const df = yield* hydra.query(
      "MATCH (t:Token) WHERE t.uid = $uid RETURN t.stem AS stem, t.df AS df ORDER BY df DESC LIMIT 10",
      { uid }
    )
    console.log("")
    console.log("most common anchors  (store-wide Token scan — slow by construction)")
    for (const row of df.rows) {
      console.log(`  ${String(row["stem"]).padEnd(24)}df ${row["df"]}`)
    }
  }
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
