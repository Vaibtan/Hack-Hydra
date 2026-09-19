import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath, loadDataset, parseDatasetName, type DatasetQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { loadDotEnv } from "@palimpsest/llm"
import { readUserVertices, sessionKey } from "@palimpsest/palimpsest"
import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  BENCHMARK_EXTRACTION_DEPENDENCIES,
  SPLIT_FILE,
  benchmarkSlice,
  buildReconciledUser,
  completionFromWitness,
  datasetSha256,
  normaliseIngested,
  observedSplits,
  parseReconcileWitness,
  readEnvelope,
  readSplitFile,
  reconcileWitnessFailures,
  RECONCILE_FILE,
  splitByCached,
  splitMembershipSha256,
  liveExtractionGeneration,
  outsidePopulation,
  witnessQuestionIds,
  type Exclusion,
  type PopulationSection,
  type ReconcileWitness,
  type SplitFile
} from "../src/index.js"

/** `splits [--slice 200] [--prefix g3] [--dev-from results/palimpsest-60.json] [--check] [--gate-tripped]` */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const sliceSize = Number(arg("slice", "200"))
const dataset = parseDatasetName(arg("dataset", "s"))
const prefix = arg("prefix", "g3")
const devFrom = arg("dev-from", "results/palimpsest-60.json")
const check = process.argv.includes("--check")
const gateTripped = process.argv.includes("--gate-tripped")

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

const root = workspaceRoot()
const outPath = resolve(root, arg("out", SPLIT_FILE))

const uidFor = (questionId: string): string =>
  prefix === "" ? questionId : `${prefix}-${questionId}`

const AppLive = HydraClient.layer.pipe(Layer.provide(NodeHttpClient.layerUndici))

const cachedIds = (): ReadonlyArray<string> => {
  const path = resolve(root, devFrom)
  return readEnvelope(path).rows.map((row) => row.questionId)
}

/** The split halves with committed result files; the split is "observed" once either exists. */
const observedFromResults = (): ReturnType<typeof observedSplits> => {
  const has = (name: string): boolean => {
    const relative = `results/${name}`
    if (!existsSync(resolve(root, relative))) return false
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", "--", relative], {
        cwd: root,
        stdio: "ignore"
      })
      return true
    } catch {
      return false
    }
  }
  return observedSplits({
    dev: has("palimpsest-dev.json") || has("palimpsest-v2-dev.json"),
    test: has("bm25-test.json") || has("fullctx-test.json") || has("oracle-session-test.json")
  })
}

const readWitness = (): ReconcileWitness | null => {
  const path = resolve(root, RECONCILE_FILE)
  if (!existsSync(path)) return null
  return parseReconcileWitness(JSON.parse(readFileSync(path, "utf8")))
}

