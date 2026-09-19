import { datasetPath, loadDataset, parseDatasetName } from "@palimpsest/dataset"
import { sessionKey } from "@palimpsest/palimpsest"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  buildPopulationRecord,
  completionFromWitness,
  datasetSha256,
  membershipOf,
  observedSplits,
  parseReconcileWitness,
  populationGateFailures,
  readEnvelope,
  readSplitFile,
  reconcileWitnessFailures,
  RECONCILE_FILE,
  splitFilePath,
  splitMembershipSha256,
  witnessQuestionIds,
  workspaceRoot,
  type Completion,
  type Exclusion,
  type PopulationSection,
  type ReconcileWitness
} from "../src/index.js"

/**
 * `population [--split dev|test] [--dataset s] [--results <file>] [--out <file>]`
 *
 * Rebuilds the canonical population record from immutable inputs only: the dataset file, the
 * committed split manifest, the committed result envelope named by `--results`, and — when it
 * exists — the read-only reconciliation witness. It never starts HydraDB and never calls a
 * provider. If the witness is absent the ingestion count is `unknown`, and the record fails
 * closed rather than defaulting to success.
 */

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const root = workspaceRoot()
const split = arg("split", "dev") === "test" ? "test" : "dev"
const dataset = parseDatasetName(arg("dataset", "s"))
const resultsFile = arg("results", `results/palimpsest-v2-${split}.json`)
const outPath = resolve(root, arg("out", `data/splits/population-${split}.json`))
const splitPath = splitFilePath(root)
if (!existsSync(splitPath)) {
  console.error(`no split manifest at ${splitPath}; run \`pnpm splits\` first`)
  process.exit(2)
}

const file = readSplitFile(splitPath)

const witness = (): ReconcileWitness | null => {
  const path = resolve(root, RECONCILE_FILE)
  return existsSync(path) ? parseReconcileWitness(JSON.parse(readFileSync(path, "utf8"))) : null
}

const committedResult = (name: string): boolean => {
  const relative = `results/${name}`
  if (!existsSync(resolve(root, relative))) return false
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relative], {
      cwd: root,
      stdio: "ignore"
    })
    readEnvelope(resolve(root, relative))
    return true
  } catch {
    return false
  }
}

const program = Effect.gen(function* () {
  const questions = yield* loadDataset(dataset).pipe(Effect.orDie)
  const membership = membershipOf(questions, file)
  const hash = yield* Effect.promise(() => datasetSha256(datasetPath(dataset)))
  const membershipHash = splitMembershipSha256(file)
  const expectedUsers = membership.selected.map((question) => {
    const uid = file.prefix === "" ? question.questionId : `${file.prefix}-${question.questionId}`
    return {
      questionId: question.questionId,
      uid,
      expectedSessionKeys: question.sessions.map((session) => sessionKey(uid, session.key))
    }
  })

  const resultsPath = resolve(root, resultsFile)
  const evaluated: ReadonlyArray<string> = existsSync(resultsPath)
    ? readEnvelope(resultsPath).rows.map((row) => row.questionId)
    : []

  const read = witness()
  const prefix = file.prefix
  const witnessFailures =
    read === null
      ? []
      : reconcileWitnessFailures(read, {
          dataset,
          datasetSha256: hash,
          membershipSha256: membershipHash,
          prefix,
          expectedUsers
        })
  const summary = read === null || witnessFailures.length > 0 ? null : witnessQuestionIds(read)
  const completion: Completion =
    summary === null
      ? "unknown"
      : completionFromWitness(
          summary.complete.length,
          membership.selected.length,
          file.population.capacityGateTripped
        )
  const population: PopulationSection = read !== null && summary !== null
    ? {
        ...file.population,
        ingested: {
          state: "verified" as const,
          count: summary.complete.length,
          evidenceKind: read.evidenceKind,
          verifiedAt: read.verifiedAt,
          witness: RECONCILE_FILE
        },
        completion,
        verifiedAt: read.verifiedAt
      }
    : file.population

  const exclusions: ReadonlyArray<Exclusion> = summary !== null
    ? [
        ...summary.missing.map((questionId) => ({ questionId, reason: "missing-source" as const })),
        ...summary.partial.map((questionId) => ({ questionId, reason: "ingest-failed" as const }))
      ]
    : []

  const observed = observedSplits({
    dev: committedResult("palimpsest-dev.json") || committedResult("palimpsest-v2-dev.json"),
    test:
      committedResult("bm25-test.json") ||
      committedResult("fullctx-test.json") ||
      committedResult("oracle-session-test.json")
  })

  const record = buildPopulationRecord({
    split,
    dataset,
    datasetSha256: hash,
    slice: file.slice,
    prefix,
    membership,
    population,
    exclusions,
    observed,
    generatedAt: new Date().toISOString(),
    commands: [`pnpm population --split ${split} --results ${resultsFile}`],
    evaluated
  })

  const failures = [
    ...witnessFailures,
    ...populationGateFailures({ record, evaluated })
  ]

  const artifact = {
    ...record,
    evaluated: [...evaluated].sort(),
    failures
  }

  yield* Effect.promise(() => mkdir(dirname(outPath), { recursive: true }))
  yield* Effect.promise(() =>
    writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
  )

  console.log(`split       ${split}`)
  console.log(`dataset     ${dataset}  sha256 ${hash.slice(0, 16)}`)
  console.log(`requested   ${record.requested}`)
  console.log(`selected    ${record.selected}  (dev ${record.dev}, test ${record.test})`)
  console.log(`answerable  ${record.answerable}   abstention ${record.abstention}`)
  console.log(
    `ingested    ${record.ingested.state}${record.ingested.count === null ? "" : ` (${record.ingested.count})`}  via ${record.ingested.evidenceKind}`
  )
  console.log(`observed    dev ${observed.dev}  test ${observed.test}  — ${observed.note}`)
  console.log(`evaluated   ${evaluated.length} ids from ${resultsFile}`)
  console.log(`failures    ${failures.length}`)
  for (const failure of failures) console.log(`  - ${failure}`)
  if (failures.length > 0) console.log("status      stale: downstream result tables are not acceptance evidence")
  console.log(`wrote       ${outPath}`)
  return failures.length
})

Effect.runPromise(program)
  .then((failureCount) => {
    if (failureCount > 0) process.exitCode = 1
  })
  .catch((error) => {
    console.error(String(error))
    process.exit(1)
  })
