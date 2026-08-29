import type { LanguageModel } from "@effect/ai"
import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetName, type DatasetQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { Llm, LlmLive, loadDotEnv, readPathModels, verifyModels } from "@palimpsest/llm"
import {
  ClaimGraph,
  Reader,
  Retrieve,
  Supersede,
  answerV2,
  determinismHash,
  type HydratedSpan
} from "@palimpsest/palimpsest"
import { Effect, Layer } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  JUDGE_MODEL,
  SPLIT_FILE,
  SYSTEM_NAMES,
  assertGenerationMatches,
  benchmarkSlice,
  buildIndex,
  errorClass,
  fullContextSpans,
  isSystemName,
  judge,
  liveExtractionGeneration,
  oracleSessionSpans,
  renderTable,
  summariseByType,
  topSpans,
  type EvalRow,
  type SplitFile,
  type SystemName
} from "../src/index.js"

/**
 * `eval --system palimpsest,palimpsest-v2,bm25,fullctx,oracle-session|all`
 * `     [--split dev|test | --slice 100] [--prefix g3] [--profile full|fast]`
 *
 * Answer accuracy, end to end: ask -> reader -> the official LongMemEval judge,
 * for Palimpsest and the baselines, on one population, with one judge.
 *
 * The systems differ in exactly one thing — how the text handed to the reader
 * was chosen. Same reader prompt, same judge model, same questions, so the
 * comparison is about the index and nothing else.
 *
 * Every call is on disk, so a second run of any table costs $0.00 and produces
 * the same labels.
 *
 * `--split` is the honest form and `--slice` the exploratory one: a split names
 * a committed id list and refuses to touch `test` before a gate record exists,
 * while a slice is whatever `benchmarkSlice` computes today.
 */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const sliceSize = Number(arg("slice", "100"))
const dataset = arg("dataset", "s") as DatasetName
const concurrency = Number(arg("concurrency", "8"))
const split = arg("split", "")
const profile = arg("profile", "full")
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
 * v2 ablations. Each switches off exactly one stage, and the set is written
 * into every row and into the envelope — a results file must never be
 * ambiguous about which pipeline produced it.
 */
const ablations = {
  ...(process.argv.includes("--no-decompose") ? { noDecompose: true } : {}),
  ...(process.argv.includes("--no-discovery") ? { noDiscovery: true } : {}),
  ...(process.argv.includes("--no-time-scope") ? { noTimeScope: true } : {}),
  ...(process.argv.includes("--no-select") ? { noSelect: true } : {})
} as const
const noSufficiency = process.argv.includes("--no-sufficiency")
const noReaderRoute = arg("reader-route", "on") === "off"
const ablationNames = [
  ...Object.keys(ablations),
  ...(noSufficiency ? ["noSufficiency"] : []),
  ...(noReaderRoute ? ["noReaderRoute"] : [])
].sort()
/** Forces one granularity for every route, for the `span|turn` ablation. */
const granularityFlag = arg("granularity", "")
const granularityOverride =
  granularityFlag === "span" || granularityFlag === "turn" ? granularityFlag : undefined
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
  "palimpsest-v2",
  "palimpsest-premise",
  "oracle-session",
  "bm25",
  "fullctx"
]
const requested = arg("system", "palimpsest")
const named = requested === "all" ? [...ALL_SYSTEMS] : requested.split(",").map((s) => s.trim())
// An unknown name used to fall through `runOne`'s final `else` and be measured
// as full context, so `--system palimsest` produced a plausible table for a
// system nobody ran. Fail before anything is spent.
const unknown = named.filter((name) => !isSystemName(name))
if (unknown.length > 0) {
  console.error(`unknown --system value(s): ${unknown.join(", ")}`)
  console.error(`known systems: ${SYSTEM_NAMES.join(", ")}, or "all"`)
  process.exit(2)
}
const systems: ReadonlyArray<SystemName> = named.filter(isSystemName)

if (split !== "" && split !== "dev" && split !== "test") {
  console.error(`--split must be dev or test, not ${JSON.stringify(split)}`)
  process.exit(2)
}
if (profile !== "full" && profile !== "fast") {
  console.error(`--profile must be full or fast, not ${JSON.stringify(profile)}`)
  process.exit(2)
}

/**
 * The committed split, when one was asked for.
 *
 * Three refusals live here, all of them cheap and all of them things that
 * cannot be checked after the fact:
 *
 *  - `--split test` without a gate record: the test half is read **once**, and
 *    only once the dev gate has been written down. Reading it earlier is how a
 *    test number quietly becomes a tuning signal.
 *  - an extraction generation that no longer matches the one the graph was
 *    built with: the two halves of a comparison would have been extracted by
 *    different prompts, with nothing in the results to say so.
 *  - a split file naming questions the dataset does not contain.
 */
