import { loadDataset } from "@palimpsest/dataset"
import { Llm, LlmLive, loadDotEnv } from "@palimpsest/llm"
import { Effect } from "effect"
import { resolve } from "node:path"
import {
  FREEZE_FILE,
  JUDGE_MODEL,
  arg,
  fileSha256,
  flag,
  freezeFindings,
  judge,
  observeFreeze,
  parseDataset,
  readEnvelope,
  readEvaluationFreeze,
  workspaceRoot,
  writeEnvelopeExclusive,
  type EvalEnvelope
} from "../src/index.js"

/**
 * Immutable upstream-protocol scoring layer. It never changes an answer artifact and requires an
 * explicit `--authorized` acknowledgement because cache misses make paid provider calls.
 */
loadDotEnv()

const refuse = (message: string): never => {
  console.error(message)
  process.exit(2)
}

const root = workspaceRoot()
const sourceRelative = arg("source", "")
const outRelative = arg("out", "")
const manifestRelative = arg("manifest", FREEZE_FILE)
if (sourceRelative === "" || outRelative === "") refuse("usage: rescore --source <answer.json> --out <new-score.json> --authorized")
if (!flag("authorized")) refuse("rescoring may make paid provider calls; pass --authorized only after explicit runtime/spend approval")

const manifest = readEvaluationFreeze(root, manifestRelative)
const observation = await observeFreeze(root, manifest, resolve(root, manifest.dataset.path))
const findings = freezeFindings(manifest, observation, "integrity")
if (findings.length > 0) {
  refuse(findings.map((finding) => `[${finding.code}] ${finding.subject}: ${finding.detail}`).join("\n"))
}

const sourcePath = resolve(root, sourceRelative)
const sourceSha256 = fileSha256(sourcePath) ?? refuse(`${sourceRelative} does not exist`)
const source = readEnvelope(sourcePath)
const sourceSplit = source.split === "dev" || source.split === "test" ? source.split : refuse("the source must declare dev or test")
const eligible = new Set(manifest.population.eligible[sourceSplit])
const rows = source.rows.filter((row) => eligible.has(row.questionId))
if (rows.length !== eligible.size || new Set(rows.map((row) => row.questionId)).size !== eligible.size) {
  refuse(`source does not cover the exact ${eligible.size}-question eligible ${sourceSplit} population`)
}

const program = Effect.gen(function* () {
  const llm = yield* Llm
  yield* llm.resetTrace
  const questions = yield* loadDataset(parseDataset(manifest.dataset.name)).pipe(Effect.orDie)
  const byId = new Map(questions.map((question) => [question.questionId, question] as const))
  const rescored = yield* Effect.forEach(
    rows,
    (row) => {
      const question = byId.get(row.questionId)
      if (question === undefined) return Effect.die(new Error(`dataset lacks ${row.questionId}`))
      return judge(question, row.answer, JUDGE_MODEL).pipe(
        Effect.flatMap((result) =>
          result.resolvedModel === JUDGE_MODEL
            ? Effect.succeed({
                ...row,
                judged: result.correct,
                judgeTemplate: result.template,
                judgeReply: result.reply,
                judgeModel: result.model,
                judgeResolvedModel: result.resolvedModel
              })
            : Effect.die(
                new Error(
                `provider resolved ${result.resolvedModel ?? "(unknown)"}, expected ${JUDGE_MODEL}`
                )
              )
        )
      )
    },
    { concurrency: 8 }
  )
  const envelope: EvalEnvelope = {
    ...source,
    slice: rescored.length,
    requestedSlice: rescored.length,
    partial: false,
    judgeModel: JUDGE_MODEL,
    scoreSource: { path: sourceRelative, sha256: sourceSha256 },
    scoringProtocol: {
      endpoint: "chat-completions",
      model: JUDGE_MODEL,
      temperature: 0,
      maxTokens: 10,
      n: 1,
      parser: "case-insensitive-yes-substring"
    },
    llmTrace: yield* llm.callTrace,
    rows: rescored
  }
  try {
    writeEnvelopeExclusive(resolve(root, outRelative), envelope)
  } catch {
    refuse(`${outRelative} already exists; rescored evidence is never overwritten`)
  }
  console.log(`wrote        ${outRelative}`)
  console.log(`population   ${rescored.length} eligible ${sourceSplit} rows`)
})

Effect.runPromise(Effect.provide(program, LlmLive())).catch((error) => {
  console.error(String(error))
  process.exit(1)
})
