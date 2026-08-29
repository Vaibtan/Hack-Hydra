import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  errorClasses,
  paired,
  renderAblations,
  renderErrorClasses,
  renderLatency,
  renderPaired,
  type AblationRow,
  renderTable,
  summariseByType,
  type ErrorClassCounts,
  type EvalRow,
  type SystemName
} from "../src/index.js"

/**
 * `table [--split dev | --slice 60] [--results results] [--out <path>]`
 *
 * Rebuilds every table this project publishes from results JSON alone: the
 * per-type table, the error-class funnel, and the paired 2×2 against
 * `palimpsest` and `bm25` with an exact McNemar test and a 95 % interval on the
 * paired difference.
 *
 * Standalone on purpose. The tables used to be rendered inline by `eval.ts`, so
 * re-reading a number meant a live graph, a reader and a judge — and adding a
 * column to the table meant re-running the benchmark. Everything below is a
 * pure function of files that are already committed.
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
const resultsDir = resolve(root, arg("results", "results"))
const slice = arg("slice", "")
const split = arg("split", "")

if (slice !== "" && split !== "") {
  console.error("pass --slice or --split, not both: they name two different populations")
  process.exit(2)
}

/**
 * Which results files belong to one table.
 *
 * A split run is named by its split (`palimpsest-dev.json`) and a slice run by
 * its size (`palimpsest-60.json`), so the two never collide even when a split
 * happens to hold the same number of questions as an older slice of a different
 * graph.
 */
const selector = split === "" ? (slice === "" ? ".json" : `-${slice}.json`) : `-${split}.json`
const label = split === "" ? slice : split

/** The order systems appear in every table, so two runs diff line for line. */
const SYSTEM_ORDER: ReadonlyArray<string> = [
  "palimpsest",
  "palimpsest-v2",
  "oracle-session",
  "palimpsest-premise",
  "bm25",
  "fullctx"
]

interface Envelope {
  readonly system: SystemName
  readonly dataset?: string
  readonly prefix?: string
  readonly slice?: number
  readonly split?: string
  readonly profile?: string
  readonly readerModel?: string
  readonly selectModel?: string
  readonly sufficiencyModel?: string
  readonly judgeModel?: string
  readonly extractionGeneration?: string
  readonly ablations?: ReadonlyArray<string>
  readonly rows: ReadonlyArray<EvalRow>
}

const load = (): ReadonlyArray<Envelope> => {
  if (!existsSync(resultsDir)) {
    console.error(`no results directory at ${resultsDir}`)
    process.exit(2)
  }
  const files = readdirSync(resultsDir).filter(
    (name) => name.endsWith(selector) && !name.startsWith("table")
  )
  const envelopes = files
    .map((name) => JSON.parse(readFileSync(resolve(resultsDir, name), "utf8")) as Envelope)
    // An ablation is a different pipeline wearing the same system name. Mixing
    // one into the accuracy table would silently average a measurement with the
    // thing it is a control for.
    .filter((envelope) => (envelope.ablations ?? []).length === 0)
  return [...envelopes].sort((a, b) => {
    const ai = SYSTEM_ORDER.indexOf(a.system)
    const bi = SYSTEM_ORDER.indexOf(b.system)
    return (ai === -1 ? SYSTEM_ORDER.length : ai) - (bi === -1 ? SYSTEM_ORDER.length : bi)
  })
}

/**
 * The ablation runs beside the full one.
 *
 * Read separately and by their declared `ablations` field rather than by
 * filename: the name is a convenience and the envelope is the record.
 */
const loadAblations = (): ReadonlyArray<AblationRow> => {
  if (!existsSync(resultsDir)) return []
  return readdirSync(resultsDir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("table"))
    .map((name) => JSON.parse(readFileSync(resolve(resultsDir, name), "utf8")) as Envelope)
    .filter(
      (envelope) =>
        (envelope.ablations ?? []).length > 0 &&
        (label === "" || envelope.split === label || String(envelope.rows.length) === label)
    )
    .map((envelope) => ({ ablations: envelope.ablations ?? [], rows: envelope.rows }))
}

