import { existsSync } from "node:fs"
import { resolve } from "node:path"
import {
  SPLIT_FILE,
  arg,
  flag,
  gateRefusals,
  overwriteRefusal,
  readEnvelope,
  readGate,
  readRuntimeConfig,
  readSplitFile,
  renderGate,
  splitFilePath,
  workspaceRoot,
  writeAtomic,
  type SplitFile
} from "../src/index.js"

/** `gate [--v1 results/palimpsest-dev.json] [--v2 results/palimpsest-v2-dev.json] [--write]` */
const root = workspaceRoot()
const write = flag("write")
const v1File = arg("v1", "results/palimpsest-dev.json")
const v2File = arg("v2", "results/palimpsest-v2-dev.json")

const load = (path: string) => {
  const full = resolve(root, path)
  if (!existsSync(full)) {
    console.error(`no such results file: ${full}`)
    console.error("  run `pnpm eval --system palimpsest-v2 --split dev` first (v1 from the pre-cleanup-v1 tag)")
    process.exit(2)
  }
  return readEnvelope(full)
}

const v1 = load(v1File)
const v2 = load(v2File)

const refusals = gateRefusals(v1, v2)
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

const splitPath = splitFilePath(root)
const split = readSplitFile(splitPath)
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
      v1File,
      v2File,
      runtimeConfigSha256: readRuntimeConfig().sha256,
      readerModel: v2.readerModel,
      selectModel: v2.selectModel ?? "",
      sufficiencyModel: v2.sufficiencyModel ?? "",
      extractionGeneration: v2.extractionGeneration ?? ""
    }
  }
}

writeAtomic(resolve(root, "results/gate-dev.md"), `${renderGate(report)}\n`)
writeAtomic(splitPath, `${JSON.stringify(recorded, null, 2)}\n`)
console.log(`recorded in ${SPLIT_FILE} and results/gate-dev.md`)
console.log(
  report.passed
    ? "the test split may now be read, once, for all systems"
    : "the gate did not pass; the test split stays unread and #22 needs a decision"
)
process.exit(report.passed ? 0 : 1)
