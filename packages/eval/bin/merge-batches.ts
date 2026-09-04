import { readdirSync } from "node:fs"
import { resolve } from "node:path"
import {
  MEASUREMENT_FIELDS,
  arg,
  envelopeVariant,
  isSystemName,
  mergeBatches,
  orExit,
  parseSplit,
  readEnvelope,
  resultsStem,
  workspaceRoot,
  writeEnvelopeAtomic,
  type EvalEnvelope
} from "../src/index.js"

/** `merge-batches --system palimpsest-v2 --split dev [--variant no-select] [--results results]` */
const root = workspaceRoot()
const resultsDir = resolve(root, arg("results", "results"))
const systemArg = arg("system", "")
const split = orExit(() => parseSplit(arg("split", "dev")))
const variant = arg("variant", "")

if (systemArg === "" || !isSystemName(systemArg) || split === null) {
  console.error("usage: merge-batches --system palimpsest-v2 --split dev [--variant no-select]")
  process.exit(2)
}
const system = systemArg

const stem = `${system}-${split}${variant === "" ? "" : `-${variant}`}`
const files = readdirSync(resultsDir)
  .filter((name) => name.startsWith(`${stem}.batch-`) && name.endsWith(".json"))
  .sort()

if (files.length === 0) {
  console.error(`no batch files matching ${stem}.batch-*.json in ${resultsDir}`)
  process.exit(2)
}

const parts = files.map((name) => ({ name, envelope: readEnvelope(resolve(resultsDir, name)) }))
const { refusals, merged } = mergeBatches(parts, [...MEASUREMENT_FIELDS, "system", "pass"])

const variantRefusals = parts.flatMap((part) => {
  const declared = envelopeVariant(part.envelope)
  const expected = resultsStem({ system, split, sliceSize: 0, variant: declared })
  return expected === stem ? [] : [`${part.name} declares variant [${declared.join(", ")}], which is not ${stem}`]
})

const all = [...refusals, ...variantRefusals]
if (all.length > 0 || merged === null) {
  console.error(`refusing to merge ${files.length} file(s) into ${stem}.json:`)
  for (const refusal of all) console.error(`  ${refusal}`)
  process.exit(2)
}

const { batch: _batch, ...first } = parts[0]!.envelope
const envelope: EvalEnvelope = {
  ...first,
  slice: merged.rows.length,
  requestedSlice: merged.rows.length,
  partial: false,
  batches: merged.count,
  rows: merged.rows
}

const outPath = resolve(resultsDir, `${stem}.json`)
writeEnvelopeAtomic(outPath, envelope)
console.log(`merged ${files.length} batches (${envelope.rows.length} rows) into ${outPath}`)