const main = async (): Promise<void> => {
  const envelopes = load()
  if (envelopes.length === 0) {
    console.error(`no results files in ${resultsDir}${label === "" ? "" : ` matching *${selector}`}`)
    process.exit(2)
  }

  const first = envelopes[0]!
  const n = first.rows.length
  const bySystem = envelopes.map(
    (envelope) => [envelope.system, envelope.rows] as readonly [SystemName, ReadonlyArray<EvalRow>]
  )

  // A results set whose envelopes disagree about what was measured is not one
  // table. Say so rather than averaging over the disagreement.
  const disagreements: Array<string> = []
  for (const field of ["dataset", "prefix", "split", "readerModel", "judgeModel", "extractionGeneration"] as const) {
    const values = [...new Set(envelopes.map((e) => e[field] ?? "(unset)"))]
    if (values.length > 1) disagreements.push(`${field}: ${values.join(" vs ")}`)
  }
  const sizes = [...new Set(envelopes.map((e) => e.rows.length))]
  if (sizes.length > 1) disagreements.push(`rows: ${sizes.join(" vs ")}`)

  const counts: Array<ErrorClassCounts> = envelopes.map((envelope) =>
    errorClasses(envelope.system, envelope.rows)
  )

  const byName = new Map(envelopes.map((envelope) => [envelope.system, envelope.rows] as const))
  const pairs: Array<string> = []
  // A 2×2 and its mirror are the same measurement, so each unordered pair is
  // rendered once — in the direction the reader cares about, which is the
  // system against the baseline.
  const rendered = new Set<string>()
  for (const baseline of ["palimpsest", "bm25"] as const) {
    const right = byName.get(baseline)
    if (right === undefined) continue
    for (const envelope of envelopes) {
      if (envelope.system === baseline) continue
      const unordered = [envelope.system, baseline].sort().join(" | ")
      if (rendered.has(unordered)) continue
      rendered.add(unordered)
      pairs.push(renderPaired(envelope.system, baseline, paired(envelope.rows, right)))
      pairs.push("")
    }
  }

  const header = [
    `# LongMemEval — ${n}-question ${first.split ?? "slice"}`,
    "",
    `Dataset \`longmemeval_${first.dataset ?? "?"}\`, prefix \`${first.prefix ?? "?"}\`` +
      `${first.split === undefined ? "" : `, split \`${first.split}\``}` +
      `${first.profile === undefined ? "" : `, profile \`${first.profile}\``}. ` +
      `Reader \`${first.readerModel ?? "?"}\`` +
      `${first.selectModel === undefined ? "" : `, selector \`${first.selectModel}\``}` +
      `${first.sufficiencyModel === undefined ? "" : `, sufficiency \`${first.sufficiencyModel}\``}` +
      `, judge \`${first.judgeModel ?? "?"}\` with the official LongMemEval templates.` +
      `${first.extractionGeneration === undefined ? "" : ` Extraction generation \`${first.extractionGeneration}\`.`}`,
    "",
    "Rebuilt by `pnpm table` from the results JSON alone.",
    ...(disagreements.length === 0
      ? []
      : [
          "",
          "> **These files do not describe one measurement.** " +
            disagreements.map((line) => `${line}.`).join(" ") +
            " Every table below mixes them."
        ])
  ]

  const document = [
    ...header,
    "",
    "## Accuracy by question type",
    "",
    renderTable(bySystem),
    "## Where the wrong answers were lost",
    "",
    "One class per incorrect answer, as a funnel: a question whose answer session no candidate " +
      "arm reached is a `retrieval miss` and cannot also be a selection loss. A v1 row records no " +
      "candidate union, so its funnel collapses to `retrieval miss` or `reader`.",
    "",
    renderErrorClasses(counts),
    "",
    "## Latency and reader cost",
    "",
    "`graphMs` is the HydraDB stages alone — arms, edges, hydration — and never includes an LLM " +
      "round trip; `askMs` is the whole ask. p90 is here because a p50 alone hides the shape: a " +
      "pipeline whose median ask is 3 s and whose ninetieth percentile is 40 s is not a 3 s " +
      "pipeline, and the one question in ten that takes 40 s is the one the audience asks.",
    "",
    renderLatency(bySystem),
    "",
    "## Ablations",
    "",
    "Each row is the full v2 plan with one stage switched off. The difference is that stage's " +
      "contribution *in the presence of every other stage* — two stages that each look worthless " +
      "alone can be jointly necessary, and one that looks valuable may only be compensating for a " +
      "weakness elsewhere. A stage whose removal helps is reported the same way as one whose " +
      "removal hurts; that is the number most worth having.",
    "",
    renderAblations(byName.get("palimpsest-v2") ?? [], loadAblations()),
    "",
    "## Paired comparisons",
    "",
    ...pairs
  ].join("\n")

  const outPath = resolve(root, arg("out", `results/table-${label === "" ? n : label}.md`))
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${document}\n`, "utf8")

  console.log(document)
  console.log("")
  for (const [system, rows] of bySystem) {
    const all = summariseByType(rows).find((s) => s.type === "ALL")!
    const pct = (value: number | null): string =>
      value === null ? "   n/a" : `${(value * 100).toFixed(1)} %`
    console.log(
      `${system.padEnd(19)} accuracy ${pct(all.accuracy)}   abstention ${pct(all.abstentionAccuracy)}`
    )
  }
  console.log(`wrote ${outPath}`)
}

main().catch((error: unknown) => {
  console.error(String(error))
  process.exit(1)
})
