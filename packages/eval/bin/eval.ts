import type { LanguageModel } from "@effect/ai"
import { NodeHttpClient } from "@effect/platform-node"
import { loadDataset, type DatasetQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { Llm, LlmLive, loadDotEnv, readPathModels, verifyModels } from "@palimpsest/llm"
import { ClaimGraph, Reader, Retrieve, Supersede } from "@palimpsest/palimpsest"
import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import {
  JUDGE_MODEL,
  LIVE_SYSTEMS,
  RETIRED_SYSTEMS,
  SPLIT_FILE,
  SYSTEMS,
  ablationNames,
  arg,
  assertGenerationMatches,
  batchOf,
  benchmarkSlice,
  flag,
  isSystemName,
  judge,
  judgeTemplate,
  legacyFreezeFindings,
  legacyQualificationFindings,
  leakedTestIds,
  liveExtractionGeneration,
  notIngested,
  orExit,
  parseAblations,
  parseBatch,
  parseDataset,
  parseGranularity,
  parseProfile,
  parseSplit,
  pct,
  readRuntimeConfig,
  readLegacyFreeze,
  readLegacyQualification,
  readSplitFile,
  renderRunTable,
  responseOf,
  resultsStem,
  rowFromBaseline,
  rowFromV2,
  splitFilePath,
  splitQuestions,
  summariseByType,
  testGateRefusal,
  uidFor,
  variantTokens,
  workspaceRoot,
  writeAtomic,
  writeEnvelopeAtomic,
  writeEnvelopeExclusive,
  writeExclusive,
  type EvalEnvelope,
  type EvalRow,
  type SystemDeps,
  type SystemName
} from "../src/index.js"

/**
 * `eval --system palimpsest-v2,bm25,fullctx,oracle-session|all [--split dev|test | --slice 100]`
 * `     [--prefix g3] [--profile full|fast] [--batch 3/12] [--skip-missing] [ablation flags]`
 */
loadDotEnv()

const refuse = (message: string): never => {
  console.error(message)
  process.exit(2)
}

const root = workspaceRoot()
const frozenArg = arg("frozen", "")
const frozenPurpose =
  frozenArg === ""
    ? null
    : frozenArg === "dev-replay" || frozenArg === "dev-qualification" || frozenArg === "test-arm"
      ? frozenArg
      : refuse(`--frozen must be dev-replay, dev-qualification, or test-arm, not ${JSON.stringify(frozenArg)}`)
const manifestArg = arg("manifest", "")
if (frozenPurpose !== null && manifestArg === "") refuse("a frozen run requires --manifest <absolute retrieval-v2.freeze.json>")
const loadedQualification = frozenPurpose === "dev-qualification" ? readLegacyQualification(manifestArg) : null
const loadedFreeze =
  frozenPurpose === null ? null : loadedQualification?.source ?? readLegacyFreeze(manifestArg)
const frozenManifest = loadedFreeze?.manifest ?? null
const qualificationArm = loadedQualification?.manifest.contract.arm ?? null
const standardFrozenArm =
  frozenManifest === null || frozenPurpose === null || frozenPurpose === "dev-qualification"
    ? null
    : frozenPurpose === "dev-replay"
      ? frozenManifest.contract.devReplay
      : frozenManifest.contract.testArm
const frozenArm = qualificationArm ?? standardFrozenArm
const qualificationContract = loadedQualification?.manifest.contract ?? null
if (frozenPurpose !== null && !flag("authorized")) {
  refuse(`--frozen ${frozenPurpose} requires --authorized after explicit runtime/spend approval`)
}

const sliceSize = Number(arg("slice", "100"))
const dataset = orExit(() => parseDataset(arg("dataset", "s")))
const concurrency = Number(arg("concurrency", "8"))
const requestedSplit = orExit(() => parseSplit(arg("split", "")))
const split = frozenArm?.split ?? requestedSplit
const profile = orExit(() => parseProfile(arg("profile", "full")))
const batch = orExit(() => parseBatch(arg("batch", "")))
const ablations = parseAblations()
const granularity = orExit(() => parseGranularity(arg("granularity", "")))
const skipMissing = flag("skip-missing")
const explicitPass = arg("pass", "")
if (frozenPurpose === "dev-qualification" && explicitPass !== "cold" && explicitPass !== "warm") {
  refuse("a frozen dev qualification requires --pass cold or --pass warm")
}
const qualificationPhase =
  loadedQualification === null
    ? null
    : explicitPass === "cold"
      ? loadedQualification.manifest.contract.arm.priming
      : loadedQualification.manifest.contract.arm.counted
const judgeModel =
  (frozenPurpose === "test-arm" || frozenPurpose === "dev-qualification") && frozenManifest !== null
    ? loadedQualification?.manifest.contract.scoring.model ?? frozenManifest.contract.scoring.model
    : arg("judge", JUDGE_MODEL)
const expectedOutputRoot = qualificationPhase?.outputRoot ?? standardFrozenArm?.outputRoot ?? "results"
const outRelative = arg("out", expectedOutputRoot)
const outputBase = loadedQualification?.evidenceRoot ?? root
const outDir = resolve(outputBase, outRelative)
const fullCtxChars = Number(arg("fullctx-chars", process.env["PALIMPSEST_FULLCTX_CHARS"] ?? "520000"))
const DEFAULT_READ_TIMEOUT_MS = 25_000
const pass: EvalEnvelope["pass"] =
  explicitPass === "cold" || explicitPass === "warm"
    ? explicitPass
    : Number(process.env["PALIMPSEST_READ_TIMEOUT_MS"] ?? "0") > DEFAULT_READ_TIMEOUT_MS ? "cold" : "warm"

const requested = arg("system", "palimpsest-v2")
const named = requested === "all" ? [...LIVE_SYSTEMS] : requested.split(",").map((s) => s.trim())
const unknown = named.filter((name) => !isSystemName(name))
if (unknown.length > 0) {
  refuse(`unknown --system value(s): ${unknown.join(", ")}\nknown systems: ${LIVE_SYSTEMS.join(", ")}, or "all"`)
}
const systems = named.filter(isSystemName)
const retired = systems.filter((name) => RETIRED_SYSTEMS.includes(name))
if (retired.length > 0) refuse(`${retired.join(", ")}: v1 was removed; run it from the pre-cleanup-v1 tag`)

if (loadedFreeze !== null && frozenManifest !== null && frozenArm !== null && frozenPurpose !== null) {
  if (systems.length !== 1 || systems[0] !== "palimpsest-v2") refuse("a frozen arm runs only palimpsest-v2")
  if (requestedSplit !== null && requestedSplit !== frozenArm.split) refuse(`the frozen arm requires --split ${frozenArm.split}`)
  if (dataset !== frozenManifest.dataset.name) refuse(`the frozen arm requires dataset ${frozenManifest.dataset.name}`)
  const frozenProfile = qualificationContract?.profile ?? frozenManifest.contract.profile
  if (profile !== frozenProfile) refuse(`the frozen arm requires profile ${frozenProfile}`)
  const requestedVariant = variantTokens({ profile, ablations: ablationNames(ablations), granularity })
  const frozenVariant = qualificationContract?.variant ?? frozenManifest.contract.variant
  if (requestedVariant.join("\0") !== frozenVariant.join("\0")) {
    refuse(`the frozen arm requires variant [${frozenVariant.join(", ")}]`)
  }
  if (batch === null || batch.count !== frozenArm.batches) {
    refuse(`the frozen ${frozenPurpose} requires --batch N/${frozenArm.batches}`)
  }
  if (skipMissing) refuse("--skip-missing is incompatible with a frozen population")
  if (outRelative.replaceAll("\\", "/") !== expectedOutputRoot) {
    refuse(`the frozen ${frozenPurpose} ${pass} pass writes only to ${expectedOutputRoot}`)
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  const findings = (() => {
    if (loadedQualification !== null) return legacyQualificationFindings(loadedQualification, root, head)
    if (frozenPurpose === "dev-replay" || frozenPurpose === "test-arm") {
      return legacyFreezeFindings(loadedFreeze, frozenPurpose, root, head)
    }
    return ["the dev-qualification manifest was not loaded"]
  })()
  if (findings.length > 0) refuse(`frozen preflight failed:\n${findings.map((finding) => `  - ${finding}`).join("\n")}`)
  if (loadedQualification !== null && concurrency !== loadedQualification.manifest.contract.arm.concurrency) {
    refuse(`the frozen dev qualification requires --concurrency ${loadedQualification.manifest.contract.arm.concurrency}`)
  }
  const cacheMode = qualificationPhase?.cacheMode ?? standardFrozenArm?.cacheMode
  if (cacheMode === undefined) refuse("the frozen arm does not declare a cache mode")
  process.env["PALIMPSEST_LLM_CACHE_MODE"] = cacheMode
}

const splitFile = (() => {
  if (split === null) return null
  if (!existsSync(splitFilePath(root))) {
    refuse(`--split ${split} needs ${SPLIT_FILE}; run \`pnpm splits\` and commit it first`)
  }
  const file = readSplitFile(splitFilePath(root))
  const gate = testGateRefusal(file, split)
  if (gate !== null) refuse(gate)
  try {
    assertGenerationMatches(file)
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error))
  }
  return file
})()

