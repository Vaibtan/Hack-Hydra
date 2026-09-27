import { DATASET_FILES, parseDatasetName } from "@palimpsest/dataset"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  FREEZE_FILE,
  RECONCILE_FILE,
  SPLIT_FILE,
  arg,
  buildFreezeDraft,
  datasetSha256,
  fileSha256,
  flag,
  freezeFindings,
  freezeStatus,
  observeFreeze,
  parseReconcileWitness,
  readEnvelope,
  readEvaluationFreeze,
  readSplitFile,
  workspaceRoot,
  type ArtifactPin,
  type FreezeBlocker,
  type FreezeClaim,
  type FreezePurpose,
  type FrozenRunContract,
  type ReadArm,
  type SystemName
} from "../src/index.js"

/**
 * `freeze --check [--purpose integrity|test-arm] [--manifest data/splits/retrieval-v2.freeze.json]`
 * `freeze --draft [--out data/splits/retrieval-v2.freeze.json]`
 *
 * Reads committed artifacts only. It never starts HydraDB, calls a provider, or rewrites an
 * existing manifest; a draft is written only to a path that does not exist yet.
 */

const refuse = (message: string): never => {
  console.error(message)
  process.exit(2)
}

const root = workspaceRoot()

const ALREADY_READ: ReadonlyArray<{ readonly system: SystemName; readonly split: "dev" | "test"; readonly path: string }> = [
  { system: "palimpsest", split: "dev", path: "results/palimpsest-dev.json" },
  { system: "palimpsest-v2", split: "dev", path: "results/palimpsest-v2-dev.json" },
  { system: "bm25", split: "dev", path: "results/bm25-dev.json" },
  { system: "fullctx", split: "dev", path: "results/fullctx-dev.json" },
  { system: "oracle-session", split: "dev", path: "results/oracle-session-dev.json" },
  { system: "bm25", split: "test", path: "results/bm25-test.json" },
  { system: "fullctx", split: "test", path: "results/fullctx-test.json" },
  { system: "oracle-session", split: "test", path: "results/oracle-session-test.json" }
]

const CLAIM: FreezeClaim = {
  kind: "held-out-not-blind",
  statement:
    "Held out from Palimpsest-v2 tuning but not blind. The effective test population is the 104 of the " +
    "original 140 test questions whose users the S00 witness proves completely query-visible under legacy " +
    "prefix g3; the other 36 are excluded as missing-source and are not ingested for this lane. Both splits " +
    "were observed before this freeze, and BM25, full-context and oracle-session answers on all 140 original " +
    "test questions were read at 422f021. The one remaining Palimpsest-v2 arm is legacy evidence closure: " +
    "it is neither production-path qualification (S16B) nor a blind quality claim, which requires the " +
    "ADR-0007 private holdout.",
  viewed: [
    "dev (60 questions): v1 and v2 rows, judge outcomes and the adoption-gate numbers (gate read 2026-08-31T20:29:00.443Z); BM25, full-context and oracle-session rows (02f3f54)",
    "test (original 140 questions): BM25, full-context and oracle-session answers and judge outcomes (422f021)",
    "test: no Palimpsest pipeline output has been read. Every committed pre-split result (results/*-20.json and results/*-60.json, 2026-08-19) covers dev questions only, and a read-only audit of .cache/llm on 2026-09-26 found no anchors, select or sufficiency entry with a stored prompt for any test question; 88 anchors and 283 read entries from 2026-08-19 predate prompt storage and cannot be classified"
  ]
}

