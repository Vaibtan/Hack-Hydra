import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { arg, compareReplay, fileSha256, parseReplayRun, workspaceRoot } from "../src/index.js"

/**
 * `replay-compare --replay <results file> [--frozen results/palimpsest-v2-dev.json] [--out <report.json>]`
 *
 * Compares a replayed results file with the frozen run it must reproduce. Exits 0 when the replay
 * is semantically identical, 1 when it differs, and 2 on unusable input. A report is written only
 * to a path that does not exist yet.
 */

const refuse = (message: string): never => {
  console.error(message)
  process.exit(2)
}

const root = workspaceRoot()
const frozenPath = arg("frozen", "results/palimpsest-v2-dev.json")
const replayPath = arg("replay", "")
const outPath = arg("out", "")
if (replayPath === "") refuse("pass --replay <results file>")
if (resolve(root, frozenPath) === resolve(root, replayPath)) refuse("a results file cannot replay itself")

const read = (path: string) => {
  try {
    return parseReplayRun(JSON.parse(readFileSync(resolve(root, path), "utf8")))
  } catch (error) {
    return refuse(`${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const comparison = compareReplay(read(frozenPath), read(replayPath), { requireProof: true })

console.log(`frozen       ${frozenPath}`)
console.log(`replay       ${replayPath}`)
console.log(`compared     ${comparison.compared} questions`)
console.log(
  `population   ${comparison.missing.length} missing, ${comparison.unexpected.length} unexpected, ${comparison.repeated.length} repeated`
)
console.log(`differences  ${comparison.differences.length}`)
for (const difference of comparison.differences.slice(0, 20)) {
  console.log(`  - ${difference.questionId} ${difference.field}: ${difference.frozen ?? "(absent)"} -> ${difference.replay ?? "(absent)"}`)
}
if (comparison.differences.length > 20) console.log(`  … ${comparison.differences.length - 20} more`)
console.log(`timing-only  ${comparison.measurementOnly} questions changed measurement fields only`)
console.log(`proof        ${comparison.proofFindings.length} finding(s)`)
for (const finding of comparison.proofFindings) console.log(`  - ${finding}`)
console.log(`verdict      ${comparison.verdict}`)

if (outPath !== "") {
  const path = resolve(root, outPath)
  const report = {
    frozen: { path: frozenPath, sha256: fileSha256(resolve(root, frozenPath)) },
    replay: { path: replayPath, sha256: fileSha256(resolve(root, replayPath)) },
    comparison
  }
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  } catch {
    refuse(`${outPath} already exists; a replay report is never overwritten`)
  }
  console.log(`wrote        ${outPath}`)
}

process.exitCode = comparison.verdict === "semantically-identical" ? 0 : 1
