import { NodeHttpClient } from "@effect/platform-node"
import { HydraClient } from "@palimpsest/hydra"
import { loadDotEnv } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { ClaimGraph } from "../src/index.js"

/** `stats --uid <question_id> [--slots]` — what a user's graph actually holds. */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const uid = arg("uid", "")
const showSlots = process.argv.includes("--slots")

const AppLive = ClaimGraph.Default.pipe(
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

  const df = yield* hydra.query(
    "MATCH (t:Token) WHERE t.uid = $uid RETURN t.stem AS stem, t.df AS df ORDER BY df DESC LIMIT 10",
    { uid }
  )
  console.log("")
  console.log("most common anchors")
  for (const row of df.rows) {
    console.log(`  ${String(row["stem"]).padEnd(24)}df ${row["df"]}`)
  }

  if (showSlots) {
    const slots = yield* hydra.query(
      "MATCH (c:Claim)-[:FILLS]->(s:Slot) WHERE s.uid = $uid " +
        "RETURN s.skey AS skey, s.entity_name AS entity, s.attr AS attr, count(*) AS n ORDER BY n DESC",
      { uid }
    )
    console.log("")
    console.log("slots by claim count")
    for (const row of slots.rows) {
      if (Number(row["n"]) < 2) continue
      console.log(`  ${String(row["n"]).padStart(3)}  ${row["entity"]} | ${row["attr"]}`)
    }
  }
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
