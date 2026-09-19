import { NodeHttpClient } from "@effect/platform-node"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive, loadDotEnv } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { ClaimGraph } from "../src/ClaimGraph.js"
import { Supersede } from "../src/Supersede.js"

loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const uid = arg("uid", "")
const showSlots = process.argv.includes("--slots")
const showTokens = process.argv.includes("--tokens")

const AppLive = ClaimGraph.layer.pipe(
  Layer.provideMerge(Supersede.layer),
  Layer.provideMerge(HydraClient.layer),
  Layer.provideMerge(LlmLive()),
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

Effect.runPromise(Effect.provide(program, AppLive)).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
