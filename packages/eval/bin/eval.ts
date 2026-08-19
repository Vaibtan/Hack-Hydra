import type { LanguageModel } from "@effect/ai"
import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetName, type DatasetQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { Llm, LlmLive, loadDotEnv } from "@palimpsest/llm"
import {
  ClaimGraph,
  Reader,
  Retrieve,
  Supersede,
  determinismHash,
  type HydratedSpan
} from "@palimpsest/palimpsest"
import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  JUDGE_MODEL,
  benchmarkSlice,
  buildIndex,
  fullContextSpans,
  judge,
  renderTable,
  summariseByType,
  topSpans,
  type EvalRow,
  type SystemName
} from "../src/index.js"

/**
 * `eval --slice 100 --system palimpsest|palimpsest-premise|bm25|fullctx|all [--prefix g2]`
 *
 * Answer accuracy, end to end: ask -> reader -> the official LongMemEval judge,
 * for Palimpsest and the two baselines, on one slice, with one judge.
 *
 * The three systems differ in exactly one thing — how the text handed to the
 * reader was chosen. Same reader prompt, same judge model, same questions, so
 * the comparison is about the index and nothing else.
 *
 * Every call is on disk, so a second run of any table costs $0.00 and produces
 * the same labels.
 */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const sliceSize = Number(arg("slice", "100"))
const dataset = arg("dataset", "s") as DatasetName
const prefix = arg("prefix", "g2")
const concurrency = Number(arg("concurrency", "8"))
/**
 * Results belong to the repository, not to whichever package directory pnpm
 * happened to run this from — `pnpm eval` runs inside `packages/eval`.
 */
