import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { Schema } from "effect"
import { readLegacyFreeze, type LoadedLegacyFreeze } from "./LegacyFreeze.js"

const ArtifactPin = Schema.Struct({ path: Schema.String, sha256: Schema.String, commit: Schema.String })
const RunPhase = Schema.Struct({
  pass: Schema.Literal("cold", "warm"),
  cacheMode: Schema.Literal("cache-only", "read-write"),
  outputRoot: Schema.String
})
const QualificationFreeze = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  lane: Schema.Literal("retrieval-v2-legacy-g3"),
  purpose: Schema.Literal("fresh-dev-qualification"),
  sourceFreeze: ArtifactPin,
  contract: Schema.Struct({
    codeIdentity: Schema.Struct({
      baseCommit: Schema.String,
      harnessCommit: Schema.String,
      lockfileSha256: Schema.String
    }),
    models: Schema.Struct({ reader: Schema.String, select: Schema.String, sufficiency: Schema.String }),
    extractionGeneration: Schema.String,
    profile: Schema.Literal("full"),
    variant: Schema.Array(Schema.String),
    granularity: Schema.Null,
    arm: Schema.Struct({
      split: Schema.Literal("dev"),
      eligible: Schema.Number,
      batches: Schema.Number,
      batchSize: Schema.Number,
      concurrency: Schema.Number,
      priming: RunPhase,
      counted: RunPhase
    }),
    scoring: Schema.Struct({ model: Schema.String }),
    runtime: Schema.Struct({ configSha256: Schema.String, imageId: Schema.String, composeSha256: Schema.String }),
    prices: ArtifactPin
  }),
  signOff: Schema.Struct({ by: Schema.String, at: Schema.String, note: Schema.String })
})

/** Parsed D5 fresh-dev qualification freeze. */
export type LegacyQualificationFreeze = typeof QualificationFreeze.Type

/** A qualification manifest plus its pinned source evidence freeze. */
export interface LoadedLegacyQualification {
  readonly manifest: LegacyQualificationFreeze
  readonly source: LoadedLegacyFreeze
  readonly manifestPath: string
  readonly evidenceRoot: string
  readonly sha256: string
}

const sha256File = (path: string): string | null =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null

/** Parse the D5 qualification manifest and its pinned S14 source freeze. */
export const readLegacyQualification = (path: string): LoadedLegacyQualification => {
  const manifestPath = resolve(path)
  const manifest = Schema.decodeUnknownSync(QualificationFreeze)(JSON.parse(readFileSync(manifestPath, "utf8")))
  const evidenceRoot = resolve(dirname(manifestPath), "..", "..")
  const sha256 = sha256File(manifestPath)
  if (sha256 === null) throw new Error(`${manifestPath} does not exist`)
  const sourcePath = resolve(evidenceRoot, manifest.sourceFreeze.path)
  return { manifest, source: readLegacyFreeze(sourcePath), manifestPath, evidenceRoot, sha256 }
}

/** Fail-closed D5 preflight performed before constructing store or provider layers. */
export const legacyQualificationFindings = (
  loaded: LoadedLegacyQualification,
  worktreeRoot: string,
  head: string
): ReadonlyArray<string> => {
  const { manifest, source, evidenceRoot } = loaded
  const sourceManifest = source.manifest
  const pins = [
    sourceManifest.inputs.split,
    sourceManifest.inputs.witness,
    sourceManifest.inputs.populationDev,
    sourceManifest.inputs.populationTest,
    sourceManifest.gate.report,
    sourceManifest.contract.prices,
    ...sourceManifest.alreadyRead.map((arm) => arm.artifact),
    manifest.contract.prices
  ]
  const findings = pins.flatMap((pin) => {
    const actual = sha256File(resolve(evidenceRoot, pin.path))
    return actual === pin.sha256 ? [] : [`${pin.path}: ${actual ?? "missing"} != ${pin.sha256}`]
  })
  const sourceHash = sha256File(resolve(evidenceRoot, manifest.sourceFreeze.path))
  if (sourceHash !== manifest.sourceFreeze.sha256) {
    findings.push(`${manifest.sourceFreeze.path}: ${sourceHash ?? "missing"} != ${manifest.sourceFreeze.sha256}`)
  }
  if (head !== manifest.contract.codeIdentity.harnessCommit) {
    findings.push(`HEAD ${head} is not the frozen harness commit ${manifest.contract.codeIdentity.harnessCommit}`)
  }
  if (sha256File(resolve(worktreeRoot, "pnpm-lock.yaml")) !== manifest.contract.codeIdentity.lockfileSha256) {
    findings.push("pnpm-lock.yaml differs from the frozen historical lockfile")
  }
  if (sha256File(resolve(worktreeRoot, "ops/hydradb/compose.benchmark.yaml")) !== manifest.contract.runtime.composeSha256) {
    findings.push("compose.benchmark.yaml differs from the frozen runtime")
  }
  const arm = manifest.contract.arm
  if (sourceManifest.population.eligible.dev.length !== arm.eligible) {
    findings.push(`source freeze has ${sourceManifest.population.eligible.dev.length} eligible dev ids, expected ${arm.eligible}`)
  }
  if (arm.batches * arm.batchSize !== arm.eligible) {
    findings.push("qualification batching does not cover its population exactly")
  }
  if (arm.priming.pass !== "cold" || arm.counted.pass !== "warm") {
    findings.push("qualification phases must be cold priming followed by warm counted")
  }
  if (arm.priming.outputRoot === arm.counted.outputRoot) {
    findings.push("priming and counted outputs must use distinct roots")
  }
  return findings
}