const program = Effect.gen(function* () {
  const hydra = yield* HydraClient
  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  const population = benchmarkSlice(questions, sliceSize)
  const cached = cachedIds()

  const stray = outsidePopulation(population, cached)
  if (stray.length > 0) {
    return yield* Effect.die(
      new Error(
        `${stray.length} of the ${cached.length} cached ids are not in benchmarkSlice(${sliceSize}): ` +
          `${stray.slice(0, 10).join(", ")}. Pin the population as an explicit id list instead of ` +
          "relying on --slice."
      )
    )
  }

  const { dev, test } = splitByCached(population, cached)
  const generation = liveExtractionGeneration()

  const existing: SplitFile | null = existsSync(outPath) ? readSplitFile(outPath) : null
  const witness = check ? null : readWitness()
  const datasetHash = yield* Effect.promise(() => datasetSha256(datasetPath(dataset)))
  const membershipHash = splitMembershipSha256({ dataset, slice: sliceSize, prefix, dev, test })
  const expectedUsers = population.map((question) => {
    const uid = uidFor(question.questionId)
    return {
      questionId: question.questionId,
      uid,
      expectedSessionKeys: question.sessions.map((session) => sessionKey(uid, session.key))
    }
  })

  // Live read-only reconciliation — run only with --check, only with runtime authorization.
  let ingested: PopulationSection["ingested"]
  let exclusions: ReadonlyArray<Exclusion> = []
  let completion: PopulationSection["completion"] = "unknown"
  let verifiedAt: string | null = null

  if (check) {
    const users = yield* Effect.forEach(
      population,
      (question: DatasetQuestion) => {
        const uid = uidFor(question.questionId)
        return readUserVertices(hydra, uid, "HAS_SESSION").pipe(
          Effect.map((rows) =>
            buildReconciledUser({
              questionId: question.questionId,
              uid,
              expectedSessionKeys: question.sessions.map((session) => sessionKey(uid, session.key)),
              visibleSessionKeys: rows.map((row) => String(row["sess"] ?? "")).filter((key) => key !== "")
            })
          )
        )
      },
      { concurrency: 8 }
    )
    const now = new Date().toISOString()
    const reconcile: ReconcileWitness = {
      schemaVersion: 1,
      dataset,
      datasetSha256: datasetHash,
      membershipSha256: membershipHash,
      prefix,
      verifiedAt: now,
      evidenceKind: "legacy-query-visible",
      graph: { kind: "legacy-prefix", prefix, snapshotId: null },
      command: `pnpm splits --check${gateTripped ? " --gate-tripped" : ""}`,
      users
    }
    const witnessFailures = reconcileWitnessFailures(reconcile, {
      dataset,
      datasetSha256: datasetHash,
      membershipSha256: membershipHash,
      prefix,
      expectedUsers
    })
    if (witnessFailures.length > 0) {
      return yield* Effect.die(new Error(`invalid reconciliation witness: ${witnessFailures.join("; ")}`))
    }
    const summary = witnessQuestionIds(reconcile)
    yield* Effect.promise(() =>
      mkdir(dirname(resolve(root, RECONCILE_FILE)), { recursive: true }).then(() =>
        writeFile(
          resolve(root, RECONCILE_FILE),
          `${JSON.stringify(reconcile, null, 2)}\n`,
          "utf8"
        )
      )
    )
    ingested = {
      state: "verified",
      count: summary.complete.length,
      evidenceKind: "legacy-query-visible",
      verifiedAt: now,
      witness: RECONCILE_FILE
    }
    const recordedCapacityGate = gateTripped || (existing?.population.capacityGateTripped ?? false)
    completion = completionFromWitness(summary.complete.length, population.length, recordedCapacityGate)
    exclusions = [
      ...summary.missing.map((questionId) => ({ questionId, reason: "missing-source" as const })),
      ...summary.partial.map((questionId) => ({ questionId, reason: "ingest-failed" as const }))
    ]
    verifiedAt = now
    console.log(`ingested   ${summary.complete.length}/${population.length} users fully query-visible under ${prefix}`)
    console.log(`partial    ${summary.partial.length}   missing ${summary.missing.length}`)
    console.log(`witness    ${RECONCILE_FILE}`)
    console.log(`  (dev users complete: ${dev.filter((id) => summary.complete.includes(id)).length}/${dev.length})`)
  } else if (witness !== null) {
    const witnessFailures = reconcileWitnessFailures(witness, {
      dataset,
      datasetSha256: datasetHash,
      membershipSha256: membershipHash,
      prefix,
      expectedUsers
    })
    if (witnessFailures.length > 0) {
      return yield* Effect.die(
        new Error(`stale or invalid reconciliation witness: ${witnessFailures.join("; ")}`)
      )
    }
    const summary = witnessQuestionIds(witness)
    ingested = {
      state: "verified",
      count: summary.complete.length,
      evidenceKind: witness.evidenceKind,
      verifiedAt: witness.verifiedAt,
      witness: RECONCILE_FILE
    }
    const recordedCapacityGate = gateTripped || (existing?.population.capacityGateTripped ?? false)
    completion = completionFromWitness(summary.complete.length, population.length, recordedCapacityGate)
    exclusions = [
      ...summary.missing.map((questionId) => ({ questionId, reason: "missing-source" as const })),
      ...summary.partial.map((questionId) => ({ questionId, reason: "ingest-failed" as const }))
    ]
    verifiedAt = witness.verifiedAt
  } else {
    // No reconciliation has run. Record the truth: the ingested count is unknown, not the request.
    ingested =
      existing === null
        ? { state: "unknown", count: null, evidenceKind: "unknown", verifiedAt: null, witness: null }
        : normaliseIngested(existing.population.ingested)
    if (ingested.state === "verified") {
      ingested = { state: "unknown", count: null, evidenceKind: "unknown", verifiedAt: null, witness: null }
    }
    completion = "unknown"
  }

  const capacityGateTripped =
    completion === "complete" ? false : gateTripped || (existing?.population.capacityGateTripped ?? false)
  const reconciliationCommand = `pnpm splits --check${capacityGateTripped ? " --gate-tripped" : ""}`

  const file: SplitFile = {
    schemaVersion: 1,
    dataset,
    slice: sliceSize,
    prefix,
    createdAt: existing?.createdAt ?? new Date().toISOString().slice(0, 10),
    note:
      `dev = the ${dev.length} questions already cached from the g2 run (results/*-60.json); ` +
      `test = the other ${test.length}, read once after the gate. Both lists are fixed before the ` +
      "first v2 result exists.",
    extractionGeneration: {
      id: generation.id,
      promptTemplateSha256: generation.promptTemplateSha256,
      outputSchemaSha256: generation.outputSchemaSha256,
      dependencies: BENCHMARK_EXTRACTION_DEPENDENCIES
    },
    population: {
      requested: population.length,
      ingested,
      capacityGateTripped,
      selected: population.length,
      completion,
      datasetSha256: datasetHash,
      answerable: population.filter((q) => !q.isAbstention).length,
      abstention: population.filter((q) => q.isAbstention).length,
      exclusions,
      observed: observedFromResults(),
      commands: [reconciliationCommand, "pnpm population --split dev", "pnpm population --split test"],
      generatedAt: new Date().toISOString(),
      verifiedAt
    },
    dev,
    test,
    gate: existing?.gate ?? null
  }

  yield* Effect.promise(() => mkdir(dirname(outPath), { recursive: true }))
  yield* Effect.promise(() => writeFile(outPath, `${JSON.stringify(file, null, 2)}\n`, "utf8"))

  const abs = (ids: ReadonlyArray<string>): number => ids.filter((id) => id.endsWith("_abs")).length
  console.log(`population ${population.length} questions (${abs(population.map((q) => q.questionId))} _abs)`)
  console.log(`dev        ${dev.length} (${abs(dev)} _abs, ${dev.length - abs(dev)} answerable)`)
  console.log(`test       ${test.length} (${abs(test)} _abs, ${test.length - abs(test)} answerable)`)
  console.log(`generation ${generation.id}`)
  console.log(
    `ingested   ${ingested.state}${ingested.count === null ? "" : ` (${ingested.count})`}` +
      `${ingested.witness === null ? "" : ` via ${ingested.witness}`}`
  )
  console.log(`gate       ${file.gate === null ? "not read yet" : `${file.gate.passed ? "passed" : "failed"} on ${file.gate.readAt}`}`)
  console.log(`wrote      ${outPath}`)
})

Effect.runPromise(Effect.provide(program, AppLive)).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