const BLOCKERS: ReadonlyArray<FreezeBlocker> = [
  {
    id: "code-identity",
    kind: "maintainer-decision",
    status: "resolved",
    summary:
      "The maintainer selected a detached clean worktree at 44930d5e44955e0ce59b31ef1297b9fd02bcbb41 " +
      "with a reviewed harness-only patch. It must replay all 60 dev questions cache-only before inheriting the " +
      "gate; no Effect 4 production code is qualified by this lane.",
    evidence: [
      "read-only cache audit 2026-09-26: 618/618 read, 90/90 select, 68/68 sufficiency and 60/61 v2-era anchors entries reproduce only under the draft-07 encoding; none under the current encoding",
      "pnpm-lock.yaml at 6473f79, 422f021 and 44930d5 pins effect 3.22.1, @effect/ai 0.37.0 and @effect/ai-openai 0.41.0; at 9705c32 effect and @effect/ai-openai 4.0.0-beta.107",
      "maintainer approval in the 2026-09-27 continuation session"
    ]
  },
  {
    id: "judge-protocol",
    kind: "maintainer-decision",
    status: "resolved",
    summary:
      "The maintainer selected the exact upstream scoring protocol. Preserve answer artifacts, treat old scores " +
      "as secondary historical data, and immutably rescore every frozen answer artifact with Chat Completions, " +
      "gpt-4o-2024-08-06, temperature 0, max_tokens 10, n 1, and the upstream yes-substring parser.",
    evidence: [
      "upstream evaluate_qa.py: model_zoo gpt-4o -> gpt-4o-2024-08-06; chat.completions with n=1, temperature=0, max_tokens=10; label = 'yes' in reply.lower(); abstention = '_abs' in question_id",
      "local historical scores: Responses API and gpt-4o alias; 0 of 500 dataset ids contain '_abs' other than as a suffix",
      "maintainer approval in the 2026-09-27 continuation session"
    ]
  },
  {
    id: "run-configuration",
    kind: "implementation",
    status: "resolved",
    summary:
      "The manifest freezes both arms, models, exact batching, cache/retry/runtime identities, invalidity rules, " +
      "analyses, thresholds and prices. Both harnesses enforce exact membership, cache-only replay, audit proofs " +
      "and immutable outputs.",
    evidence: [
      "packages/eval/bin/eval.ts",
      "packages/eval/bin/merge-batches.ts",
      "packages/llm/src/Llm.ts",
      "historical harness 1aeecba00e39a1ff0585d3e03d126bb90b56c3a759bee423138812bd8236ce1f on 44930d5e44955e0ce59b31ef1297b9fd02bcbb41",
      "data/splits/retrieval-v2.prices.json"
    ]
  },
  {
    id: "dev-semantic-replay",
    kind: "authorized-run",
    status: "open",
    summary:
      "No post-cleanup semantic replay of the 60 dev questions exists. Before any test call, a replay under the " +
      "chosen code identity must be semantically identical to results/palimpsest-v2-dev.json under " +
      "`pnpm replay-compare`, with zero live provider calls, or the inherited gate no longer qualifies the code.",
    evidence: ["docs/run-log.md 2026-09-04", "docs/palimpsest-implementation-plan.md S14"]
  }
]

const CONTRACT: FrozenRunContract = {
  codeIdentity: {
    strategy: "pinned-historical-commit",
    baseCommit: "44930d5e44955e0ce59b31ef1297b9fd02bcbb41",
    lockfileSha256: "fd8a47e1464fd453857edb4453cabdf9fdb9b1a2c3ed1a4e73fb579dc29bb33a",
    harnessPatchSha256: "1aeecba00e39a1ff0585d3e03d126bb90b56c3a759bee423138812bd8236ce1f"
  },
  scoring: {
    upstreamRevision: "d6dc8b5",
    endpoint: "chat-completions",
    model: "gpt-4o-2024-08-06",
    temperature: 0,
    maxTokens: 10,
    n: 1,
    parser: "case-insensitive-yes-substring",
    historicalScores: "secondary-only",
    scope: "rescore-all-frozen-answer-artifacts"
  },
  models: { reader: "gpt-5.6-luna", select: "gpt-5.6-luna", sufficiency: "gpt-5.6-luna" },
  extractionGeneration: "extract-v1-fffef7bb23a92938adeba1bd1b781a016b019a7bfac75708368dc719fd4de6e4",
  profile: "full",
  variant: [],
  granularity: null,
  devReplay: {
    split: "dev",
    eligible: 60,
    cacheMode: "cache-only",
    batches: 15,
    batchSize: 4,
    outputRoot: "artifacts/retrieval-v2/dev-replay"
  },
  testArm: {
    split: "test",
    eligible: 104,
    cacheMode: "read-write",
    batches: 26,
    batchSize: 4,
    outputRoot: "artifacts/retrieval-v2/test-arm"
  },
  retry: { initialDelayMs: 1000, multiplier: 2, maxRetries: 4, jitter: true },
  runtime: {
    configSha256: "58bab098b96b8e4523856bd05a9330c65fb75a988b843ce28ce58f2de4b9b087",
    imageId: "sha256:514349a17890bf2a35e5e5eb81b41c09b771b07e497fa3f51eb22e7727d66081",
    composeSha256: "2894777e045f57931539cbbfc4a77db46f8d511f0e5e9430dd3ff34883fa54d5"
  },
  prices: {
    path: "data/splits/retrieval-v2.prices.json",
    sha256: "ee69f269e43d04aac031d1e7e912ce38a630cd7ac22c41de3a80b794bfad4b26",
    commit: "draft-s14"
  },
  invalidRunConditions: [
    "any pinned artifact or frozen identity differs",
    "eligible membership or batching differs",
    "an output path already exists",
    "a cache-only replay records a miss or live call",
    "selected evidence bytes or a semantic output differs",
    "the provider-resolved judge model differs",
    "the graph or post-freeze semantic code changes"
  ],
  metrics: [
    "answerable accuracy",
    "abstention accuracy",
    "false abstention rate",
    "per-question paired correctness",
    "graph latency p50",
    "reader input tokens p50",
    "separate frozen price-manifest cost categories"
  ],
  pairedTests: ["exact two-sided McNemar on paired correctness", "95 percent paired difference interval"],
  acceptanceThresholds: {
    minimumAnswerableCorrectGain: 3,
    maximumWorstTypeRegressionPoints: 8,
    maximumFalseAbstentionPercent: 8,
    minimumAbstentionCorrect: 3,
    maximumWarmGraphP50Ms: 400,
    maximumReaderInputTokensP50: 1200
  }
}

