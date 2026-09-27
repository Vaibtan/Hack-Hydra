import { NodeHttpClient } from "@effect/platform-node"
import { HydraMemoryLive } from "@palimpsest/hydra"
import { LlmLive, loadDotEnv, verifyModelsOrExit } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { prepareDerivedIndexAssertions, sourceLinkedChainEvidence } from "../src/DerivedAssertion.js"
import { LegacyG3Adapter } from "../src/LegacyG3Adapter.js"
import { Supersede } from "../src/Supersede.js"
import { Transcript } from "../src/Transcript.js"

/** `slots --uid <question_id> [--skey <slot key>] [--as-of <k>] [--all]` */
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

const AppLive = LegacyG3Adapter.layer.pipe(
  Layer.provideMerge(Supersede.layer),
  Layer.provideMerge(Transcript.layer),
  Layer.provideMerge(HydraMemoryLive),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  yield* verifyModelsOrExit({ quiet: true })
  const legacy = yield* LegacyG3Adapter
  const slots =
    only === ""
      ? yield* legacy.contestedSlots(uid)
      : [{ skey: only, entityName: only.split("|")[3] ?? "", attr: only.split("|")[4] ?? "" }]

  console.log(`uid            ${uid}`)
  console.log(`slots >= 2     ${slots.length}${asOf === undefined ? "" : `   (as of session ${asOf})`}`)
  console.log("")

  const allChains = yield* legacy.slotChains(uid, slots.map((slot) => slot.skey), asOf)

  let chains = 0
  for (const slot of slots) {
    const chain = allChains.get(slot.skey) ?? []
    const sourceSpans = yield* legacy.reader.hydrate(sourceLinkedChainEvidence(chain))
    const assertions = prepareDerivedIndexAssertions(chain, sourceSpans)
    if (assertions._tag === "Failure") return yield* Effect.fail(assertions.failure)
    const superseded = assertions.success.filter((assertion) => assertion.supersededBy !== null).length
    if (superseded === 0 && !showAll && only === "") continue
    if (superseded > 0) chains++

    console.log(`${slot.entityName} | ${slot.attr}`)
    for (const assertion of assertions.success) {
      const label =
        assertion.supersededBy === null
          ? "CURRENT   "
          : `SUPERSEDED@${String(assertion.atSession).padEnd(3)}`
      const source = assertion.source
      const start = Math.max(0, Math.min(source.highlight.start, source.excerpt.length))
      const end = Math.max(start, Math.min(source.highlight.end, source.excerpt.length))
      const marked = `${source.excerpt.slice(0, start)}[${source.excerpt.slice(start, end)}]${source.excerpt.slice(end)}`
      console.log(`  ${label}  s${String(assertion.sessionOrd).padStart(2)}  DERIVED INDEX ASSERTION (not evidence)`)
      console.log(`               ${assertion.derivedText}`)
      console.log(`               SOURCE ${source.sid}#${source.turnIdx} [${source.offsetStart},${source.offsetEnd})`)
      console.log(`               ${marked}`)
    }
    console.log("")
  }

  console.log(`chains         ${chains} slot(s) have at least one supersession`)
  if (chains === 0 && !showAll) {
    console.log("(pass --all to print contested slots with no supersession)")
  }
})

Effect.runPromise(Effect.provide(program, AppLive)).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
