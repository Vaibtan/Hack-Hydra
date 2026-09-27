import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { Schema } from "effect"

const ArtifactPin = Schema.Struct({ path: Schema.String, sha256: Schema.String, commit: Schema.String })
const Arm = Schema.Struct({
  system: Schema.String,
  split: Schema.Literal("dev", "test"),
  artifact: ArtifactPin,
  rows: Schema.Number
})
const Blocker = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  status: Schema.Literal("open", "resolved"),
  summary: Schema.String,
  evidence: Schema.Array(Schema.String)
})
const RunArm = Schema.Struct({
  split: Schema.Literal("dev", "test"),
  eligible: Schema.Number,
  cacheMode: Schema.Literal("cache-only", "read-write"),
  batches: Schema.Number,
  batchSize: Schema.Number,
  outputRoot: Schema.String
})
const Contract = Schema.Struct({
  codeIdentity: Schema.Struct({
    strategy: Schema.Literal("pinned-historical-commit"),
    baseCommit: Schema.String,
    lockfileSha256: Schema.String,
    harnessPatchSha256: Schema.NullOr(Schema.String)
  }),
  scoring: Schema.Struct({ model: Schema.String }),
  models: Schema.Struct({ reader: Schema.String, select: Schema.String, sufficiency: Schema.String }),
  extractionGeneration: Schema.String,
  profile: Schema.Literal("full"),
  variant: Schema.Array(Schema.String),
  granularity: Schema.Null,
  devReplay: RunArm,
  testArm: RunArm,
  runtime: Schema.Struct({ configSha256: Schema.String, imageId: Schema.String, composeSha256: Schema.String }),
  prices: ArtifactPin
})
const Freeze = Schema.Struct({
  dataset: Schema.Struct({ name: Schema.String, path: Schema.String, sha256: Schema.String }),
  inputs: Schema.Struct({
    split: ArtifactPin,
    witness: ArtifactPin,
    populationDev: ArtifactPin,
    populationTest: ArtifactPin
  }),
  population: Schema.Struct({
    prefix: Schema.String,
    eligible: Schema.Struct({ dev: Schema.Array(Schema.String), test: Schema.Array(Schema.String) })
  }),
  gate: Schema.Struct({ report: ArtifactPin }),
  alreadyRead: Schema.Array(Arm),
  remaining: Schema.Struct({ result: Schema.String }),
  blockers: Schema.Array(Blocker),
  signOff: Schema.NullOr(Schema.Unknown),
  contract: Contract
})

export type LegacyFreeze = typeof Freeze.Type
export type LegacyFreezePurpose = "dev-replay" | "test-arm"

export interface LoadedLegacyFreeze {
  readonly manifest: LegacyFreeze
  readonly manifestPath: string
  readonly evidenceRoot: string
  readonly sha256: string
}

const sha256File = (path: string): string | null =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null

const HARNESS_FILES = [
  "packages/eval/bin/eval.ts",
  "packages/eval/bin/merge-batches.ts",
  "packages/eval/src/Envelope.ts",
  "packages/eval/src/LegacyFreeze.ts",
  "packages/eval/src/Row.ts",
  "packages/eval/src/index.ts",
  "packages/llm/src/Llm.ts",
  "packages/palimpsest/src/Pack.ts"
] as const

/** Length-framed SHA-256 over every reviewed harness file, including the new preflight module. */
export const legacyHarnessSha256 = (worktreeRoot: string): string => {
  const hash = createHash("sha256")
  for (const path of [...HARNESS_FILES].sort()) {
    const bytes = readFileSync(resolve(worktreeRoot, path))
    hash.update(String(Buffer.byteLength(path)))
    hash.update(":")
    hash.update(path)
    hash.update(String(bytes.length))
    hash.update(":")
    hash.update(bytes)
  }
  return hash.digest("hex")
}

/** Read the current S14 manifest; relative pins are resolved against its repository root. */
export const readLegacyFreeze = (path: string): LoadedLegacyFreeze => {
  const manifestPath = resolve(path)
  const manifest = Schema.decodeUnknownSync(Freeze)(JSON.parse(readFileSync(manifestPath, "utf8")))
  const evidenceRoot = resolve(dirname(manifestPath), "..", "..")
  const sha256 = sha256File(manifestPath)
  if (sha256 === null) throw new Error(`${manifestPath} does not exist`)
  return { manifest, manifestPath, evidenceRoot, sha256 }
}

/** Fail-closed preflight performed before the store or provider Layer is constructed. */
export const legacyFreezeFindings = (
  loaded: LoadedLegacyFreeze,
  purpose: LegacyFreezePurpose,
  worktreeRoot: string,
  head: string
): ReadonlyArray<string> => {
  const { manifest, evidenceRoot } = loaded
  const pins = [
    manifest.inputs.split,
    manifest.inputs.witness,
    manifest.inputs.populationDev,
    manifest.inputs.populationTest,
    manifest.gate.report,
    manifest.contract.prices,
    ...manifest.alreadyRead.map((arm) => arm.artifact)
  ]
  const findings = pins.flatMap((pin) => {
    const actual = sha256File(resolve(evidenceRoot, pin.path))
    return actual === pin.sha256 ? [] : [`${pin.path}: ${actual ?? "missing"} != ${pin.sha256}`]
  })
  if (head !== manifest.contract.codeIdentity.baseCommit) findings.push(`HEAD ${head} is not the frozen base commit`)
  const expectedHarness = manifest.contract.codeIdentity.harnessPatchSha256
  if (expectedHarness === null) findings.push("the harness patch hash is not frozen")
  else {
    const actualHarness = legacyHarnessSha256(worktreeRoot)
    if (actualHarness !== expectedHarness) findings.push(`harness hash ${actualHarness} != ${expectedHarness}`)
  }
  if (sha256File(resolve(worktreeRoot, "pnpm-lock.yaml")) !== manifest.contract.codeIdentity.lockfileSha256) {
    findings.push("pnpm-lock.yaml differs from the frozen historical lockfile")
  }
  if (sha256File(resolve(worktreeRoot, "ops/hydradb/compose.benchmark.yaml")) !== manifest.contract.runtime.composeSha256) {
    findings.push("compose.benchmark.yaml differs from the frozen runtime")
  }
  findings.push(
    ...manifest.blockers
      .filter((blocker) => blocker.status === "open" && (purpose !== "dev-replay" || blocker.kind !== "authorized-run"))
      .map((blocker) => `${blocker.id}: ${blocker.summary}`)
  )
  if (purpose === "test-arm") {
    if (manifest.signOff === null) findings.push("the freeze has no maintainer sign-off")
    if (sha256File(resolve(evidenceRoot, manifest.remaining.result)) !== null) findings.push("the remaining canonical result already exists")
  }
  return findings
}

export const resolveFrozenOutput = (worktreeRoot: string, outputRoot: string): string =>
  isAbsolute(outputRoot) ? outputRoot : resolve(worktreeRoot, outputRoot)