const git = (args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()

const committedPin = (path: string): ArtifactPin => {
  try {
    git(["ls-files", "--error-unmatch", "--", path])
    git(["diff", "--quiet", "HEAD", "--", path])
  } catch {
    return refuse(`${path} is untracked or differs from HEAD; a freeze pins committed evidence only`)
  }
  const sha256 = fileSha256(resolve(root, path))
  if (sha256 === null) return refuse(`${path} does not exist`)
  return { path, sha256, commit: git(["log", "-1", "--format=%h", "--", path]) }
}

const draft = async (): Promise<void> => {
  const out = arg("out", FREEZE_FILE)
  const split = readSplitFile(resolve(root, SPLIT_FILE))
  const witness = parseReconcileWitness(JSON.parse(readFileSync(resolve(root, RECONCILE_FILE), "utf8")))
  const datasetRelative = `data/${DATASET_FILES[parseDatasetName(split.dataset)]}`
  const alreadyRead: ReadonlyArray<ReadArm> = ALREADY_READ.map((arm) => ({
    system: arm.system,
    split: arm.split,
    artifact: committedPin(arm.path),
    rows: readEnvelope(resolve(root, arm.path)).rows.length
  }))
  const manifest = buildFreezeDraft({
    dataset: {
      name: split.dataset,
      path: datasetRelative,
      sha256: await datasetSha256(resolve(root, datasetRelative))
    },
    inputs: {
      split: committedPin(SPLIT_FILE),
      witness: committedPin(RECONCILE_FILE),
      populationDev: committedPin("data/splits/population-dev.json"),
      populationTest: committedPin("data/splits/population-test.json")
    },
    split,
    witness,
    gateReport: committedPin("results/gate-dev.md"),
    alreadyRead,
    claim: CLAIM,
    contract: { ...CONTRACT, prices: committedPin("data/splits/retrieval-v2.prices.json") },
    blockers: BLOCKERS,
    result: "results/palimpsest-v2-test.json"
  })
  const path = resolve(root, out)
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  } catch {
    refuse(`${out} already exists; a freeze manifest is never overwritten — delete it by hand and say why`)
  }
  console.log(`wrote        ${out} (${freezeStatus(manifest)})`)
  console.log(`eligible     dev ${manifest.population.eligible.dev.length}, test ${manifest.population.eligible.test.length}`)
  console.log(`exclusions   ${manifest.population.exclusions.length}`)
  console.log(`blockers     ${manifest.blockers.filter((blocker) => blocker.status === "open").length} open`)
}

const check = async (): Promise<number> => {
  const purposeArg = arg("purpose", "integrity")
  const purpose: FreezePurpose =
    purposeArg === "integrity" || purposeArg === "dev-replay" || purposeArg === "test-arm"
      ? purposeArg
      : refuse(`--purpose must be integrity, dev-replay, or test-arm, not ${JSON.stringify(purposeArg)}`)
  const manifestPath = arg("manifest", FREEZE_FILE)
  const manifest = readEvaluationFreeze(root, manifestPath)
  const observation = await observeFreeze(root, manifest, resolve(root, manifest.dataset.path))
  const findings = freezeFindings(manifest, observation, purpose)
  console.log(`manifest     ${manifestPath} (${freezeStatus(manifest)})`)
  console.log(`purpose      ${purpose}`)
  console.log(
    `population   eligible dev ${manifest.population.eligible.dev.length}, test ${manifest.population.eligible.test.length}; ` +
      `${manifest.population.exclusions.length} excluded`
  )
  console.log(`findings     ${findings.length}`)
  for (const finding of findings) console.log(`  - [${finding.code}] ${finding.subject}: ${finding.detail}`)
  console.log(findings.length === 0 ? `status       qualifies ${purpose}` : `status       does not qualify ${purpose}`)
  return findings.length
}

const main = async (): Promise<void> => {
  if (flag("draft") === flag("check")) refuse("pass exactly one of --draft or --check")
  if (flag("draft")) return draft()
  if ((await check()) > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
})
