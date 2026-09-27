import { NodeHttpClient } from "@effect/platform-node"
import { HydraMemoryLive } from "@palimpsest/hydra"
import { LlmLive, loadDotEnv, verifyModelsOrExit } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { answerInSnapshot, unreadAnswer } from "../src/Answer.js"
import { IngestManifestLive } from "../src/IngestManifest.js"
import { layerStaticQueryPrincipal, QueryPrincipalProvider } from "../src/QueryContext.js"
import { Reader } from "../src/Reader.js"
import { Retrieve } from "../src/Retrieve.js"
import { SnapshotSearch } from "../src/SnapshotArms.js"
import { parseTemporalPerspective } from "../src/TimeScope.js"

loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const tenant = arg("tenant", "")
const uid = arg("uid", "")
const question = arg("question", "")
const asOfRaw = arg("as-of", "")
const maxLen = Number(arg("max-len", "2"))
const full = process.argv.includes("--full")
const noRead = process.argv.includes("--no-read")
const questionDate = arg("date", "unknown")
const profileArg = arg("profile", "full")
if (profileArg !== "full" && profileArg !== "fast") {
  console.error(`--profile must be full or fast, not ${JSON.stringify(profileArg)}`)
  process.exit(2)
}
const perspectiveArg = arg("perspective", "")
const parsedPerspective = perspectiveArg === "" ? undefined : parseTemporalPerspective(perspectiveArg)
if (parsedPerspective === null) {
  console.error("--perspective must be recorded-time, valid-time, or bitemporal")
  process.exit(2)
}
const perspective = parsedPerspective
if (tenant === "") {
  console.error("usage: ask --tenant <tenant> --uid <uid> --question <q> [--as-of k] [--date d]")
  process.exit(2)
}
const profile: "full" | "fast" = profileArg

const AppLive = Retrieve.layer.pipe(
  Layer.provideMerge(SnapshotSearch.layer),
  Layer.provideMerge(Reader.layer),
  Layer.provideMerge(layerStaticQueryPrincipal(tenant, "ask-bin")),
  Layer.provideMerge(IngestManifestLive),
  Layer.provideMerge(HydraMemoryLive),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  yield* verifyModelsOrExit({ quiet: true })
  const retrieve = yield* Retrieve
  const reader = yield* Reader
  const principals = yield* QueryPrincipalProvider
  const principal = yield* principals.currentPrincipal.pipe(Effect.orDie)
  const started = Date.now()
  const answerOptions = {
    maxLen,
    profile,
    ...(asOfRaw !== "" && { asOf: Number(asOfRaw) }),
    ...(perspective !== undefined && { perspective })
  }
  const answered = noRead
    ? unreadAnswer(yield* retrieve.ask(principal, uid, question, answerOptions))
    : yield* answerInSnapshot(retrieve, reader, principal, uid, question, questionDate, answerOptions)
  const result = answered.ask
  const answer = answered.read
  const sourceSpans = answer === null ? [] : answer.spans
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  const r = result.receipt
  const plan = result.plan

  console.log(`question       ${question}`)
  console.log(`uid            ${uid}${r.asOf === null ? "" : `   as of session ${r.asOf}`}`)
  console.log("")
  const source =
    answered.verdict === "INCOMPLETE"
      ? `INCOMPLETE  ${answered.reason}`
      : answer === null
        ? `ABSENT  structural: ${answered.reason}`
        : answered.verdict === "ABSENT"
          ? `ABSENT  ${answered.reason}`
          : answer.notInMemory
            ? "ABSENT  reader: NOT_IN_MEMORY"
            : "ANSWER"
  console.log(`VERDICT        ${source}`)
  const temporal = answered.ask.plan.temporal
  if (temporal !== null) {
    console.log(
      `temporal       ${temporal.perspective}  snapshot ${temporal.snapshotId.slice(0, 12)}  ` +
        `watermark ${temporal.watermark}  coverage ${temporal.coverage.revisionsCovered}/${temporal.coverage.scopeRevisions}  ` +
        `complete ${temporal.completeness.complete}`
    )
  }
  if (answer !== null && answered.verdict === "ANSWER" && !answer.notInMemory) {
    console.log(`ANSWER         ${answer.answer}`)
    if (answer.reasoning.trim() !== "") console.log(`reasoning      ${answer.reasoning}`)
    console.log(`cited          ${answer.citedIds.join(" ") || "-"}`)
  }
  console.log(`route          ${plan.route} (${plan.routeReason})`)
  console.log(
    `sufficiency    ${plan.sufficiency.tier}${plan.sufficiency.secondPass ? ", second pass" : ""}` +
      `${plan.sufficiency.missing === "" ? "" : `  missing: ${plan.sufficiency.missing}`}`
  )
  console.log(`source spans   ${sourceSpans.length}`)
  console.log(`hash           ${answered.hash.slice(0, 16)}`)
  console.log(`latency        ${elapsed} s`)
  console.log("")
  console.log("RECEIPT")
  console.log(`  threshold    convergence >= ${r.convergenceThreshold}`)
  console.log(`  claims       ${r.totalClaims} in this snapshot`)
  console.log(`  historical   ${r.historical}   wants_count ${r.wantsCount}   time_ref ${r.timeRef ?? "-"}`)
  console.log(`  anchors      ${r.anchorTerms.length} asked, ${r.anchorsReachingClaims.length} reached a claim`)
  console.log(`    reached    ${r.anchorsReachingClaims.join(" ")}`)
  console.log(`    unreached  ${r.anchorsReachingNothing.join(" ") || "-"}`)
  console.log(`  query 1      ${r.query1Paths} paths`)
  if (full) {
    console.log(`    ${r.query1}`)
    console.log(`    params ${JSON.stringify(r.query1Params)}`)
  }
  console.log(`  query 2      ${r.query2Paths} paths${r.query2 === null ? "  (not run)" : ""}`)
  if (full && r.query2 !== null) console.log(`    ${r.query2}`)
  console.log("")
  console.log("  arms")
  for (const arm of plan.arms) {
    console.log(
      `    ${arm.label.padEnd(28)} ${String(arm.claims).padStart(4)} claims  ${String(arm.paths).padStart(5)} paths` +
        `${arm.timedOut ? "  timed out" : ""}`
    )
  }
  console.log("")
  console.log("  convergence table (top 10)")
  for (const row of r.convergence.slice(0, 10)) {
    console.log(
      `    conv ${row.convergence}  idf ${row.score.toFixed(2).padStart(6)}  ${row.ckey.slice(-12)}  ${row.anchors.slice(0, 8).join(" ")}`
    )
  }

  if (sourceSpans.length > 0) {
    console.log("")
    console.log("SOURCE SPANS — VERBATIM TRANSCRIPT")
    for (const span of sourceSpans.slice(0, full ? 100 : 12)) {
      const label = span.status === "CURRENT" ? "CURRENT   " : `SUPERSEDED@${span.atSession}`
      const start = Math.max(0, Math.min(span.highlight.start, span.excerpt.length))
      const end = Math.max(start, Math.min(span.highlight.end, span.excerpt.length))
      const marked = `${span.excerpt.slice(0, start)}[${span.excerpt.slice(start, end)}]${span.excerpt.slice(end)}`
      console.log(`  ${label}  s${String(span.sessionOrd).padStart(2)}  ${span.sid}#${span.id}`)
      console.log(`               ${marked}`)
    }
    if (sourceSpans.length > (full ? 100 : 12)) {
      console.log(`  … ${sourceSpans.length - (full ? 100 : 12)} more`)
    }
  }
})

Effect.runPromise(Effect.provide(program, AppLive)).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
