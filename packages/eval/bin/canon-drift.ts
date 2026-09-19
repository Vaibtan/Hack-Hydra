import { NodeHttpClient } from "@effect/platform-node"
import { loadQuestion, parseDatasetName } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive, loadDotEnv } from "@palimpsest/llm"
import { ClaimGraph, extractSession, slotKey } from "@palimpsest/palimpsest"
import { Effect, Layer } from "effect"

/** `canon-drift --uid <question_id>` — slot keys that differ between an empty-graph and an as-is reconcile. */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const uid = arg("uid", "")

const AppLive = ClaimGraph.layer.pipe(
  Layer.provideMerge(HydraClient.layer),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  const claimGraph = yield* ClaimGraph
  const question = yield* loadQuestion(parseDatasetName(arg("dataset", "s")), uid).pipe(Effect.orDie)

  const extractions = yield* Effect.forEach(
    question.sessions,
    (session) => extractSession(session),
    { concurrency: "unbounded" }
  )
  const claims = extractions.flatMap((extraction) => extraction.claims)

  const cold = claimGraph.reconcileAll([], claims)
  const warm = claimGraph.reconcileAll(yield* claimGraph.readEntities(uid), claims)

  const slotsFor = (rename: ReadonlyMap<string, string>) =>
    new Set(
      claims
        .filter((claim) => claim.slot !== null)
        .map((claim) =>
          slotKey(uid, rename.get(claim.slot!.entityCanon) ?? claim.slot!.entityCanon, claim.slot!.attr)
        )
    )

  const coldSlots = slotsFor(cold.rename)
  const warmSlots = slotsFor(warm.rename)

  console.log(`claims        ${claims.length}`)
  console.log(`slots cold    ${coldSlots.size}`)
  console.log(`slots warm    ${warmSlots.size}`)
  console.log("")

  for (const skey of warmSlots) {
    if (!coldSlots.has(skey)) console.log(`only warm  ${skey}`)
  }
  for (const skey of coldSlots) {
    if (!warmSlots.has(skey)) console.log(`only cold  ${skey}`)
  }

  console.log("")
  for (const [from, to] of warm.rename) {
    const coldTo = cold.rename.get(from) ?? from
    if (coldTo !== to) console.log(`canon moved  "${from}": cold -> "${coldTo}", warm -> "${to}"`)
  }
})

Effect.runPromise(Effect.provide(program, AppLive)).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
