import { Schema } from "effect"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { SYSTEM_NAMES, envelopeVariant, readEnvelope, type EvalEnvelope } from "./Envelope.js"
import { canonicalJson, type JsonObject } from "./JsonValue.js"
import {
  datasetSha256,
  parseReconcileWitness,
  sha256Text,
  splitMembershipSha256,
  witnessQuestionIds,
  parsePopulationRecord,
  type PopulationRecord,
  type ReconcileWitness
} from "./PopulationAudit.js"
import { readSplitFile } from "./Population.js"
import { Exclusion, type SplitFile } from "./Splits.js"

/** Repository-relative location of the frozen legacy retrieval-v2 evaluation manifest. */
export const FREEZE_FILE = "data/splits/retrieval-v2.freeze.json"

/** A repository artifact pinned by the SHA-256 of its exact bytes. */
export const ArtifactPin = Schema.Struct({
  /** Repository-relative path with forward slashes. */
  path: Schema.String,
  /** Lowercase hex SHA-256 of the file's raw bytes. */
  sha256: Schema.String,
  /** Abbreviated commit that last changed the file; provenance only, never compared. */
  commit: Schema.String
})
/** Parsed artifact pin. */
export type ArtifactPin = typeof ArtifactPin.Type

/** An arm whose answers were already read; its artifact must stay byte-identical and is never rerun. */
export const ReadArm = Schema.Struct({
  system: Schema.Literals([...SYSTEM_NAMES]),
  split: Schema.Literals(["dev", "test"]),
  artifact: ArtifactPin,
  /** Row count; the rows must cover exactly the original split membership. */
  rows: Schema.Number
})
/** Parsed already-read arm. */
export type ReadArm = typeof ReadArm.Type

/** Kinds of work that must finish before the remaining arm may run. */
export const FREEZE_BLOCKER_KINDS = ["maintainer-decision", "implementation", "authorized-run"] as const

/** One recorded prerequisite of the frozen run; any open blocker fails the test-arm preflight. */
export const FreezeBlocker = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([...FREEZE_BLOCKER_KINDS]),
  status: Schema.Literals(["open", "resolved"]),
  summary: Schema.String,
  evidence: Schema.Array(Schema.String)
})
/** Parsed freeze blocker. */
export type FreezeBlocker = typeof FreezeBlocker.Type

/** Maintainer approval of the complete frozen manifest. */
export const FreezeSignOff = Schema.Struct({
  by: Schema.String,
  at: Schema.String,
  note: Schema.String
})

/** The claim boundary the legacy lane may state about its results. */
export const FreezeClaim = Schema.Struct({
  kind: Schema.Literal("held-out-not-blind"),
  statement: Schema.String,
  /** What had already been observed when the manifest was drafted. */
  viewed: Schema.Array(Schema.String)
})
/** Parsed claim boundary. */
export type FreezeClaim = typeof FreezeClaim.Type

/** Maintainer decisions and complete execution contract for the only mutable legacy arm. */
export const FrozenRunContract = Schema.Struct({
  codeIdentity: Schema.Struct({
    strategy: Schema.Literal("pinned-historical-commit"),
    baseCommit: Schema.String,
    lockfileSha256: Schema.String,
    /** Hash of the reviewed harness-only patch applied to the detached worktree. */
    harnessPatchSha256: Schema.NullOr(Schema.String)
  }),
  scoring: Schema.Struct({
    upstreamRevision: Schema.String,
    endpoint: Schema.Literal("chat-completions"),
    model: Schema.Literal("gpt-4o-2024-08-06"),
    temperature: Schema.Literal(0),
    maxTokens: Schema.Literal(10),
    n: Schema.Literal(1),
    parser: Schema.Literal("case-insensitive-yes-substring"),
    historicalScores: Schema.Literal("secondary-only"),
    scope: Schema.Literal("rescore-all-frozen-answer-artifacts")
  }),
  models: Schema.Struct({
    reader: Schema.String,
    select: Schema.String,
    sufficiency: Schema.String
  }),
  extractionGeneration: Schema.String,
  profile: Schema.Literal("full"),
  variant: Schema.Array(Schema.String),
  granularity: Schema.Null,
  devReplay: Schema.Struct({
    split: Schema.Literal("dev"),
    eligible: Schema.Number,
    cacheMode: Schema.Literal("cache-only"),
    batches: Schema.Number,
    batchSize: Schema.Number,
    outputRoot: Schema.String
  }),
  testArm: Schema.Struct({
    split: Schema.Literal("test"),
    eligible: Schema.Number,
    cacheMode: Schema.Literal("read-write"),
    batches: Schema.Number,
    batchSize: Schema.Number,
    outputRoot: Schema.String
  }),
  retry: Schema.Struct({
    initialDelayMs: Schema.Literal(1000),
    multiplier: Schema.Literal(2),
    maxRetries: Schema.Literal(4),
    jitter: Schema.Literal(true)
  }),
  runtime: Schema.Struct({
    configSha256: Schema.String,
    imageId: Schema.String,
    composeSha256: Schema.String
  }),
  prices: ArtifactPin,
  invalidRunConditions: Schema.Array(Schema.String),
  metrics: Schema.Array(Schema.String),
  pairedTests: Schema.Array(Schema.String),
  acceptanceThresholds: Schema.Record(Schema.String, Schema.Number)
})
/** Parsed frozen execution contract. */
export type FrozenRunContract = typeof FrozenRunContract.Type

