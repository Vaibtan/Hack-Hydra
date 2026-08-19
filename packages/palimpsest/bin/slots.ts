import { NodeHttpClient } from "@effect/platform-node"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive, loadDotEnv } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { Supersede } from "../src/index.js"

/**
 * `slots --uid <question_id> [--skey <slot key>] [--as-of <k>] [--all]`
 *
 * Prints each contested slot's chain with CURRENT / SUPERSEDED labels — the
 * structural answer to "what does the memory believe now, and what did it
 * believe before". `--as-of k` replays the chain as of session k.
 */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const uid = arg("uid", "")
const only = arg("skey", "")
const asOfRaw = arg("as-of", "")
const asOf = asOfRaw === "" ? undefined : Number(asOfRaw)
const showAll = process.argv.includes("--all")

const AppLive = Supersede.Default.pipe(
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  const supersede = yield* Supersede
  const slots =
    only === ""
      ? yield* supersede.contestedSlots(uid)
      : [{ skey: only, entityName: only.split("|")[3] ?? "", attr: only.split("|")[4] ?? "" }]

  console.log(`uid            ${uid}`)
  console.log(`slots >= 2     ${slots.length}${asOf === undefined ? "" : `   (as of session ${asOf})`}`)
  console.log("")

  const allChains = yield* supersede.chains(uid, slots.map((slot) => slot.skey), asOf)

  let chains = 0
  for (const slot of slots) {
    const chain = allChains.get(slot.skey) ?? []
    const superseded = chain.filter((claim) => claim.supersededBy !== null).length
    if (superseded === 0 && !showAll && only === "") continue
    if (superseded > 0) chains++

    console.log(`${slot.entityName} | ${slot.attr}`)
    for (const claim of chain) {
      const label =
        claim.supersededBy === null
          ? "CURRENT   "
          : `SUPERSEDED@${String(claim.atSession).padEnd(3)}`
      console.log(`  ${label}  s${String(claim.sessionOrd).padStart(2)}  ${claim.text}`)
    }
    console.log("")
  }

  console.log(`chains         ${chains} slot(s) have at least one supersession`)
  if (chains === 0 && !showAll) {
    console.log("(pass --all to print contested slots with no supersession)")
  }
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