const splitFile: SplitFile | null = (() => {
  if (split === "") return null
  const path = resolve(workspaceRoot(), SPLIT_FILE)
  if (!existsSync(path)) {
    console.error(`--split ${split} needs ${SPLIT_FILE}; run \`pnpm splits\` and commit it first`)
    process.exit(2)
  }
  const file = JSON.parse(readFileSync(path, "utf8")) as SplitFile
  if (split === "test" && file.gate === null) {
    console.error(
      `refusing --split test: ${SPLIT_FILE} has no gate record. The test half is read once, ` +
        "after the dev gate is written down."
    )
    process.exit(2)
  }
  assertGenerationMatches(file)
  return file
})()

const prefix = arg("prefix", splitFile?.prefix ?? "g3")

const uidFor = (questionId: string): string =>
  prefix === "" ? questionId : `${prefix}-${questionId}`

/**
 * What a structural ABSENT verdict says to the judge.
 *
 * The judge sees a model response, not our verdict enum, so the refusal has to
 * be said in words — and it has to be the *same* words every time, or the
 * abstention column would be measuring phrasing.
 */
/**
 * The refusal a judge sees, phrased by *why* the memory refused.
 *
 * The judge scores an abstention question on whether the system declined, not
 * on the wording, so this exists for the reader of a results file: four
 * structurally different refusals that all said "I don't have that" would be
 * indistinguishable in the answer column.
 */