const prefix = arg("prefix", splitFile?.prefix ?? "g3")
const variant = variantTokens({ profile, ablations: ablationNames(ablations), granularity })
if (frozenManifest !== null && prefix !== frozenManifest.population.prefix) {
  refuse(`the frozen arm requires prefix ${frozenManifest.population.prefix}`)
}

const AppLive = Retrieve.Default.pipe(
  Layer.provideMerge(Reader.Default),
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(ClaimGraph.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const program = Effect.gen(function* () {
  const retrieve = yield* Retrieve
  const reader = yield* Reader
  const claimGraph = yield* ClaimGraph
  const llm = yield* Llm

  const models = readPathModels(llm.model)
  const expectedModels = qualificationContract?.models ?? frozenManifest?.contract.models
  if (
    expectedModels !== undefined &&
    (models.reader !== expectedModels.reader ||
      models.select !== expectedModels.select ||
      models.sufficiency !== expectedModels.sufficiency)
  ) {
    refuse("configured reader/select/sufficiency models differ from the frozen contract")
  }
  if (frozenPurpose === null) {
    yield* verifyModels(models, { extra: [judgeModel] }).pipe(
      Effect.tapError((error) => Effect.sync(() => console.error(error.message))),
      Effect.orDie
    )
  }

  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  let slice: ReadonlyArray<DatasetQuestion>
  if (frozenManifest !== null && frozenArm !== null) {
    const eligible = frozenManifest.population.eligible[frozenArm.split]
    const byId = new Map(questions.map((question) => [question.questionId, question] as const))
    const missing = eligible.filter((questionId) => !byId.has(questionId))
    if (missing.length > 0) refuse(`the dataset lacks ${missing.length} frozen eligible question(s): ${missing.slice(0, 8).join(", ")}`)
    slice = eligible.flatMap((questionId) => {
      const question = byId.get(questionId)
      return question === undefined ? [] : [question]
    })
  } else if (splitFile === null || split === null) {
    slice = benchmarkSlice(questions, sliceSize)
  } else {
    const selected = splitQuestions(questions, splitFile, split)
    if (selected.slice.length !== selected.wanted) {
      refuse(
        `${SPLIT_FILE} names ${selected.wanted} ${split} questions but the dataset holds ${selected.slice.length} of them`
      )
    }
    slice = selected.slice
  }
  const requestedCount = frozenArm?.eligible ?? (split === null ? sliceSize : slice.length)
  const populationIds = slice.map((question) => question.questionId)
  if (batch !== null) {
    const cut = batchOf(slice, batch)
    slice = cut.items
    console.log(
      `batch        ${batch.index} of ${batch.count}: questions ${cut.from + 1}-${cut.from + slice.length} of ${populationIds.length}`
    )
    if (slice.length === 0) refuse(`batch ${batch.index}/${batch.count} is empty; the population has ${populationIds.length} questions`)
    if (frozenArm !== null && slice.length !== frozenArm.batchSize) {
      refuse(`frozen batch ${batch.index}/${batch.count} has ${slice.length} questions, expected ${frozenArm.batchSize}`)
    }
  }
  if (splitFile === null && existsSync(splitFilePath(root))) {
    const leaked = leakedTestIds(slice, readSplitFile(splitFilePath(root)))
    if (leaked.length > 0) {
      refuse(
        `refusing --slice ${sliceSize}: it contains ${leaked.length} test questions and ${SPLIT_FILE} has no gate record. Use --split dev.`
      )
    }
  }

  const needsGraph = systems.some((system) => SYSTEMS[system].needsGraph)
  const runtimeConfig = readRuntimeConfig()
  const expectedRuntime = qualificationContract?.runtime ?? frozenManifest?.contract.runtime
  if (
    expectedRuntime !== undefined &&
    (runtimeConfig.sha256 !== expectedRuntime.configSha256 || runtimeConfig.imageId !== expectedRuntime.imageId)
  ) {
    refuse("live HydraDB runtime identity differs from the frozen contract")
  }
  const expectedGeneration = qualificationContract?.extractionGeneration ?? frozenManifest?.contract.extractionGeneration
  if (expectedGeneration !== undefined && liveExtractionGeneration().id !== expectedGeneration) {
    refuse("live extraction generation differs from the frozen contract")
  }

  console.log(`dataset      ${dataset}`)
  console.log(
    `${(split === null ? "slice" : `split ${split}`).padEnd(12)} ${slice.length} questions ` +
      `(${slice.filter((q) => q.isAbstention).length} abstention, ${slice.filter((q) => !q.isAbstention).length} answerable)`
  )
  console.log(`systems      ${systems.join(", ")}`)
  console.log(`reader       ${llm.model}   judge  ${judgeModel}   profile ${profile}   pass ${pass}`)
  console.log(`prefix       ${prefix || "(none)"}   concurrency ${concurrency}   variant ${variant.join(",") || "(none)"}`)
  console.log(`generation   ${liveExtractionGeneration().id}`)
  console.log(
    runtimeConfig.sha256 === null
      ? `runtime     (unavailable: ${runtimeConfig.reason})`
      : `runtime      ${runtimeConfig.sha256.slice(0, 16)}  read-cache ${runtimeConfig.readCacheEnabled ? "on" : "off"}  query-cap ${runtimeConfig.queryRuntimeMs} ms`
  )
  console.log("")

  if (needsGraph) {
    const missing = yield* notIngested(claimGraph, prefix, slice, concurrency)
    const listed = `${missing.slice(0, 20).join(", ")}${missing.length > 20 ? " …" : ""}`
    if (missing.length > 0 && skipMissing && split === "test") {
      refuse(
        `refusing --skip-missing on --split test: ${missing.length} of ${slice.length} users are not indexed. ` +
          `Finish the ingest, or record a capacity-capped population in ${SPLIT_FILE} and regenerate the split.`
      )
    }
    if (missing.length > 0 && skipMissing) {
      console.log(`skipping     ${missing.length} of ${slice.length} questions whose users are not indexed`)
      console.log(`             ${listed}`)
      console.log("")
      slice = slice.filter((question) => !missing.includes(question.questionId))
    } else if (missing.length > 0) {
      refuse(
        `${missing.length} of ${slice.length} users are not indexed:\n  ${listed}\n` +
          `Run: PALIMPSEST_LLM_CONCURRENCY=48 pnpm ingest-slice --slice ${sliceSize} --dataset ${dataset} --users 7 --prefix ${prefix}\n` +
          `(or pnpm backfill-user --prefix ${prefix} if they were ingested earlier)`
      )
    }
  }

  const runOne = (
    system: SystemName,
    question: DatasetQuestion
  ): Effect.Effect<EvalRow, never, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      const deps: SystemDeps = {
        retrieve,
        reader,
        uid: uidFor(prefix, question.questionId),
        v2: { profile, ablations, granularity },
        fullCtxChars
      }
      const started = Date.now()
      const outcome = yield* SYSTEMS[system].run(question, deps)
      const latencyMs = Date.now() - started
      const judgement =
        (frozenPurpose === "test-arm" || frozenPurpose === "dev-qualification") && frozenManifest !== null
          ? {
              correct: false,
              template: judgeTemplate(question),
              reply: "UNSCORED: use the immutable upstream rescore layer",
              model: frozenManifest.contract.scoring.model,
              cached: false
            }
          : yield* judge(question, responseOf(outcome), judgeModel)
      return outcome.kind === "v2"
        ? rowFromV2(question, outcome, judgement, latencyMs)
        : rowFromBaseline(system, question, outcome, judgement, latencyMs)
    }).pipe(Effect.orDie)

  mkdirSync(outDir, { recursive: true })

  const runSystem = (system: SystemName) =>
    Effect.gen(function* () {
      yield* llm.resetTrace
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
      const envelope: EvalEnvelope = {
        system,
        dataset,
        prefix,
        split,
        profile,
        variant,
        pass,
        slice: slice.length,
        requestedSlice: requestedCount,
        partial: batch === null && slice.length !== requestedCount,
        ...(batch === null ? {} : { batch: { ...batch, population: populationIds } }),
        readerModel: models.reader,
        selectModel: models.select,
        sufficiencyModel: models.sufficiency,
        judgeModel,
        extractionGeneration: liveExtractionGeneration().id,
        runtimeConfig,
        ablations: system === "palimpsest-v2" ? ablationNames(ablations) : [],
        granularity,
        fullCtxChars: system === "fullctx" ? fullCtxChars : null,
        ...(loadedFreeze !== null && frozenManifest !== null && {
          llmTrace: yield* llm.callTrace,
          freezeManifestSha256: loadedQualification?.sha256 ?? loadedFreeze.sha256,
          codeIdentity:
            loadedQualification?.manifest.contract.codeIdentity.harnessCommit ??
            frozenManifest.contract.codeIdentity.baseCommit,
          lockfileSha256: frozenManifest.contract.codeIdentity.lockfileSha256
        }),
        rows
      }
      const path = resolve(
        outDir,
        `${resultsStem({ system, split, sliceSize: slice.length, variant, batch })}.json`
      )
      if (frozenManifest === null) writeEnvelopeAtomic(path, envelope)
      else {
        try {
          writeEnvelopeExclusive(path, envelope)
        } catch {
          refuse(`${path} already exists; frozen result artifacts are never overwritten`)
        }
      }
      console.log(`  wrote ${path}`)
      console.log("")
      return [system, rows] as const
    })

  const graphSystems = systems.filter((system) => SYSTEMS[system].needsGraph)
  const datasetSystems = systems.filter((system) => !SYSTEMS[system].needsGraph)
  const bySystem = [
    ...(yield* Effect.forEach(graphSystems, runSystem)),
    ...(yield* Effect.forEach(datasetSystems, runSystem, { concurrency: 2 }))
  ].sort((a, b) => systems.indexOf(a[0]) - systems.indexOf(b[0]))

  if (frozenPurpose !== "test-arm" && frozenPurpose !== "dev-qualification") {
    const table = renderRunTable({
      population: split === null ? "slice" : `${split} split`,
      dataset,
      prefix,
      profile,
      readerModel: llm.model,
      judgeModel,
      measured: slice.length,
      requested: requestedCount,
      bySystem
    })
    const tableBatch = batch === null ? "" : `.batch-${String(batch.index).padStart(2, "0")}-of-${batch.count}`
    const tablePath = resolve(outDir, `table-${split ?? slice.length}${tableBatch}.md`)
    if (frozenManifest === null) writeAtomic(tablePath, table + "\n")
    else {
      try {
        writeExclusive(tablePath, table + "\n")
      } catch {
        refuse(`${tablePath} already exists; frozen table artifacts are never overwritten`)
      }
    }
    console.log(table)
    console.log("")
    for (const [system, rows] of bySystem) {
      const all = summariseByType(rows).find((summary) => summary.type === "ALL")
      if (all === undefined) throw new Error(`${system} has no ALL summary`)
      console.log(
        `${system.padEnd(19)} accuracy ${pct(all.accuracy).padStart(6)}   abstention ${pct(all.abstentionAccuracy).padStart(6)}` +
          `   false-abst ${pct(all.falseAbstention).padStart(6)}`
      )
    }
    console.log(`wrote        ${tablePath}`)
  } else {
    console.log("scores       intentionally absent; run the authorized immutable upstream rescore layer")
  }

  const usage = yield* llm.usageByModel
  console.log("")
  for (const [model, one] of usage) {
    console.log(
      `${model.padEnd(19)} ${one.calls} live calls, ${one.cacheHits} cached, ${one.inputTokens} in / ${one.outputTokens} out`
    )
  }
  console.log(`cost         $${(yield* llm.costUsd).toFixed(4)}`)
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
