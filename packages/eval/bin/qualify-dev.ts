import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Schema } from "effect"
import {
  arg,
  fileSha256,
  QualificationThresholds,
  qualificationRefusals,
  readEnvelope,
  readQualification,
  workspaceRoot,
  writeExclusive
} from "../src/index.js"

const refuse = (message: string): never => {
  console.error(message)
  process.exit(2)
}

const root = workspaceRoot()
const manifestRelative = arg("manifest", "data/splits/retrieval-v2.d5-dev.freeze.json")
const manifestPath = resolve(root, manifestRelative)
const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
const manifest = Schema.decodeUnknownSync(
  Schema.Struct({
    acceptanceThresholds: QualificationThresholds,
    contract: Schema.Struct({
      codeIdentity: Schema.Struct({ harnessCommit: Schema.String }),
      arm: Schema.Struct({ eligible: Schema.Number })
    }),
    comparison: Schema.Struct({
      baselineAnswer: Schema.Struct({ path: Schema.String, sha256: Schema.String }),
      baselineRescore: Schema.String,
      candidateAnswer: Schema.String,
      candidateRescore: Schema.String,
      gateResult: Schema.String
    })
  })
)(parsed)
const readPath = (name: string): string => {
  switch (name) {
    case "baselineRescore": return manifest.comparison.baselineRescore
    case "candidateRescore": return manifest.comparison.candidateRescore
    case "gateResult": return manifest.comparison.gateResult
    default: return refuse(`unknown qualification comparison path ${name}`)
  }
}
const baselineRelative = arg("v1", readPath("baselineRescore"))
const candidateRelative = arg("v2", readPath("candidateRescore"))
const outRelative = arg("out", readPath("gateResult"))
if (baselineRelative !== readPath("baselineRescore") || candidateRelative !== readPath("candidateRescore") || outRelative !== readPath("gateResult")) {
  refuse("qualification inputs and output must match the frozen manifest")
}
const baseline = readEnvelope(resolve(root, baselineRelative))
const candidate = readEnvelope(resolve(root, candidateRelative))
const manifestSha256 = fileSha256(manifestPath)
const candidateAnswerSha256 = fileSha256(resolve(root, manifest.comparison.candidateAnswer))
const frozenRefusals = [
  ...(baseline.scoreSource?.path === manifest.comparison.baselineAnswer.path &&
  baseline.scoreSource.sha256 === manifest.comparison.baselineAnswer.sha256
    ? []
    : ["baseline rescore is not bound to the pinned baseline answer artifact"]),
  ...(candidate.scoreSource?.path === manifest.comparison.candidateAnswer &&
  candidate.scoreSource.sha256 === candidateAnswerSha256 &&
  candidateAnswerSha256 !== null
    ? []
    : ["candidate rescore is not bound to the frozen candidate answer artifact"]),
  ...(candidate.freezeManifestSha256 === manifestSha256 ? [] : ["candidate answer does not identify this qualification manifest"]),
  ...(candidate.codeIdentity === manifest.contract.codeIdentity.harnessCommit ? [] : ["candidate answer has the wrong harness commit"]),
  ...(candidate.llmTrace !== undefined &&
  candidate.llmTrace.length > 0 &&
  candidate.llmTrace.every((call) => call.cache === "hit")
    ? []
    : ["counted candidate answer is not cache-hit-only"])
]
const refusals = [
  ...qualificationRefusals(baseline, candidate, manifest.contract.arm.eligible),
  ...frozenRefusals
]
if (refusals.length > 0) refuse(refusals.join("\n"))
const report = readQualification(baseline.rows, candidate.rows, manifest.acceptanceThresholds)
const artifact = {
  schemaVersion: 1,
  manifest: { path: manifestRelative, sha256: manifestSha256 },
  baseline: { path: baselineRelative, sha256: fileSha256(resolve(root, baselineRelative)) },
  candidate: { path: candidateRelative, sha256: fileSha256(resolve(root, candidateRelative)) },
  ...report
}
try {
  writeExclusive(resolve(root, outRelative), `${JSON.stringify(artifact, null, 2)}\n`)
} catch {
  refuse(`${outRelative} already exists; qualification evidence is never overwritten`)
}
console.log(`qualification ${report.passed ? "PASSED" : "FAILED"}`)
for (const criterion of report.criteria) {
  console.log(`${criterion.passed ? "PASS" : "FAIL"} ${criterion.name}: ${criterion.measured} (${criterion.comparison} ${criterion.bound})`)
}
console.log(`wrote        ${outRelative}`)
process.exitCode = report.passed ? 0 : 1