/**
 * The frozen evidence contract of the legacy retrieval-v2 lane: which inputs, population, gate
 * record, and already-read arms the one remaining Palimpsest-v2 test arm is bound to.
 */
export const EvaluationFreeze = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  lane: Schema.Literal("retrieval-v2-legacy-g3"),
  claim: FreezeClaim,
  contract: FrozenRunContract,
  dataset: Schema.Struct({ name: Schema.String, path: Schema.String, sha256: Schema.String }),
  inputs: Schema.Struct({
    split: ArtifactPin,
    witness: ArtifactPin,
    populationDev: ArtifactPin,
    populationTest: ArtifactPin
  }),
  population: Schema.Struct({
    prefix: Schema.String,
    membershipSha256: Schema.String,
    original: Schema.Struct({ dev: Schema.Number, test: Schema.Number }),
    eligible: Schema.Struct({ dev: Schema.Array(Schema.String), test: Schema.Array(Schema.String) }),
    exclusions: Schema.Array(Exclusion)
  }),
  gate: Schema.Struct({
    readAt: Schema.String,
    passed: Schema.Literal(true),
    /** SHA-256 of the canonical JSON of the split file's gate record. */
    recordSha256: Schema.String,
    report: ArtifactPin
  }),
  alreadyRead: Schema.Array(ReadArm),
  remaining: Schema.Struct({
    system: Schema.Literal("palimpsest-v2"),
    split: Schema.Literal("test"),
    population: Schema.Literal("eligible"),
    /** Repository-relative result path that must not exist before the run. */
    result: Schema.String,
    runs: Schema.Literal(1)
  }),
  blockers: Schema.Array(FreezeBlocker),
  signOff: Schema.NullOr(FreezeSignOff)
})
/** Parsed frozen evaluation manifest. */
export type EvaluationFreeze = typeof EvaluationFreeze.Type

const assertEvaluationFreeze: (input: unknown) => asserts input is EvaluationFreeze = (input) =>
  Schema.asserts(EvaluationFreeze, input)

/**
 * Parse an untrusted freeze manifest before it can qualify any run.
 *
 * @param input - The decoded JSON document.
 * @returns The parsed manifest.
 * @throws When the document does not match the manifest schema; the CLI reports this as a refusal.
 */
export const parseEvaluationFreeze = (input: JsonObject): EvaluationFreeze => {
  assertEvaluationFreeze(input)
  return input
}

/**
 * Whether the manifest may qualify the remaining arm: frozen only once every blocker is resolved
 * and the maintainer has signed it off.
 *
 * @param manifest - The parsed manifest.
 * @returns `frozen` or `draft`.
 */
export const freezeStatus = (manifest: EvaluationFreeze): "frozen" | "draft" =>
  manifest.signOff !== null && manifest.blockers.every((blocker) => blocker.status === "resolved")
    ? "frozen"
    : "draft"

/** Every artifact the manifest pins, in a stable order. */
export const pinnedArtifacts = (manifest: EvaluationFreeze): ReadonlyArray<ArtifactPin> => [
  manifest.inputs.split,
  manifest.inputs.witness,
  manifest.inputs.populationDev,
  manifest.inputs.populationTest,
  manifest.gate.report,
  manifest.contract.prices,
  ...manifest.alreadyRead.map((arm) => arm.artifact)
]

