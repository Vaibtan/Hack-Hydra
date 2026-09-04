import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import {
  abstentions,
  answerable,
  arg,
  correct,
  readEnvelope,
  workspaceRoot,
  writeAtomic,
  type EvalRow
} from "../src/index.js"

/**
 * `risk-coverage --file results/palimpsest-v2-dev.json [--out results/risk-coverage-dev.md]`
 *
 * The curve `ABSTAIN_TIERS` is chosen from: coverage and risk per candidate set
 * of refused sufficiency tiers, on dev, once.
 */
const root = workspaceRoot()
const file = resolve(root, arg("file", "results/palimpsest-v2-dev.json"))
if (!existsSync(file)) {
  console.error(`no such results file: ${file}`)
  console.error(`  available: ${readdirSync(resolve(root, "results")).join(", ")}`)
  process.exit(2)
}

const envelope = readEnvelope(file)
const rows = envelope.rows
const answered = answerable(rows)
const abstained = abstentions(rows)

const covered = (row: EvalRow, tiers: ReadonlySet<string>): boolean => {
  if (row.verdict === "ABSENT" && row.reason !== "INSUFFICIENT_EVIDENCE") return false
  return !tiers.has(row.sufficiencyTier ?? "skipped")
}

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
lines.push(`${answered.length} answerable questions, ${abstained.length} \`_abs\`.`)
lines.push("")

lines.push("## Answerable questions")
lines.push("")
lines.push("| gate | coverage | answered correctly | risk (wrong of answered) | false abstention |")
lines.push("|---|---:|---:|---:|---:|")
for (const gate of GATES) {
  const tiers = new Set(gate.tiers)
  const kept = answered.filter((row) => covered(row, tiers))
  const right = correct(kept)
  lines.push(
    `| ${gate.name} | ${pct(kept.length, answered.length)} | ${right}/${kept.length} | ` +
      `${pct(kept.length - right, kept.length)} | ` +
      `${pct(answered.length - kept.length, answered.length)} |`
  )
}
lines.push("")

lines.push("## `_abs` questions, where refusing is correct")
lines.push("")
lines.push("| gate | refused | abstention accuracy |")
lines.push("|---|---:|---:|")
for (const gate of GATES) {
  const tiers = new Set(gate.tiers)
  const refused = abstained.filter((row) => !covered(row, tiers) || row.notInMemory)
  lines.push(
    `| ${gate.name} | ${refused.length}/${abstained.length} | ${pct(refused.length, abstained.length)} |`
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
  lines.push(`| ${tier} | ${inTier.length} | ${pct(correct(inTier), inTier.length)} |`)
}
lines.push("")

const secondPass = rows.filter((row) => row.secondPass === true)
lines.push(
  `The refined pass ran on ${secondPass.length} of ${rows.length} questions; ` +
    `${pct(correct(secondPass), secondPass.length)} of those were answered correctly.`
)
lines.push("")

const table = lines.join("\n")
const out = resolve(root, arg("out", `results/risk-coverage-${envelope.split ?? "slice"}.md`))
writeAtomic(out, table + "\n")
console.log(table)
console.log(`\nwrote ${out}`)
