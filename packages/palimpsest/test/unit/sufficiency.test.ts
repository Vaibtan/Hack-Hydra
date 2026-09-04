import { describe, expect, it } from "vitest"
import type { HydratedSpan } from "../../src/Reader.js"
import { RoutePolicy } from "../../src/Routes.js"
import { ABSTAIN_TIERS, MAX_REFINEMENT_PASSES, abstains, premiseContradiction, renderPack, runsOn, skipped, type SufficiencyReport } from "../../src/Sufficiency.js"
import { ROUTES } from "../../src/Understand.js"

const span = (id: string, status: "CURRENT" | "SUPERSEDED"): HydratedSpan => ({
  ckey: `u|c|${id}`,
  id,
  sid: "s1",
  sessionKey: "s1",
  turnIdx: 0,
  cs: 0,
  ce: 10,
  sessionOrd: 1,
  sessionDate: 20230101,
  tEvent: 0,
  speaker: "user",
  status,
  atSession: status === "SUPERSEDED" ? 2 : null,
  excerpt: `excerpt ${id}`,
  highlight: { start: 0, end: 10 }
})

const report = (overrides: Partial<SufficiencyReport> = {}): SufficiencyReport => ({
  tier: "EXACT",
  missing: "",
  missingTerms: [],
  premise: "",
  premiseCitedIds: [],
  skipped: false,
  cached: true,
  ...overrides
})

describe("the premise guard", () => {
  it("needs the model to point at an excerpt, not merely name a premise", () => {
    const named = report({ premise: "the person is a manager" })
    expect(premiseContradiction(named, [span("aaaa1111", "CURRENT")])).toBeNull()
  })

  it("accepts a premise cited to a CURRENT excerpt that is in the pack", () => {
    const cited = report({
      premise: "the person is a manager",
      premiseCitedIds: ["aaaa1111"]
    })
    expect(premiseContradiction(cited, [span("aaaa1111", "CURRENT")])).toEqual({
      premise: "the person is a manager",
      citedIds: ["aaaa1111"]
    })
  })

  it("rejects a premise cited only to a SUPERSEDED excerpt", () => {
    const cited = report({ premise: "p", premiseCitedIds: ["aaaa1111"] })
    expect(premiseContradiction(cited, [span("aaaa1111", "SUPERSEDED")])).toBeNull()
  })

  it("rejects an id that is not in the pack at all", () => {
    const cited = report({ premise: "p", premiseCitedIds: ["bbbb2222"] })
    expect(premiseContradiction(cited, [span("aaaa1111", "CURRENT")])).toBeNull()
  })

  it("ignores a premise field that is only whitespace", () => {
    expect(premiseContradiction(report({ premise: "   " }), [span("a", "CURRENT")])).toBeNull()
  })
})

describe("the skip rule", () => {
  it("skips the two routes where one excerpt is the whole answer", () => {
    const skipRoutes = ROUTES.filter((route) => !RoutePolicy[route].sufficiency)
    expect(skipRoutes).toEqual(["fact", "assistant_output"])
    for (const route of skipRoutes) {
      expect(runsOn(route, [span("a", "CURRENT")], "full")).toBe(false)
    }
  })

  it("runs on the routes whose failure mode is a partial pack", () => {
    for (const route of ["count", "update", "temporal", "multi_fact", "preference"] as const) {
      expect(runsOn(route, [span("a", "CURRENT")], "full")).toBe(true)
    }
  })

  it("never runs on the fast profile, which is what makes it fast", () => {
    expect(runsOn("count", [span("a", "CURRENT")], "fast")).toBe(false)
  })

  it("never runs on an empty pack, which has nothing to judge", () => {
    expect(runsOn("count", [], "full")).toBe(false)
  })
})

describe("abstention", () => {
  it("abstains on exactly the tiers the constant names", () => {
    for (const tier of ["EXACT", "INFERRABLE", "PARTIAL"] as const) {
      expect(abstains(report({ tier }))).toBe(ABSTAIN_TIERS.includes(tier))
    }
  })

  it("abstains on nothing, which is what the dev curve chose", () => {
    expect([...ABSTAIN_TIERS]).toEqual([])
    expect(abstains(report({ tier: "PARTIAL" }))).toBe(false)
  })

  it("never abstains on a check that did not run", () => {
    expect(abstains(skipped("PARTIAL"))).toBe(false)
    expect(skipped().skipped).toBe(true)
  })

  it("allows exactly one refined pass", () => {
    expect(MAX_REFINEMENT_PASSES).toBe(1)
  })
})

describe("the pack the judge reads", () => {
  it("uses the same ids the reader cites, so a citation means one thing", () => {
    const rendered = renderPack([span("aaaa1111", "CURRENT"), span("bbbb2222", "SUPERSEDED")])
    expect(rendered).toContain("[aaaa1111]")
    expect(rendered).toContain("[bbbb2222]")
    expect(rendered).toContain("excerpt aaaa1111")
  })

  it("says SUPERSEDED plainly, so silence and replacement are distinguishable", () => {
    expect(renderPack([span("a", "SUPERSEDED")])).toContain("SUPERSEDED")
    expect(renderPack([span("a", "CURRENT")])).toContain("CURRENT")
  })

  it("is empty for an empty pack rather than a header with nothing under it", () => {
    expect(renderPack([])).toBe("")
  })
})