/** Effective membership and reason-coded exclusions derived from the split lists and the S00 witness. */
export interface EligibleMembership {
  readonly dev: ReadonlyArray<string>
  readonly test: ReadonlyArray<string>
  readonly exclusions: ReadonlyArray<Exclusion>
}

const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/**
 * Derive the eligible population the S00 witness proves query-visible: selected users whose exact
 * legacy session set is complete. Missing users are `missing-source`; partial users `ingest-failed`.
 *
 * @param split - The original split lists.
 * @param witness - The read-only legacy reconciliation witness.
 * @returns Sorted eligible dev/test IDs and exclusions sorted by question ID.
 */
export const eligibleFromWitness = (
  split: Pick<SplitFile, "dev" | "test">,
  witness: ReconcileWitness
): EligibleMembership => {
  const ids = witnessQuestionIds(witness)
  const complete = new Set(ids.complete)
  return {
    dev: split.dev.filter((id) => complete.has(id)).sort(byCodeUnit),
    test: split.test.filter((id) => complete.has(id)).sort(byCodeUnit),
    exclusions: [
      ...ids.missing.map((questionId) => ({ questionId, reason: "missing-source" as const })),
      ...ids.partial.map((questionId) => ({ questionId, reason: "ingest-failed" as const }))
    ].sort((left, right) => byCodeUnit(left.questionId, right.questionId))
  }
}

/** What a freeze check qualifies. */
export type FreezePurpose =
  /** The pinned evidence is intact; run before any replay, derivation, or table. */
  | "integrity"
  /** Integrity plus all harness/decision/authorization blockers required before the dev replay. */
  | "dev-replay"
  /** Integrity plus an unrun remaining arm, no open blockers, and maintainer sign-off. */
  | "test-arm"

/** Stable codes for every way a freeze check can fail. */
export const FREEZE_FINDING_CODES = [
  "artifact-missing",
  "artifact-drift",
  "dataset-drift",
  "membership-drift",
  "witness-drift",
  "population-drift",
  "population-record-drift",
  "run-contract-drift",
  "gate-drift",
  "already-read-drift",
  "remaining-arm-present",
  "blocker-open",
  "sign-off-missing"
] as const
/** Code of one freeze finding. */
export type FreezeFindingCode = (typeof FREEZE_FINDING_CODES)[number]

/** One reason the manifest does not qualify the requested purpose. */
export interface FreezeFinding {
  readonly code: FreezeFindingCode
  /** The artifact, split, arm, or blocker the finding is about. */
  readonly subject: string
  readonly detail: string
}

/** Facts gathered from the working tree by the freeze CLI; the checker performs no I/O. */
export interface FreezeObservation {
  /** Raw-byte SHA-256 of each repository-relative path the checker asks about; `null` when absent. */
  readonly digests: ReadonlyMap<string, string | null>
  /** SHA-256 of the dataset file, or `null` when it is absent. */
  readonly datasetSha256: string | null
  readonly split: SplitFile
  readonly witness: ReconcileWitness
  /** Parsed S00 audit records, keyed by their declared split. */
  readonly populationRecords: ReadonlyMap<"dev" | "test", PopulationRecord>
  /** Parsed envelopes of the already-read artifacts, by repository-relative path. */
  readonly envelopes: ReadonlyMap<string, EvalEnvelope>
}

const sample = (ids: ReadonlyArray<string>): string =>
  `${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ` (+${ids.length - 8} more)` : ""}`

const setDifference = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): ReadonlyArray<string> => {
  const other = new Set(right)
  return left.filter((id) => !other.has(id))
}

const duplicates = (ids: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id)
    else seen.add(id)
  }
  return [...repeated].sort(byCodeUnit)
}

const membershipDetail = (
  label: string,
  observed: ReadonlyArray<string>,
  expected: ReadonlyArray<string>
): string | null => {
  const missing = setDifference(expected, observed)
  const extra = setDifference(observed, expected)
  const repeated = duplicates(observed)
  const parts = [
    ...(missing.length === 0 ? [] : [`${label} lacks ${missing.length}: ${sample(missing)}`]),
    ...(extra.length === 0 ? [] : [`${label} adds ${extra.length}: ${sample(extra)}`]),
    ...(repeated.length === 0 ? [] : [`${label} repeats ${sample(repeated)}`])
  ]
  return parts.length === 0 ? null : parts.join("; ")
}

