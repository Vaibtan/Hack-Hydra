import { existsSync, readFileSync, readdirSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { EvalRow } from "../src/index.js"

/**
 * `risk-coverage --file results/palimpsest-v2-dev.json [--out results/risk-coverage-dev.md]`
 *
 * The curve behind `ABSTAIN_TIERS`.
 *
 * Abstention is a trade and this is the table that prices it. For each set of
 * sufficiency tiers we could refuse to answer on, it reports **coverage** (the
 * share of answerable questions still answered) and **risk** (the share of
 * those answers that are wrong). Refusing more lowers risk and lowers coverage;
 * the constant is chosen from this table, on dev, once — not per question.
 *
 * The `_abs` questions are counted separately and in the opposite direction:
 * there, refusing is the correct answer, so a gate that raises abstention
 * accuracy on `_abs` while costing little coverage on the answerable ones is
 * the thing worth having.
 *
 * Every number comes from a results file. Nothing here re-runs a model, so the
 * curve can be rebuilt for free whenever the dev split is re-scored.
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
const file = resolve(root, arg("file", "results/palimpsest-v2-dev.json"))
if (!existsSync(file)) {
  console.error(`no such results file: ${file}`)
  console.error(`  available: ${readdirSync(resolve(root, "results")).join(", ")}`)
  process.exit(2)
}

const envelope = JSON.parse(readFileSync(file, "utf8")) as {
  readonly system: string
  readonly split: string | null
  readonly profile: string
  readonly readerModel: string
  readonly sufficiencyModel?: string
  readonly extractionGeneration: string
  readonly ablations?: ReadonlyArray<string>
  readonly rows: ReadonlyArray<EvalRow>
}

const rows = envelope.rows
const answerable = rows.filter((row) => !row.isAbstention)
const abstention = rows.filter((row) => row.isAbstention)

/**
 * Whether this row would still be answered under a gate that refuses `tiers`.
 *
 * A row that already abstained for a structural reason is not covered whatever
 * the gate is: the gate can only take answers away, never add them.
 */
const covered = (row: EvalRow, tiers: ReadonlySet<string>): boolean => {
  if (row.verdict === "ABSENT" && row.reason !== "INSUFFICIENT_EVIDENCE") return false
  const tier = row.sufficiencyTier ?? "skipped"
  return !tiers.has(tier)
}

/**
 * Whether the answer this row gave was right.
 *
 * `judged` is the official LongMemEval judge's label, so this is not a
 * re-scoring — it is the same label the accuracy tables use.
 */
const correct = (row: EvalRow): boolean => row.judged

const GATES: ReadonlyArray<{ readonly name: string; readonly tiers: ReadonlyArray<string> }> = [
  { name: "none (answer everything)", tiers: [] },
  { name: "PARTIAL", tiers: ["PARTIAL"] },
  { name: "PARTIAL + INFERRABLE", tiers: ["PARTIAL", "INFERRABLE"] }
]

const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)} %`)

const lines: Array<string> = []
lines.push(`# Risk–coverage on ${envelope.split ?? "slice"} — ${envelope.system}`)
lines.push("")
lines.push(
  `Reader \`${envelope.readerModel}\`, sufficiency \`${envelope.sufficiencyModel ?? envelope.readerModel}\`, ` +
    `profile \`${envelope.profile}\`, generation \`${envelope.extractionGeneration}\`` +
    (envelope.ablations !== undefined && envelope.ablations.length > 0
      ? `, ablations \`${envelope.ablations.join(", ")}\``
      : "")
)
lines.push("")
lines.push(`${answerable.length} answerable questions, ${abstention.length} \`_abs\`.`)
lines.push("")

lines.push("## Answerable questions")
lines.push("")
lines.push("| gate | coverage | answered correctly | risk (wrong of answered) | false abstention |")
lines.push("|---|---:|---:|---:|---:|")
for (const gate of GATES) {
  const tiers = new Set(gate.tiers)
  const kept = answerable.filter((row) => covered(row, tiers))
  const right = kept.filter(correct)
  lines.push(
    `| ${gate.name} | ${pct(kept.length, answerable.length)} | ${right.length}/${kept.length} | ` +
      `${pct(kept.length - right.length, kept.length)} | ` +
      `${pct(answerable.length - kept.length, answerable.length)} |`
  )
}
lines.push("")

lines.push("## `_abs` questions, where refusing is correct")
lines.push("")
lines.push("| gate | refused | abstention accuracy |")
lines.push("|---|---:|---:|")
for (const gate of GATES) {
  const tiers = new Set(gate.tiers)
  // On an `_abs` question the judge marks a refusal correct, so a row is right
  // if it refused for any reason -- structurally, by the gate, or because the
  // reader itself said NOT_IN_MEMORY.
  const refused = abstention.filter((row) => !covered(row, tiers) || row.notInMemory)
  lines.push(
    `| ${gate.name} | ${refused.length}/${abstention.length} | ${pct(refused.length, abstention.length)} |`
  )
}
lines.push("")

lines.push("## Tier distribution")
lines.push("")
lines.push("| tier | questions | answered correctly |")
lines.push("|---|---:|---:|")
const tiers = [...new Set(rows.map((row) => row.sufficiencyTier ?? "skipped"))].sort()
for (const tier of tiers) {
  const inTier = rows.filter((row) => (row.sufficiencyTier ?? "skipped") === tier)
  lines.push(`| ${tier} | ${inTier.length} | ${pct(inTier.filter(correct).length, inTier.length)} |`)
}
lines.push("")

const secondPass = rows.filter((row) => row.secondPass === true)
lines.push(
  `The refined pass ran on ${secondPass.length} of ${rows.length} questions; ` +
    `${pct(secondPass.filter(correct).length, secondPass.length)} of those were answered correctly.`
)
lines.push("")

const table = lines.join("\n")
const out = resolve(root, arg("out", `results/risk-coverage-${envelope.split ?? "slice"}.md`))
await writeFile(out, table + "\n", "utf8")
console.log(table)
console.log(`\nwrote ${out}`)
