import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  MEASUREMENT_FIELDS,
  decodeEnvelope,
  envelopeVariant,
  isBatchFile,
  readEnvelope,
  resultsStem,
  variantTokens,
  workspaceRoot,
  writeEnvelopeAtomic,
  type EvalEnvelope
} from "../../src/index.js"

const resultsDir = resolve(workspaceRoot(), "results")
const committed = readdirSync(resultsDir).filter((name) => name.endsWith(".json"))

describe("every committed results file decodes", () => {
  it.each(committed)("%s", (name) => {
    const envelope = readEnvelope(resolve(resultsDir, name))
    expect(envelope.rows.length).toBeGreaterThan(0)
    expect(envelope.rows.length).toBe(envelope.slice)
  })

  it("keeps the parsed object, so key order and unknown fields survive a rewrite", () => {
    const raw = JSON.parse(readFileSync(resolve(resultsDir, "palimpsest-v2-dev.json"), "utf8"))
    expect(decodeEnvelope(raw)).toBe(raw)
  })

  it("refuses a row whose reason is not one of the closed reasons", () => {
    const raw = JSON.parse(readFileSync(resolve(resultsDir, "bm25-20.json"), "utf8"))
    raw.rows[0].reason = "A3_made_up"
    expect(() => decodeEnvelope(raw)).toThrow()
  })

  it("accepts a cold or warm pass and refuses anything else", () => {
    const raw = JSON.parse(readFileSync(resolve(resultsDir, "bm25-20.json"), "utf8"))
    expect(decodeEnvelope({ ...raw, pass: "cold" }).pass).toBe("cold")
    expect(() => decodeEnvelope({ ...raw, pass: "lukewarm" })).toThrow()
  })
})

describe("variant tokens", () => {
  it("names the ablation flags the way the drivers expect", () => {
    expect(
      variantTokens({
        profile: "full",
        ablations: ["noSelect", "noSufficiency", "noTimeScope", "noDecompose", "noDiscovery", "noReaderRoute"],
        granularity: null
      })
    ).toEqual(["no-decompose", "no-discovery", "no-readerroute", "no-select", "no-sufficiency", "no-timescope"])
  })

  it("folds the profile and the granularity in, sorted, and is empty for the default run", () => {
    expect(variantTokens({ profile: "fast", ablations: [], granularity: "turn" })).toEqual([
      "granularity-turn",
      "profile-fast"
    ])
    expect(variantTokens({ profile: "full", ablations: [], granularity: null })).toEqual([])
  })

  it("derives the variant of a file written before the field existed", () => {
    expect(envelopeVariant({ ablations: ["noSelect"], granularity: null })).toEqual(["no-select"])
    expect(envelopeVariant({ ablations: [], granularity: "span" })).toEqual(["granularity-span"])
    expect(envelopeVariant({ variant: ["profile-fast"], ablations: [], granularity: null })).toEqual([
      "profile-fast"
    ])
  })
})

describe("results stem", () => {
  it("keeps the committed names for the full profile", () => {
    expect(resultsStem({ system: "palimpsest-v2", split: "dev", sliceSize: 60, variant: [] })).toBe(
      "palimpsest-v2-dev"
    )
    expect(resultsStem({ system: "bm25", split: null, sliceSize: 60, variant: [] })).toBe("bm25-60")
    expect(
      resultsStem({ system: "palimpsest-v2", split: "dev", sliceSize: 4, variant: [], batch: { index: 3, count: 15 } })
    ).toBe("palimpsest-v2-dev.batch-03-of-15")
  })

  it("puts the fast profile in the name, so it cannot overwrite the gate's file", () => {
    expect(
      resultsStem({ system: "palimpsest-v2", split: "dev", sliceSize: 60, variant: ["profile-fast"] })
    ).toBe("palimpsest-v2-dev-profile-fast")
    expect(
      resultsStem({ system: "palimpsest-v2", split: "dev", sliceSize: 60, variant: ["granularity-turn"] })
    ).toBe("palimpsest-v2-dev-granularity-turn")
  })

  it("recognises a batch file by its suffix", () => {
    expect(isBatchFile("palimpsest-v2-dev.batch-01-of-15.json")).toBe(true)
    expect(isBatchFile("palimpsest-v2-dev.json")).toBe(false)
  })
})

describe("writing", () => {
  it("writes atomically and reads back what it wrote", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "envelope-"))
    try {
      const envelope: EvalEnvelope = readEnvelope(resolve(resultsDir, "bm25-20.json"))
      const path = resolve(dir, "bm25-20.json")
      writeEnvelopeAtomic(path, envelope)
      expect(readdirSync(dir)).toEqual(["bm25-20.json"])
      expect(readEnvelope(path)).toEqual(envelope)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("names the fields two files must agree on", () => {
    expect(MEASUREMENT_FIELDS).toContain("extractionGeneration")
    expect(MEASUREMENT_FIELDS).toContain("profile")
    expect(MEASUREMENT_FIELDS).not.toContain("system")
  })
})