const artifactFindings = (
  manifest: EvaluationFreeze,
  observation: FreezeObservation
): ReadonlyArray<FreezeFinding> =>
  pinnedArtifacts(manifest).flatMap((pin): ReadonlyArray<FreezeFinding> => {
    const actual = observation.digests.get(pin.path) ?? null
    if (actual === null) {
      return [{ code: "artifact-missing", subject: pin.path, detail: `pinned at ${pin.commit} but absent` }]
    }
    return actual === pin.sha256
      ? []
      : [
          {
            code: "artifact-drift",
            subject: pin.path,
            detail: `sha256 ${actual} differs from the pinned ${pin.sha256} (last changed at ${pin.commit})`
          }
        ]
  })

const populationFindings = (
  manifest: EvaluationFreeze,
  observation: FreezeObservation
): ReadonlyArray<FreezeFinding> => {
  const findings: Array<FreezeFinding> = []
  const { split, witness } = observation
  const population = manifest.population
  const membershipHash = splitMembershipSha256(split)

  if (observation.datasetSha256 !== manifest.dataset.sha256) {
    findings.push({
      code: "dataset-drift",
      subject: manifest.dataset.path,
      detail: `sha256 ${observation.datasetSha256 ?? "(absent)"} differs from the pinned ${manifest.dataset.sha256}`
    })
  }
  if (split.prefix !== population.prefix) {
    findings.push({ code: "membership-drift", subject: "prefix", detail: `split prefix ${split.prefix} != ${population.prefix}` })
  }
  if (membershipHash !== population.membershipSha256) {
    findings.push({
      code: "membership-drift",
      subject: "split membership",
      detail: `membership sha256 ${membershipHash} differs from the pinned ${population.membershipSha256}`
    })
  }
  if (split.dev.length !== population.original.dev || split.test.length !== population.original.test) {
    findings.push({
      code: "membership-drift",
      subject: "original split",
      detail: `split names ${split.dev.length}/${split.test.length} dev/test ids; the freeze pins ${population.original.dev}/${population.original.test}`
    })
  }

  if (witness.membershipSha256 !== population.membershipSha256) {
    findings.push({ code: "witness-drift", subject: "witness", detail: "witness membership hash differs from the frozen membership" })
  }
  if (witness.datasetSha256 !== manifest.dataset.sha256) {
    findings.push({ code: "witness-drift", subject: "witness", detail: "witness dataset hash differs from the frozen dataset" })
  }
  if (witness.prefix !== population.prefix || witness.graph.prefix !== population.prefix) {
    findings.push({ code: "witness-drift", subject: "witness", detail: `witness graph prefix is not ${population.prefix}` })
  }

  const derived = eligibleFromWitness(split, witness)
  for (const name of ["dev", "test"] as const) {
    const detail = membershipDetail(`frozen eligible ${name}`, population.eligible[name], derived[name])
    if (detail !== null) findings.push({ code: "population-drift", subject: `eligible ${name}`, detail })
  }
  if (canonicalJson(population.exclusions) !== canonicalJson(derived.exclusions)) {
    findings.push({
      code: "population-drift",
      subject: "exclusions",
      detail: `the frozen exclusions differ from the ${derived.exclusions.length} the witness derives`
    })
  }
  const recorded = [...(split.population.exclusions ?? [])].sort((left, right) =>
    byCodeUnit(left.questionId, right.questionId)
  )
  if (canonicalJson(recorded) !== canonicalJson(derived.exclusions)) {
    findings.push({
      code: "population-drift",
      subject: "split exclusions",
      detail: `the split file records ${recorded.length} exclusions; the witness derives ${derived.exclusions.length}`
    })
  }
  for (const name of ["dev", "test"] as const) {
    const record = observation.populationRecords.get(name)
    const subject = `population ${name}`
    if (record === undefined) {
      findings.push({ code: "population-record-drift", subject, detail: "the pinned record was not parsed" })
      continue
    }
    const contradictions = [
      ...(record.split === name ? [] : [`declares split ${String(record.split)}`]),
      ...(record.dataset === manifest.dataset.name ? [] : [`dataset ${record.dataset}`]),
      ...(record.datasetSha256 === manifest.dataset.sha256 ? [] : ["dataset hash differs"]),
      ...(record.prefix === population.prefix ? [] : [`prefix ${record.prefix}`]),
      ...(record.membership.dev.length === population.original.dev && record.membership.test.length === population.original.test
        ? []
        : [`membership counts ${record.membership.dev.length}/${record.membership.test.length}`]),
      ...(canonicalJson(record.eligible.dev) === canonicalJson(population.eligible.dev) &&
      canonicalJson(record.eligible.test) === canonicalJson(population.eligible.test)
        ? []
        : ["eligible membership differs"]),
      ...(canonicalJson(record.exclusions) === canonicalJson(population.exclusions) ? [] : ["exclusions differ"]),
      ...(record.completion === "capacity-capped" ? [] : [`completion is ${record.completion}`]),
      ...(record.ingested.state === "verified" && record.ingested.evidenceKind === "legacy-query-visible"
        ? []
        : ["ingestion is not query-visible verified"]),
      ...(record.ingested.witness === manifest.inputs.witness.path ? [] : ["witness path differs"])
    ]
    if (contradictions.length > 0) {
      findings.push({ code: "population-record-drift", subject, detail: contradictions.join("; ") })
    }
  }
  return findings
}

