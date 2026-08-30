import { existsSync, readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  SPLIT_FILE,
  gateRefusals,
  overwriteRefusal,
  readGate,
  renderGate,
  readRuntimeConfig,
  type EvalRow,
  type GateEnvelope,
  type SplitFile
} from "../src/index.js"

/**
 * `gate [--v1 results/palimpsest-dev.json] [--v2 results/palimpsest-v2-dev.json] [--write]`
 *
 * Reads the adoption gate on dev and, with `--write`, records the result in the
 * split file.
 *
 * The record is what lets `--split test` run at all, which is the point: "we
 * did not tune on test" is a claim, and a committed record with a date on it is
 * the only version of that claim anybody can check. It is written **whether the
 * gate passed or failed** — a gate that is only recorded when it passes is a
 * gate that was never read.
 *
 * Nothing here re-runs a model. It reads two results files, so it can be
 * repeated for free and produces the same answer every time.
 */

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

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
const write = process.argv.includes("--write")

const load = (path: string): { readonly envelope: Record<string, unknown>; readonly rows: ReadonlyArray<EvalRow> } => {
  const full = resolve(root, path)
  if (!existsSync(full)) {
    console.error(`no such results file: ${full}`)
    console.error("  run `pnpm eval --system palimpsest,palimpsest-v2 --split dev` first")
    process.exit(2)
  }
  const envelope = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown> & {
    rows: ReadonlyArray<EvalRow>
  }
  return { envelope, rows: envelope.rows }
}

const v1 = load(arg("v1", "results/palimpsest-dev.json"))
const v2 = load(arg("v2", "results/palimpsest-v2-dev.json"))

// Two files that came from different populations, generations or splits cannot
// be compared, and a gate read across them would be meaningless in a way no
// number in it would reveal. The rules are in `Gate.ts` so they are testable;
// deciding the exit code is this file's job.
const refusals = gateRefusals(v1.envelope as GateEnvelope, v2.envelope as GateEnvelope)
if (refusals.length > 0) {
  for (const refusal of refusals) console.error(refusal)
  process.exit(2)
}

const report = readGate(v1.rows, v2.rows)
console.log(renderGate(report))
console.log("")

if (!write) {
  console.log("(dry run — pass --write to record this in the split file)")
  process.exit(report.passed ? 0 : 1)
}

const splitPath = resolve(root, SPLIT_FILE)
const split = JSON.parse(readFileSync(splitPath, "utf8")) as SplitFile
const overwrite = overwriteRefusal(split.gate)
if (overwrite !== null) {
  console.error(overwrite)
  process.exit(2)
}

const recorded: SplitFile = {
  ...split,
  gate: {
    readAt: new Date().toISOString(),
    passed: report.passed,
    numbers: {
      ...report.numbers,
      ...Object.fromEntries(
        report.criteria.map((criterion) => [`criterion:${criterion.name}`, criterion.passed])
      ),
      v1File: arg("v1", "results/palimpsest-dev.json"),
      v2File: arg("v2", "results/palimpsest-v2-dev.json"),
      // Which runtime the numbers behind this gate were measured on: the read
      // cache and the query cap are chosen per phase, and a gate read on
      // ingest-phase latency would be reading a different measurement.
      runtimeConfigSha256: readRuntimeConfig().sha256,
      readerModel: String(v2.envelope["readerModel"] ?? ""),
      selectModel: String(v2.envelope["selectModel"] ?? ""),
      sufficiencyModel: String(v2.envelope["sufficiencyModel"] ?? ""),
      extractionGeneration: String(v2.envelope["extractionGeneration"] ?? "")
    }
  }
}
await writeFile(splitPath, `${JSON.stringify(recorded, null, 2)}\n`, "utf8")
await writeFile(resolve(root, "results/gate-dev.md"), `${renderGate(report)}\n`, "utf8")
console.log(`recorded in ${SPLIT_FILE} and results/gate-dev.md`)
console.log(
  report.passed
    ? "the test split may now be read, once, for all systems"
    : "the gate did not pass; the test split stays unread and #22 needs a decision"
)
process.exit(report.passed ? 0 : 1)
