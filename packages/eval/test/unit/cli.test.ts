import { describe, expect, it } from "vitest"
import {
  CliError,
  ablationNames,
  arg,
  flag,
  parseAblations,
  parseBatch,
  parseDataset,
  parseGranularity,
  parseProfile,
  parseSplit,
  variantTokens
} from "../../src/index.js"

describe("arguments", () => {
  it("reads a value after its flag and falls back otherwise", () => {
    expect(arg("split", "", ["node", "x", "--split", "dev"])).toBe("dev")
    expect(arg("split", "none", ["node", "x"])).toBe("none")
    expect(flag("write", ["--write"])).toBe(true)
  })

  it("parses a batch and refuses a malformed or out-of-range one", () => {
    expect(parseBatch("")).toBeNull()
    expect(parseBatch("3/12")).toEqual({ index: 3, count: 12 })
    expect(() => parseBatch("3")).toThrow(CliError)
    expect(() => parseBatch("13/12")).toThrow(CliError)
    expect(() => parseBatch("0/12")).toThrow(CliError)
  })

  it("validates profile, split, dataset and granularity once", () => {
    expect(parseProfile("fast")).toBe("fast")
    expect(() => parseProfile("turbo")).toThrow(CliError)
    expect(parseSplit("")).toBeNull()
    expect(parseSplit("test")).toBe("test")
    expect(() => parseSplit("prod")).toThrow(CliError)
    expect(parseDataset("s")).toBe("s")
    expect(() => parseDataset("m")).toThrow(CliError)
    expect(parseGranularity("turn")).toBe("turn")
    expect(() => parseGranularity("word")).toThrow(CliError)
  })
})

describe("ablation flags", () => {
  it("keeps the drivers' flags and one internal naming", () => {
    const flags = parseAblations([
      "--no-select",
      "--no-sufficiency",
      "--no-time-scope",
      "--no-decompose",
      "--no-discovery",
      "--reader-route",
      "off"
    ])
    expect(ablationNames(flags)).toEqual([
      "noDecompose",
      "noDiscovery",
      "noReaderRoute",
      "noSelect",
      "noSufficiency",
      "noTimeScope"
    ])
    expect(parseAblations(["--reader-route", "on"])).toEqual({})
  })

  it("maps each driver step to the variant its merge looks for", () => {
    const steps: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
      [["--no-select"], "no-select"],
      [["--no-sufficiency"], "no-sufficiency"],
      [["--no-time-scope"], "no-timescope"],
      [["--no-decompose"], "no-decompose"],
      [["--no-discovery"], "no-discovery"],
      [["--reader-route", "off"], "no-readerroute"]
    ]
    for (const [argv, variant] of steps) {
      expect(
        variantTokens({
          profile: "full",
          ablations: ablationNames(parseAblations(argv)),
          granularity: null
        }).join("-")
      ).toBe(variant)
    }
    expect(variantTokens({ profile: "fast", ablations: [], granularity: null }).join("-")).toBe("profile-fast")
    expect(variantTokens({ profile: "full", ablations: [], granularity: "span" }).join("-")).toBe("granularity-span")
  })
})
