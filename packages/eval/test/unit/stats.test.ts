import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { median, pct, quantile, readEnvelope, readGate, workspaceRoot } from "../../src/index.js"

describe("one median", () => {
  it("averages the two middle values of an even list, like the gate record was computed", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([])).toBe(0)
  })

  it("is the p50 of the same interpolated quantile the latency table uses", () => {
    const values = [5, 1, 4, 2, 3, 6]
    expect(quantile(values, 0.5)).toBe(median(values))
    expect(quantile(values, 0)).toBe(1)
    expect(quantile(values, 1)).toBe(6)
    expect(quantile(values, 0.9)).toBeCloseTo(5.5, 12)
  })

  it("reproduces the committed gate numbers from the committed files", () => {
    const results = resolve(workspaceRoot(), "results")
    const v1 = readEnvelope(resolve(results, "palimpsest-dev.json"))
    const v2 = readEnvelope(resolve(results, "palimpsest-v2-dev.json"))
    const report = readGate(v1.rows, v2.rows)
    expect(report.passed).toBe(true)
    expect(report.numbers).toMatchObject({
      gain: 6,
      worstTypeDelta: 0,
      falseAbstentionPct: 5.6,
      v1AbsCorrect: 4,
      v2AbsCorrect: 4,
      graphMsP50: 246,
      readerTokensP50: 890
    })
  })
})

describe("pct", () => {
  it("prints one decimal and n/a for an undefined ratio", () => {
    expect(pct(0.796)).toBe("79.6 %")
    expect(pct(null)).toBe("n/a")
  })
})