const workspaceRoot = (): string => {
  let dir = process.cwd()
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

const outDir = resolve(workspaceRoot(), arg("out", "results"))
const judgeModel = arg("judge", JUDGE_MODEL)
/**
 * Measure the users that *are* indexed and say how many were skipped, instead
 * of refusing the whole run. Off by default: a silently partial table is worse
 * than no table, so this has to be asked for and it is printed in the header of
 * every file it produces.
 */
const skipMissing = process.argv.includes("--skip-missing")
/**
 * B2's context budget in characters (~4 chars per token).
 *
 * The largest LongMemEval_S haystack is 513 954 characters — about 128 k tokens
 * — so 520 000 lets **every** haystack through whole and B2 is never truncated.
 * That is deliberate: the point of the full-context baseline is to be the
 * strongest possible "just send everything", and a truncated version of it
 * would be a straw man. `gpt-5.6-luna` accepts it.
 *
 * The truncation policy still exists for a model with a smaller window: the
 * **oldest** sessions are dropped, and every results row records how many.
 * Dropping the newest would flatter this baseline on exactly the
 * knowledge-update questions it should find hard.
 */
const fullCtxChars = Number(arg("fullctx-chars", process.env["PALIMPSEST_FULLCTX_CHARS"] ?? "520000"))

const ALL_SYSTEMS: ReadonlyArray<SystemName> = [
  "palimpsest",
  "palimpsest-premise",
  "bm25",
  "fullctx"
]
const requested = arg("system", "palimpsest")
const systems: ReadonlyArray<SystemName> =
  requested === "all"
    ? ALL_SYSTEMS
    : (requested.split(",").map((s) => s.trim()) as ReadonlyArray<SystemName>)

const uidFor = (questionId: string): string =>
  prefix === "" ? questionId : `${prefix}-${questionId}`

/**
 * What a structural ABSENT verdict says to the judge.
 *
 * The judge sees a model response, not our verdict enum, so the refusal has to
 * be said in words — and it has to be the *same* words every time, or the
 * abstention column would be measuring phrasing.
 */
const absentResponse = (reason: string | null): string =>
  `I don't have that in my memory. ` +
  (reason === "A1_no_anchors"
    ? "None of the question's search terms exist in this user's memory at all."
    : "Search terms exist but no stored claim was reached by enough of them to answer.")

const AppLive = Retrieve.Default.pipe(
  Layer.provideMerge(Reader.Default),
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(ClaimGraph.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const pct = (value: number | null): string =>
  value === null ? "   n/a" : `${(value * 100).toFixed(1)} %`

const program = Effect.gen(function* () {
  const retrieve = yield* Retrieve
  const reader = yield* Reader
  const claimGraph = yield* ClaimGraph
  const llm = yield* Llm

  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  let slice = benchmarkSlice(questions, sliceSize)

  const needsGraph = systems.some((system) => system.startsWith("palimpsest"))

  console.log(`dataset      ${dataset}`)
  console.log(
    `slice        ${slice.length} questions ` +
      `(${slice.filter((q) => q.isAbstention).length} abstention, ` +
      `${slice.filter((q) => !q.isAbstention).length} answerable)`
  )
  console.log(`systems      ${systems.join(", ")}`)
  console.log(`reader       ${llm.model}   judge  ${judgeModel}`)
  console.log(`prefix       ${prefix || "(none)"}   concurrency ${concurrency}`)
  console.log("")

  if (needsGraph) {
    // A user with no claims would score as a structural abstention and be
    // reported as a retrieval failure. Refuse to measure rather than publish a
    // number that is really a missing ingest.
    const missing = yield* Effect.forEach(
      slice,
      (question) =>
        claimGraph
          .claimCount(uidFor(question.questionId))
          .pipe(Effect.map((claims) => (claims === 0 ? question.questionId : null))),
      { concurrency: 8 }
    )
    const notIngested = missing.filter((id) => id !== null)
    if (notIngested.length > 0 && skipMissing) {
      console.log(
        `skipping     ${notIngested.length} of ${slice.length} questions whose users are not indexed`
      )
      console.log(`             ${notIngested.slice(0, 12).join(", ")}${notIngested.length > 12 ? " …" : ""}`)
      console.log("")
      const present = new Set(slice.map((q) => q.questionId).filter((id) => !notIngested.includes(id)))
      slice = slice.filter((question) => present.has(question.questionId))
    } else if (notIngested.length > 0) {
      console.error(`${notIngested.length} of ${slice.length} users are not indexed:`)
      console.error(`  ${notIngested.slice(0, 20).join(", ")}${notIngested.length > 20 ? " …" : ""}`)
      console.error(
        `Run: PALIMPSEST_LLM_CONCURRENCY=48 pnpm ingest-slice --slice ${sliceSize} ` +
          `--dataset ${dataset} --users 7 --prefix ${prefix}`
      )
      console.error(`(or pnpm backfill-user --prefix ${prefix} if they were ingested earlier)`)
      return yield* Effect.sync(() => process.exit(2))
    }
  }

  /** One question through one system, judged. */
  const runOne = (
    system: SystemName,
    question: DatasetQuestion
  ): Effect.Effect<EvalRow, never, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      const uid = uidFor(question.questionId)
      const questionDate = question.questionDate.raw
      const started = Date.now()

      let verdict: "ANSWER" | "ABSENT" = "ANSWER"
      let reason: string | null = null
      let spans: ReadonlyArray<HydratedSpan> = []
      let anchorsAsked = 0
      let anchorsReaching = 0
      let sessionsDropped = 0
      let response = ""
      let notInMemory = false
      let premiseSupported: boolean | null = null
      let premiseNote = ""
      let readerInputTokens = 0
      let readerOutputTokens = 0
      let hash = ""

      if (system === "palimpsest" || system === "palimpsest-premise") {
        const ask = yield* retrieve.ask(uid, question.question, { questionDate })
        verdict = ask.verdict
        reason = ask.reason
        anchorsAsked = ask.receipt.anchorTerms.length
        anchorsReaching = ask.receipt.anchorsReachingClaims.length
        hash = ask.hash

        if (ask.verdict === "ABSENT") {
          response = absentResponse(ask.reason)
          notInMemory = true
          spans = []
        } else {
          const read = yield* reader.read(question.question, questionDate, ask.evidence, {
            premiseCheck: system === "palimpsest-premise"
          })
          spans = read.spans
          response = read.answer
          notInMemory = read.notInMemory
          premiseSupported = read.premiseSupported
          premiseNote = read.premiseNote
          readerInputTokens = read.inputTokens
          readerOutputTokens = read.outputTokens
        }
      } else {
        const selected =
          system === "bm25"
            ? { spans: topSpans(question, buildIndex(question)), dropped: 0 }
            : (() => {
                const full = fullContextSpans(question, fullCtxChars)
                return { spans: full.spans, dropped: full.sessionsDropped }
              })()
        sessionsDropped = selected.dropped
        spans = selected.spans
        hash = determinismHash(selected.spans.map((span) => span.ckey))

        const read = yield* reader.readSpans(question.question, questionDate, selected.spans)
        response = read.answer
        notInMemory = read.notInMemory
        readerInputTokens = read.inputTokens
        readerOutputTokens = read.outputTokens
      }

      const latencyMs = Date.now() - started
      const judgement = yield* judge(question, response, judgeModel)
      const evidenceSessions = [...new Set(spans.map((span) => span.sid))].sort()

      return {
        system,
        questionId: question.questionId,
        questionType: question.questionType,
        isAbstention: question.isAbstention,
        verdict,
        reason,
        answer: response,
        notInMemory,
        premiseSupported,
        premiseNote,
        judged: judgement.correct,
        judgeTemplate: judgement.template,
        judgeReply: judgement.reply,
        judgeModel: judgement.model,
        evidenceSessions,
        answerSessions: [...question.answerSessionIds],
        sessionHit: question.answerSessionIds.some((sid) => evidenceSessions.includes(sid)),
        evidence: spans.length,
        anchorsAsked,
        anchorsReachingClaims: anchorsReaching,
        readerInputTokens,
        readerOutputTokens,
        sessionsDropped,
        latencyMs,
        hash
      } satisfies EvalRow
    }).pipe(Effect.orDie)

  yield* Effect.promise(() => mkdir(outDir, { recursive: true }))
  const bySystem: Array<readonly [SystemName, ReadonlyArray<EvalRow>]> = []

  for (const system of systems) {
    const started = Date.now()
    let done = 0
    const rows = yield* Effect.forEach(
      slice,
      (question) =>
        runOne(system, question).pipe(
          Effect.tap((row) =>
            Effect.sync(() => {
              done++
              if (done % 10 === 0 || done === slice.length) {
                console.log(
                  `  ${system.padEnd(19)} ${String(done).padStart(3)}/${slice.length}  ` +
                    `${((Date.now() - started) / 60_000).toFixed(1)} min  last: ` +
                    `${row.questionId} ${row.judged ? "OK " : "   "}${row.answer.slice(0, 40)}`
                )
              }
            })
          )
        ),
      { concurrency }
    )

    // Written per system, so a failure in the next one loses nothing.
    const path = resolve(outDir, `${system}-${slice.length}.json`)
    yield* Effect.promise(() =>
      writeFile(
        path,
        JSON.stringify(
          {
            system,
            dataset,
            prefix,
            slice: slice.length,
            requestedSlice: sliceSize,
            partial: slice.length !== sliceSize,
            readerModel: llm.model,
            judgeModel,
            fullCtxChars: system === "fullctx" ? fullCtxChars : null,
            rows
          },
          null,
          2
        ),
        "utf8"
      )
    )
    console.log(`  wrote ${path}`)
    console.log("")
    bySystem.push([system, rows])
  }

  const table = [
    `# LongMemEval — ${slice.length}-question slice`,
    "",
    `Dataset \`longmemeval_${dataset}\`, prefix \`${prefix}\`. Reader \`${llm.model}\`, judge ` +
      `\`${judgeModel}\` with the official LongMemEval templates. Every number replays from ` +
      "`.cache/llm` for $0.00.",
    ...(slice.length === sliceSize
      ? []
      : [
          "",
          `> **Partial slice.** ${slice.length} of a requested ${sliceSize} questions. The other ` +
            `${sliceSize - slice.length} users are not indexed in this graph, so they are excluded ` +
            "rather than counted as retrieval failures. Every column below is over the " +
            `${slice.length} that are.`
        ]),
    "",
    renderTable(bySystem)
  ].join("\n")

  const tablePath = resolve(outDir, `table-${slice.length}.md`)
  yield* Effect.promise(() => writeFile(tablePath, table + "\n", "utf8"))

  console.log(table)
  console.log("")
  for (const [system, rows] of bySystem) {
    const all = summariseByType(rows).find((s) => s.type === "ALL")!
    console.log(
      `${system.padEnd(19)} accuracy ${pct(all.accuracy)}   abstention ${pct(all.abstentionAccuracy)}` +
        `   false-abst ${pct(all.falseAbstention)}`
    )
  }

  const usage = yield* llm.usageByModel
  console.log("")
  for (const [model, one] of usage) {
    console.log(
      `${model.padEnd(19)} ${one.calls} live calls, ${one.cacheHits} cached, ` +
        `${one.inputTokens} in / ${one.outputTokens} out`
    )
  }
  console.log(`cost         $${(yield* llm.costUsd).toFixed(4)}`)
  console.log(`wrote        ${tablePath}`)
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
