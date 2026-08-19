import { NodeHttpClient } from "@effect/platform-node"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive, loadDotEnv } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { Retrieve, Supersede } from "../src/index.js"

/**
 * `ask --uid <question_id> --question "..." [--as-of k] [--max-len 2] [--full]`
 *
 * Prints the verdict, the receipt, and the evidence claim keys. No reader yet —
 * this is the retrieval layer on its own, which is what the receipt is for.
 */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const uid = arg("uid", "")
const question = arg("question", "")
const asOfRaw = arg("as-of", "")
const maxLen = Number(arg("max-len", "2"))
const full = process.argv.includes("--full")

const AppLive = Retrieve.Default.pipe(
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  const retrieve = yield* Retrieve
  const started = Date.now()
  const result = yield* retrieve.ask(uid, question, {
    maxLen,
    ...(asOfRaw === "" ? {} : { asOf: Number(asOfRaw) })
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  const r = result.receipt

  console.log(`question       ${question}`)
  console.log(`uid            ${uid}${r.asOf === null ? "" : `   as of session ${r.asOf}`}`)
  console.log("")
  console.log(`VERDICT        ${result.verdict}${result.reason === null ? "" : `  (${result.reason})`}`)
  console.log(`evidence       ${result.evidence.length} claims`)
  console.log(`hash           ${result.hash.slice(0, 16)}`)
  console.log(`latency        ${elapsed} s`)
  console.log("")
  console.log("RECEIPT")
  console.log(`  threshold    convergence >= ${r.convergenceThreshold}`)
  console.log(`  claims       ${r.totalClaims} in this user's graph`)
  console.log(`  historical   ${r.historical}   wants_count ${r.wantsCount}   time_ref ${r.timeRef ?? "-"}`)
  console.log(`  anchors      ${r.anchorTerms.length} asked, ${r.anchorsResolved.length} reached a claim`)
  console.log(`    resolved   ${r.anchorsResolved.join(" ")}`)
  console.log(`    unresolved ${r.anchorsUnresolved.join(" ") || "-"}`)
  console.log(`  query 1      ${r.query1Paths} paths`)
  if (full) {
    console.log(`    ${r.query1}`)
    console.log(`    params ${JSON.stringify(r.query1Params)}`)
  }
  console.log(`  query 2      ${r.query2Paths} paths${r.query2 === null ? "  (not run)" : ""}`)
  if (full && r.query2 !== null) console.log(`    ${r.query2}`)
  console.log("")
  console.log("  convergence table (top 10)")
  for (const row of r.convergence.slice(0, 10)) {
    console.log(
      `    conv ${row.convergence}  idf ${row.score.toFixed(2).padStart(6)}  ${row.ckey.slice(-12)}  ${row.anchors.slice(0, 8).join(" ")}`
    )
  }

  if (result.evidence.length > 0) {
    console.log("")
    console.log("EVIDENCE")
    for (const claim of result.evidence.slice(0, full ? 100 : 12)) {
      const label = claim.status === "CURRENT" ? "CURRENT   " : `SUPERSEDED@${claim.atSession}`
      console.log(`  ${label}  s${String(claim.sessionOrd).padStart(2)}  conv ${claim.convergence}  ${claim.text}`)
      console.log(`               ${claim.sid}#${claim.turnIdx} [${claim.cs},${claim.ce})`)
    }
    if (result.evidence.length > (full ? 100 : 12)) {
      console.log(`  … ${result.evidence.length - (full ? 100 : 12)} more`)
    }
  }
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