const absentResponse = (reason: string | null): string =>
  `I don't have that in my memory. ` +
  (reason === "A1_no_anchors"
    ? "None of the question's search terms exist in this user's memory at all."
    : reason === "INSUFFICIENT_EVIDENCE"
      ? "The memory holds some of what the question needs and, after searching again for the rest, not all of it."
      : reason === "CONTRADICTED_PREMISE"
        ? "The question assumes something the memory contradicts."
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

  // Before anything is paid for. A typo in a model id is otherwise a five-hour
  // run that produces a table of provider errors -- or, on a provider that
  // silently substitutes, a table of real numbers from a model nobody chose.
  const models = readPathModels(llm.model)
  yield* verifyModels(models, { extra: [judgeModel] }).pipe(
    Effect.tapError((error) => Effect.sync(() => console.error(error.message))),
    Effect.orDie
  )

  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  let slice: ReadonlyArray<DatasetQuestion>
  if (splitFile === null) {
    slice = benchmarkSlice(questions, sliceSize)
  } else {
    // The ids, not a recomputation of them: the whole guarantee of a split file
    // is that the lists did not move between the commit and the run.
    const wanted = new Set(split === "dev" ? splitFile.dev : splitFile.test)
    slice = questions
      .filter((question) => wanted.has(question.questionId))
      .sort((a, b) => a.questionId.localeCompare(b.questionId))
    if (slice.length !== wanted.size) {
      console.error(
        `${SPLIT_FILE} names ${wanted.size} ${split} questions but the dataset holds ` +
          `${slice.length} of them`
      )
      return yield* Effect.sync(() => process.exit(2))
    }
  }

  // The size the population *should* be, kept before `--skip-missing` can
  // shrink it, so a partial run cannot describe itself as a whole one.
  const requestedCount = slice.length

  // `--slice` never loads the split file, and `benchmarkSlice(100)` contains 40
  // of the 140 test questions — so the *default* invocation used to answer,
  // judge and write test rows with `gate: null` still in the file. The refusal
  // has no escape hatch on purpose: an escape hatch is how a test number
  // becomes a tuning signal.
  if (splitFile === null && existsSync(resolve(workspaceRoot(), SPLIT_FILE))) {
    const committed = JSON.parse(
      readFileSync(resolve(workspaceRoot(), SPLIT_FILE), "utf8")
    ) as SplitFile
    if (committed.gate === null) {
      const testIds = new Set(committed.test)
      const leaked = slice.filter((question) => testIds.has(question.questionId))
      if (leaked.length > 0) {
        console.error(
          `refusing --slice ${sliceSize}: it contains ${leaked.length} of the ${committed.test.length} ` +
            `test questions and ${SPLIT_FILE} has no gate record. Use --split dev.`
        )
        return yield* Effect.sync(() => process.exit(2))
      }
    }
  }

  const needsGraph = systems.some((system) => system.startsWith("palimpsest"))

  console.log(`dataset      ${dataset}`)
  console.log(
    `${(split === "" ? "slice" : `split ${split}`).padEnd(12)} ${slice.length} questions ` +
      `(${slice.filter((q) => q.isAbstention).length} abstention, ` +
      `${slice.filter((q) => !q.isAbstention).length} answerable)`
  )
  console.log(`systems      ${systems.join(", ")}`)
  console.log(`reader       ${llm.model}   judge  ${judgeModel}   profile ${profile}`)
  console.log(`prefix       ${prefix || "(none)"}   concurrency ${concurrency}`)
  console.log(`generation   ${liveExtractionGeneration().id}`)
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
    if (notIngested.length > 0 && skipMissing && split === "test") {
      // The test half is read once and must be read whole. A subset of it is
      // exactly the users the ingest happened to succeed on, which is not a
      // random sample of the population, and the writeup would report it as
      // "the 140-question test".
      console.error(
        `refusing --skip-missing on --split test: ${notIngested.length} of ${slice.length} ` +
          "users are not indexed. Finish the ingest, or record a capacity-capped population " +
          `in ${SPLIT_FILE} and regenerate the split.`
      )
      return yield* Effect.sync(() => process.exit(2))
    }
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
      let claimHash: string | undefined
      let route: string | null = null
      let flags: ReadonlyArray<string> | undefined
      let selectorFallback: boolean | undefined
      let unionSessions: ReadonlyArray<string> | undefined
      let budgetDroppedSessions: ReadonlyArray<string> | undefined
      let granularity: string | undefined
      let estimatedTokens: number | undefined
      let sufficiencyTier: string | undefined
      let secondPass: boolean | undefined
      let recited: boolean | undefined
      let askMs: number | undefined
      let graphMs: number | undefined
      let stageTimingsMs: Record<string, number> | undefined

      if (system === "palimpsest-v2") {
        // v2 goes through the orchestrator, so the eval and the demo cannot
        // drift into running different pipelines: retrieve, pack, check, one
        // refined pass at most, read.
        const answered = yield* answerV2(retrieve, reader, uid, question.question, questionDate, {
          profile,
          ablations,
          ...(noSufficiency ? { noSufficiency: true } : {}),
          ...(noReaderRoute ? { noReaderRoute: true } : {}),
          ...(granularityOverride === undefined ? {} : { granularity: granularityOverride })
        })
        const ask = answered.ask
        const plan = ask.plan
        askMs = ask.timings.askMs
        graphMs = ask.timings.graphMs
        stageTimingsMs = { ...ask.timings.stages }
        verdict = answered.verdict
        reason = answered.reason
        anchorsAsked = ask.receipt.anchorTerms.length
        anchorsReaching = ask.receipt.anchorsReachingClaims.length
        claimHash = ask.hash
        hash = ask.hash
        sufficiencyTier = answered.sufficiency.skipped ? "skipped" : answered.sufficiency.tier
        secondPass = answered.secondPass
        if (plan !== null) {
          route = plan.route
          flags = Object.entries(plan.flags)
            .filter(([, on]) => on === true)
            .map(([name]) => name)
            .sort()
          selectorFallback = plan.selection.fallback
          unionSessions = plan.unionSessions
        }

        const read = answered.read
        if (read === null) {
          response = absentResponse(ask.reason)
          notInMemory = true
          spans = []
        } else {
          spans = read.spans
          // An abstention decided *after* reading still reports the reader's
          // spans, because they are what the decision was made on -- but the
          // answer the user gets is the refusal, not the one the reader wrote.
          response = answered.verdict === "ABSENT" ? absentResponse(answered.reason) : read.answer
          notInMemory = answered.verdict === "ABSENT" || read.notInMemory
          premiseSupported = read.premiseSupported
          premiseNote =
            answered.sufficiency.premise === "" ? read.premiseNote : answered.sufficiency.premise
          readerInputTokens = read.inputTokens
          readerOutputTokens = read.outputTokens
          graphMs = (graphMs ?? 0) + read.hydrateMs
          stageTimingsMs = { ...stageTimingsMs, hydrate: read.hydrateMs, read: read.readMs }
          hash = read.spanHash
          granularity = read.granularity
          estimatedTokens = read.estimatedTokens
          budgetDroppedSessions = read.budgetDroppedSessions
          recited = read.recited
        }
      } else if (system.startsWith("palimpsest")) {
        const ask = yield* retrieve.ask(uid, question.question, {
          questionDate,
          pipeline: "v1"
        })
        askMs = ask.timings.askMs
        graphMs = ask.timings.graphMs
        stageTimingsMs = { ...ask.timings.stages }
        verdict = ask.verdict
        reason = ask.reason
        anchorsAsked = ask.receipt.anchorTerms.length
        anchorsReaching = ask.receipt.anchorsReachingClaims.length
        hash = ask.hash
        claimHash = ask.hash

        if (ask.verdict === "ABSENT") {
          response = absentResponse(ask.reason)
          notInMemory = true
          spans = []
        } else {
          // No pack option: v1's evidence has to stay byte-identical while both
          // pipelines read one graph, and the pack stage would change it.
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
          // Hydration is a HydraDB stage that happens outside `ask`, so the
          // graph number is only whole once it is added back.
          graphMs = (graphMs ?? 0) + read.hydrateMs
          stageTimingsMs = { ...stageTimingsMs, hydrate: read.hydrateMs, read: read.readMs }
        }
      } else {
        const selected =
          system === "bm25"
            ? { spans: topSpans(question, buildIndex(question)), dropped: 0 }
            : system === "oracle-session"
              ? { spans: oracleSessionSpans(question), dropped: 0 }
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

      const row = {
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
        hash,
        route,
        ...(askMs === undefined ? {} : { askMs }),
        ...(graphMs === undefined ? {} : { graphMs }),
        ...(stageTimingsMs === undefined ? {} : { stageTimingsMs }),
        ...(claimHash === undefined ? {} : { claimHash }),
        ...(flags === undefined ? {} : { flags }),
        ...(selectorFallback === undefined ? {} : { selectorFallback }),
        ...(unionSessions === undefined ? {} : { unionSessions }),
        ...(budgetDroppedSessions === undefined ? {} : { budgetDroppedSessions }),
        ...(granularity === undefined ? {} : { granularity }),
        ...(estimatedTokens === undefined ? {} : { estimatedTokens }),
        ...(sufficiencyTier === undefined ? {} : { sufficiencyTier }),
        ...(secondPass === undefined ? {} : { secondPass }),
        ...(recited === undefined ? {} : { recited }),
        ...(system === 'palimpsest-v2' ? { keptSessions: evidenceSessions, ablations: ablationNames } : {})
      } satisfies EvalRow
      // Derived, and recomputed by `pnpm table` from the same function, so the
      // column in the file and the column in the table can never disagree.
      return { ...row, errorClass: errorClass(row) } satisfies EvalRow
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

    // Written per system, so a failure in the next one loses nothing. A split
    // run is named by its split rather than its size, so a `dev` file can never
    // be mistaken for the 60-question slice of a different graph that happens
    // to have the same row count.
    // An ablation writes its own file. Without the suffix `--no-select` would
    // silently overwrite the full-pipeline results with numbers that look the
    // same shape, and nothing in the file name would say which run it was.
    const variant = [
      ...(system === 'palimpsest-v2' ? ablationNames.map((name) => name.replace('no', 'no-').toLowerCase()) : []),
      ...(granularityOverride === undefined ? [] : [`granularity-${granularityOverride}`])
    ].join('-')
    const path = resolve(
      outDir,
      `${system}-${split === "" ? slice.length : split}${variant === '' ? '' : `-${variant}`}.json`
    )
    yield* Effect.promise(() =>
      writeFile(
        path,
        JSON.stringify(
          {
            system,
            dataset,
            prefix,
            split: split === "" ? null : split,
            profile,
            slice: slice.length,
            requestedSlice: split === "" ? sliceSize : requestedCount,
            partial: slice.length !== (split === "" ? sliceSize : requestedCount),
            // All three verified against the provider before the run started.
            readerModel: models.reader,
            selectModel: models.select,
            sufficiencyModel: models.sufficiency,
            judgeModel,
            extractionGeneration: liveExtractionGeneration().id,
            // Named in the envelope as well as on every row: an ablation file
            // and a full-pipeline file are otherwise the same shape with
            // quietly different numbers, and the filename does not say which.
            ablations: system === 'palimpsest-v2' ? ablationNames : [],
            granularity: granularityOverride ?? null,
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

  // The per-type table only, for immediate feedback. `pnpm table` rebuilds this
  // *and* the error-class funnel and the paired comparisons, from the JSON
  // alone — which is the version that belongs in a writeup, because it can be
  // regenerated without a graph.
  const table = [
    `# LongMemEval — ${slice.length}-question ${split === "" ? "slice" : `${split} split`}`,
    "",
    `Dataset \`longmemeval_${dataset}\`, prefix \`${prefix}\`, profile \`${profile}\`. Reader ` +
      `\`${llm.model}\`, judge \`${judgeModel}\` with the official LongMemEval templates. Every ` +
      "number replays from `.cache/llm` for $0.00.",
    ...(slice.length === (split === "" ? sliceSize : requestedCount)
      ? []
      : [
          "",
          `> **Partial ${split === "" ? "slice" : `${split} split`}.** ${slice.length} of a ` +
            `requested ${split === "" ? sliceSize : requestedCount} questions. The other ` +
            `${(split === "" ? sliceSize : requestedCount) - slice.length} users are not indexed ` +
            "in this graph, so they are excluded rather than counted as retrieval failures. " +
            `Every column below is over the ${slice.length} that are.`
        ]),
    "",
    renderTable(bySystem)
  ].join("\n")

  const tablePath = resolve(outDir, `table-${split === "" ? slice.length : split}.md`)
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