const gateFindings = (manifest: EvaluationFreeze, observation: FreezeObservation): ReadonlyArray<FreezeFinding> => {
  const gate = observation.split.gate
  if (gate === null) {
    return [{ code: "gate-drift", subject: "gate record", detail: "the split file no longer carries the read-once gate record" }]
  }
  const findings: Array<FreezeFinding> = []
  if (gate.readAt !== manifest.gate.readAt || !gate.passed) {
    findings.push({
      code: "gate-drift",
      subject: "gate record",
      detail: `gate read at ${gate.readAt} (passed ${String(gate.passed)}); the freeze pins a pass read at ${manifest.gate.readAt}`
    })
  }
  const recordSha256 = sha256Text(canonicalJson(gate))
  if (recordSha256 !== manifest.gate.recordSha256) {
    findings.push({
      code: "gate-drift",
      subject: "gate record",
      detail: `gate record sha256 ${recordSha256} differs from the pinned ${manifest.gate.recordSha256}`
    })
  }
  const devArtifacts = new Set(
    manifest.alreadyRead.filter((arm) => arm.split === "dev").map((arm) => arm.artifact.path)
  )
  for (const field of ["v1File", "v2File"] as const) {
    const named = gate.numbers[field]
    if (!Schema.is(Schema.String)(named) || !devArtifacts.has(named)) {
      findings.push({
        code: "gate-drift",
        subject: `gate ${field}`,
        detail: `the gate's ${field} (${String(named)}) is not a pinned already-read dev artifact`
      })
    }
  }
  return findings
}

const alreadyReadFindings = (
  manifest: EvaluationFreeze,
  observation: FreezeObservation
): ReadonlyArray<FreezeFinding> => {
  const findings: Array<FreezeFinding> = []
  const remaining = manifest.alreadyRead.filter(
    (arm) => arm.system === manifest.remaining.system && arm.split === manifest.remaining.split
  )
  if (remaining.length > 0) {
    findings.push({
      code: "already-read-drift",
      subject: `${manifest.remaining.system} ${manifest.remaining.split}`,
      detail: "the remaining arm is listed as already read"
    })
  }
  for (const arm of manifest.alreadyRead) {
    const envelope = observation.envelopes.get(arm.artifact.path)
    const subject = `${arm.system} ${arm.split}`
    if (envelope === undefined) {
      if ((observation.digests.get(arm.artifact.path) ?? null) !== null) {
        findings.push({ code: "already-read-drift", subject, detail: `${arm.artifact.path} was not parsed` })
      }
      continue
    }
    if (envelope.system !== arm.system || (envelope.split ?? null) !== arm.split) {
      findings.push({
        code: "already-read-drift",
        subject,
        detail: `${arm.artifact.path} is ${envelope.system} ${String(envelope.split ?? null)}`
      })
    }
    if (envelopeVariant(envelope).length > 0 || envelope.partial === true || envelope.batch !== undefined) {
      findings.push({ code: "already-read-drift", subject, detail: `${arm.artifact.path} is not a whole full-pipeline run` })
    }
    const ids = envelope.rows.map((row) => row.questionId)
    const expected = arm.split === "dev" ? observation.split.dev : observation.split.test
    const detail = membershipDetail(arm.artifact.path, ids, expected)
    if (detail !== null) findings.push({ code: "already-read-drift", subject, detail })
    if (ids.length !== arm.rows) {
      findings.push({ code: "already-read-drift", subject, detail: `${ids.length} rows; the freeze pins ${arm.rows}` })
    }
  }
  return findings
}

