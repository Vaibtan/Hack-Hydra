import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  MEASUREMENT_FIELDS,
  arg,
  envelopeVariant,
  errorClasses,
  isBatchFile,
  paired,
  pct,
  readEnvelope,
  renderAblations,
  renderErrorClasses,
  renderLatency,
  renderPaired,
  renderReaderAb,
  renderTable,
  summariseByType,
  workspaceRoot,
  type AblationRow,
  type ErrorClassCounts,
  type EvalEnvelope,
  type EvalRow,
  type ReaderAbFile,
  type SystemName
} from "../src/index.js"

/** `table [--split dev | --slice 60] [--results results] [--out <path>]` */
const root = workspaceRoot()
const resultsDir = resolve(root, arg("results", "results"))
const slice = arg("slice", "")
const split = arg("split", "")

if (slice !== "" && split !== "") {
  console.error("pass --slice or --split, not both: they name two different populations")
  process.exit(2)
}
const label = split === "" ? slice : split

const SYSTEM_ORDER: ReadonlyArray<SystemName> = [
  "palimpsest",
  "palimpsest-v2",
  "oracle-session",
  "palimpsest-premise",
  "bm25",
  "fullctx"
]

const inPopulation = (envelope: EvalEnvelope): boolean =>
  split !== ""
    ? envelope.split === split
    : slice !== ""
      ? (envelope.split ?? null) === null && envelope.slice === Number(slice)
      : true

const loadAll = (): ReadonlyArray<EvalEnvelope> => {
  if (!existsSync(resultsDir)) {
    console.error(`no results directory at ${resultsDir}`)
    process.exit(2)
  }
  return readdirSync(resultsDir)
    .filter(
      (name) =>
        name.endsWith(".json") &&
        !name.startsWith("table") &&
        !name.startsWith("reader-ab-") &&
        !isBatchFile(name)
    )
    .map((name) => readEnvelope(resolve(resultsDir, name)))
    .filter(inPopulation)
}

const loadReaderAb = (): ReaderAbFile | null => {
  const path = resolve(resultsDir, `reader-ab-${label === "" ? "dev" : label}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf8")) as ReaderAbFile
}

const main = async (): Promise<void> => {
  const all = loadAll()
  const envelopes = all
    .filter((envelope) => envelopeVariant(envelope).length === 0)
    .sort((a, b) => SYSTEM_ORDER.indexOf(a.system) - SYSTEM_ORDER.indexOf(b.system))
  const ablations: ReadonlyArray<AblationRow> = all
    .filter((envelope) => envelopeVariant(envelope).length > 0)
    .map((envelope) => ({ ablations: envelopeVariant(envelope), rows: envelope.rows }))
  if (envelopes.length === 0) {
    console.error(`no results files in ${resultsDir}${label === "" ? "" : ` for ${label}`}`)
    process.exit(2)
  }

  const first = envelopes[0]!
  const n = first.rows.length
  const bySystem = envelopes.map(
    (envelope) => [envelope.system, envelope.rows] as readonly [SystemName, ReadonlyArray<EvalRow>]
  )

  const disagreements: Array<string> = []
  for (const field of MEASUREMENT_FIELDS) {
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
    `Dataset \`longmemeval_${first.dataset}\`, prefix \`${first.prefix}\`` +
      `${first.split === undefined || first.split === null ? "" : `, split \`${first.split}\``}` +
      `${first.profile === undefined ? "" : `, profile \`${first.profile}\``}. ` +
      `Reader \`${first.readerModel}\`` +
      `${first.selectModel === undefined ? "" : `, selector \`${first.selectModel}\``}` +
      `${first.sufficiencyModel === undefined ? "" : `, sufficiency \`${first.sufficiencyModel}\``}` +
      `, judge \`${first.judgeModel}\` with the official LongMemEval templates.` +
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
    renderAblations(byName.get("palimpsest-v2") ?? [], ablations),
    "",
    ...(() => {
      const ab = loadReaderAb()
      if (ab === null) return []
      return [
        "## Reader routes, on identical evidence",
        "",
        "The route-specific rules block against v1's single prompt, over the same packed " +
          "excerpts. Every other v2 stage changes *what* the reader sees and is measured by the " +
          "ablations above; this one changes only *how it is asked*, so a pipeline ablation " +
          "would compare two different packs and this does not.",
        "",
        renderReaderAb(ab),
        ""
      ]
    })(),
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
    console.log(
      `${system.padEnd(19)} accuracy ${pct(all.accuracy).padStart(6)}   abstention ${pct(all.abstentionAccuracy).padStart(6)}`
    )
  }
  console.log(`wrote ${outPath}`)
}

main().catch((error: unknown) => {
  console.error(String(error))
  process.exit(1)
})