const contractFindings = (manifest: EvaluationFreeze): ReadonlyArray<FreezeFinding> => {
  const contract = manifest.contract
  const findings: Array<FreezeFinding> = []
  const add = (detail: string): void => {
    findings.push({ code: "run-contract-drift", subject: "run contract", detail })
  }
  if (contract.codeIdentity.baseCommit.length !== 40) add("the historical base commit is not a full hash")
  if (contract.devReplay.eligible !== manifest.population.eligible.dev.length) add("dev replay count differs from eligible dev")
  if (contract.testArm.eligible !== manifest.population.eligible.test.length) add("test arm count differs from eligible test")
  if (contract.devReplay.batches * contract.devReplay.batchSize !== contract.devReplay.eligible) {
    add("dev replay batching does not cover its population exactly")
  }
  if (contract.testArm.batches * contract.testArm.batchSize !== contract.testArm.eligible) {
    add("test-arm batching does not cover its population exactly")
  }
  for (const [name, root] of [
    ["dev replay", contract.devReplay.outputRoot],
    ["test arm", contract.testArm.outputRoot]
  ] as const) {
    const normal = root.replaceAll("\\", "/").replace(/^\.\//, "")
    if (normal === "results" || normal.startsWith("results/")) add(`${name} output root overlaps canonical results`)
  }
  if (contract.invalidRunConditions.length === 0) add("no invalid-run conditions are declared")
  if (contract.metrics.length === 0) add("no metrics are declared")
  if (contract.pairedTests.length === 0) add("no paired tests are declared")
  return findings
}

/**
 * Compare a frozen manifest with the observed working tree. Returns every finding rather than the
 * first, so one run of the preflight reports all drift.
 *
 * @param manifest - The parsed frozen manifest.
 * @param observation - Digests and parsed artifacts gathered from the working tree.
 * @param purpose - `integrity` for evidence checks only; `test-arm` also requires an unrun arm,
 *   resolved blockers, and maintainer sign-off.
 * @returns Findings; an empty list means the manifest qualifies the purpose.
 */
export const freezeFindings = (
  manifest: EvaluationFreeze,
  observation: FreezeObservation,
  purpose: FreezePurpose
): ReadonlyArray<FreezeFinding> => {
  const findings = [
    ...artifactFindings(manifest, observation),
    ...populationFindings(manifest, observation),
    ...gateFindings(manifest, observation),
    ...alreadyReadFindings(manifest, observation),
    ...contractFindings(manifest)
  ]
  if (purpose === "integrity") return findings
  if (purpose === "dev-replay") {
    return [
      ...findings,
      ...manifest.blockers
        .filter((blocker) => blocker.status === "open" && blocker.kind !== "authorized-run")
        .map((blocker) => ({ code: "blocker-open" as const, subject: blocker.id, detail: blocker.summary }))
    ]
  }
  const result = observation.digests.get(manifest.remaining.result) ?? null
  return [
    ...findings,
    ...(result === null
      ? []
      : [
          {
            code: "remaining-arm-present" as const,
            subject: manifest.remaining.result,
            detail: "the one remaining arm already has a result; it runs exactly once"
          }
        ]),
    ...manifest.blockers
      .filter((blocker) => blocker.status === "open")
      .map((blocker) => ({ code: "blocker-open" as const, subject: blocker.id, detail: blocker.summary })),
    ...(manifest.signOff === null
      ? [{ code: "sign-off-missing" as const, subject: "sign-off", detail: "the maintainer has not signed off the freeze" }]
      : [])
  ]
}

/** Inputs of a new draft manifest; the claim and blockers are authored by the caller. */
export interface FreezeDraftInput {
  readonly dataset: EvaluationFreeze["dataset"]
  readonly inputs: EvaluationFreeze["inputs"]
  readonly split: SplitFile
  readonly witness: ReconcileWitness
  readonly gateReport: ArtifactPin
  readonly alreadyRead: ReadonlyArray<ReadArm>
  readonly claim: FreezeClaim
  readonly contract: FrozenRunContract
  readonly blockers: ReadonlyArray<FreezeBlocker>
  readonly result: string
}

/**
 * Build an unsigned draft manifest from already-verified inputs. The population is derived from
 * the witness rather than copied from mutable audit fields.
 *
 * @param input - Pinned inputs, parsed split and witness, and the authored claim and blockers.
 * @returns A draft manifest; `freezeStatus` reports `draft` until blockers resolve and sign-off lands.
 * @throws When the split file carries no gate record; a lane without its read-once gate cannot be frozen.
 */
export const buildFreezeDraft = (input: FreezeDraftInput): EvaluationFreeze => {
  const gate = input.split.gate
  if (gate === null || !gate.passed) {
    throw new Error("the split file carries no passed gate record; the legacy lane cannot be frozen")
  }
  const derived = eligibleFromWitness(input.split, input.witness)
  return {
    schemaVersion: 1,
    lane: "retrieval-v2-legacy-g3",
    claim: input.claim,
    contract: input.contract,
    dataset: input.dataset,
    inputs: input.inputs,
    population: {
      prefix: input.split.prefix,
      membershipSha256: splitMembershipSha256(input.split),
      original: { dev: input.split.dev.length, test: input.split.test.length },
      eligible: { dev: derived.dev, test: derived.test },
      exclusions: derived.exclusions
    },
    gate: {
      readAt: gate.readAt,
      passed: true,
      recordSha256: sha256Text(canonicalJson(gate)),
      report: input.gateReport
    },
    alreadyRead: input.alreadyRead,
    remaining: { system: "palimpsest-v2", split: "test", population: "eligible", result: input.result, runs: 1 },
    blockers: input.blockers,
    signOff: null
  }
}

/**
 * SHA-256 of a file's raw bytes, or `null` when it does not exist.
 *
 * @param path - Absolute path of the file.
 * @returns The lowercase hex digest, or `null`.
 */
export const fileSha256 = (path: string): string | null =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null

/**
 * Read and parse the freeze manifest at a repository-relative path.
 *
 * @param root - Workspace root.
 * @param path - Repository-relative manifest path.
 * @returns The parsed manifest.
 * @throws When the file is absent, not JSON, or not a manifest.
 */
export const readEvaluationFreeze = (root: string, path: string = FREEZE_FILE): EvaluationFreeze =>
  parseEvaluationFreeze(JSON.parse(readFileSync(resolve(root, path), "utf8")))

/**
 * Gather the facts a freeze check needs from the working tree. Reads files only; never starts a
 * store, calls a provider, or writes.
 *
 * @param root - Workspace root.
 * @param manifest - The manifest whose pins name the files to hash.
 * @param datasetFile - Absolute path of the dataset file.
 * @returns The observation for `freezeFindings`.
 */
export const observeFreeze = async (
  root: string,
  manifest: EvaluationFreeze,
  datasetFile: string
): Promise<FreezeObservation> => {
  const paths = [...pinnedArtifacts(manifest).map((pin) => pin.path), manifest.remaining.result]
  const digests = new Map(paths.map((path) => [path, fileSha256(resolve(root, path))] as const))
  const envelopes = new Map(
    manifest.alreadyRead
      .filter((arm) => digests.get(arm.artifact.path) !== null)
      .map((arm) => [arm.artifact.path, readEnvelope(resolve(root, arm.artifact.path))] as const)
  )
  return {
    digests,
    datasetSha256: existsSync(datasetFile) ? await datasetSha256(datasetFile) : null,
    split: readSplitFile(resolve(root, manifest.inputs.split.path)),
    witness: parseReconcileWitness(JSON.parse(readFileSync(resolve(root, manifest.inputs.witness.path), "utf8"))),
    populationRecords: new Map([
      [
        "dev",
        parsePopulationRecord(JSON.parse(readFileSync(resolve(root, manifest.inputs.populationDev.path), "utf8")))
      ],
      [
        "test",
        parsePopulationRecord(JSON.parse(readFileSync(resolve(root, manifest.inputs.populationTest.path), "utf8")))
      ]
    ]),
    envelopes
  }
}
