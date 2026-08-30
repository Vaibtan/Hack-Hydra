import { describe, expect, it } from "vitest"
import type { Candidate } from "../../src/Arms.js"
import {
  ALWAYS_KEEP_TOP_CONVERGENCE,
  MAX_KEPT_TURNS,
  applySelection,
  enforceSelection,
  orderCandidates,
  shortId,
  renderCandidateTable,
  speakerShare
} from "../../src/Select.js"

const candidate = (over: Partial<Candidate> & { ckey: string }): Candidate => ({
  text: "",
  speaker: "user",
  ctype: "state",
  sessionOrd: 1,
  sessionDate: 20230101,
  tEvent: 0,
  tPrec: "none",
  sid: "s1",
  sessionKey: "s1",
  turnIdx: 0,
  cs: 0,
  ce: 1,
  anchors: [],
  convergence: 0,
  score: 0,
  hops: 1,
  arms: ["convergence"],
  kind: "convergence",
  ...over
})

/** Distinct turns, so the turn cap is not what is being measured. */
const spread = (ckey: string, over: Partial<Candidate> = {}, turn = 0): Candidate =>
  candidate({ ckey, turnIdx: turn, ...over })

describe("the guarantees the selector cannot break", () => {
  it("keeps every probe hit even when the selector named none of them", () => {
    const probe = spread("aaaaaaaaprobe1", { kind: "probe", arms: ["probe:me|age"] }, 1)
    const other = spread("bbbbbbbbother1", {}, 2)
    const report = enforceSelection([probe, other], new Set())
    expect(report.kept.map((c) => c.ckey)).toEqual(["aaaaaaaaprobe1"])
    expect(report.dropped.map((d) => [d.candidate.ckey, d.reason])).toEqual([
      ["bbbbbbbbother1", "selector"]
    ])
  })

  it("keeps the top convergence claims, because the verdict rests on them", () => {
    expect(ALWAYS_KEEP_TOP_CONVERGENCE).toBe(3)
    const converged = Array.from({ length: 5 }, (_, i) =>
      spread(`conv${String(i).padStart(10, "0")}`, { convergence: 5 - i }, i)
    )
    const report = enforceSelection(converged, new Set())
    expect(report.kept).toHaveLength(3)
    expect(report.kept.map((c) => c.convergence)).toEqual([5, 4, 3])
  })

  it("does not treat a zero-convergence slot-mate as a top convergence claim", () => {
    const mates = Array.from({ length: 4 }, (_, i) =>
      spread(`mate${String(i).padStart(10, "0")}`, { kind: "slotMate", convergence: 0 }, i)
    )
    expect(enforceSelection(mates, new Set()).kept).toHaveLength(0)
  })

  it("keeps what the selector named, by short id", () => {
    const a = spread("0000000000keepme1", {}, 1)
    const b = spread("0000000000dropme1", {}, 2)
    const report = enforceSelection([a, b], new Set([shortId(a.ckey)]))
    expect(report.kept.map((c) => c.ckey)).toEqual([a.ckey])
  })
})

describe("the turn cap", () => {
  it("counts turns, not claims", () => {
    // Forty claims from two turns is two excerpts, and must survive a cap of 2.
    const claims = Array.from({ length: 40 }, (_, i) =>
      spread(`c${String(i).padStart(11, "0")}`, { turnIdx: i % 2 })
    )
    const report = enforceSelection(claims, new Set(claims.map((c) => shortId(c.ckey))), {
      maxTurns: 2
    })
    expect(report.kept).toHaveLength(40)
    expect(report.dropped).toHaveLength(0)
  })

  it("drops past the cap with a reason a receipt can tell apart", () => {
    const claims = Array.from({ length: 5 }, (_, i) =>
      spread(`c${String(i).padStart(11, "0")}`, { convergence: 5 - i }, i)
    )
    const report = enforceSelection(claims, new Set(claims.map((c) => shortId(c.ckey))), {
      maxTurns: 3
    })
    expect(report.kept).toHaveLength(3)
    expect(report.dropped.map((d) => d.reason)).toEqual(["turn_cap", "turn_cap"])
  })

  it("defaults to thirty", () => {
    expect(MAX_KEPT_TURNS).toBe(30)
  })

  it("never spends the cap on a probe hit, however low its convergence", () => {
    // The bug this pins: `ordered` sorts by convergence and a probe hit has
    // convergence 0 by construction, so walking `ordered` and capping as it
    // goes discards the guaranteed row first — the `(me, age)` claim the probe
    // arm exists for.
    const converged = Array.from({ length: 32 }, (_, i) =>
      spread(`conv${String(i).padStart(10, "0")}`, { convergence: 5 }, i)
    )
    const probe = spread(
      "probe000000001",
      { kind: "probe", arms: ["probe:me|age"], convergence: 0 },
      99
    )
    const report = enforceSelection(
      [...converged, probe],
      new Set(converged.map((c) => shortId(c.ckey)))
    )
    expect(report.kept.map((c) => c.ckey)).toContain(probe.ckey)
    expect(report.dropped.find((d) => d.candidate.ckey === probe.ckey)).toBeUndefined()
    // The cap still binds — it just spends itself on selector rows.
    expect(report.dropped.filter((d) => d.reason === "turn_cap").length).toBeGreaterThan(0)
  })

  it("keeps every guaranteed row even when they alone exceed the cap", () => {
    const probes = Array.from({ length: 40 }, (_, i) =>
      spread(`probe${String(i).padStart(9, "0")}`, { kind: "probe", convergence: 0 }, i)
    )
    const report = enforceSelection(probes, new Set(), { maxTurns: 5 })
    expect(report.kept).toHaveLength(40)
    expect(report.dropped).toHaveLength(0)
  })

  it("emits the kept set in the selector's ranking, for the budget to cut from", () => {
    const rows = [
      spread("c00000000001", { convergence: 1 }, 1),
      spread("c00000000002", { kind: "probe", convergence: 0 }, 2),
      spread("c00000000003", { convergence: 9 }, 3)
    ]
    const report = enforceSelection(rows, new Set(rows.map((c) => shortId(c.ckey))))
    expect(report.kept.map((c) => c.ckey)).toEqual([
      "c00000000003",
      "c00000000001",
      "c00000000002"
    ])
  })
})

describe("the fallback", () => {
  it("replaces the selector's answer with the deterministic ordering", () => {
    const claims = Array.from({ length: 5 }, (_, i) =>
      spread(`c${String(i).padStart(11, "0")}`, { convergence: 5 - i }, i)
    )
    const report = enforceSelection(claims, new Set(), { fallback: true, maxTurns: 3 })
    expect(report.fallback).toBe(true)
    expect(report.kept.map((c) => c.convergence)).toEqual([5, 4, 3])
  })

  it("cannot empty the evidence set — a failed call is not a decision", () => {
    const claims = [spread("c0000000000001", { convergence: 2 })]
    expect(enforceSelection(claims, new Set(), { fallback: true }).kept).toHaveLength(1)
  })
})

describe("ordering", () => {
  it("is by convergence, then idf mass, then recency, then key", () => {
    const rows = [
      spread("zzz00000000001", { convergence: 1, score: 1, sessionOrd: 9 }),
      spread("aaa00000000001", { convergence: 1, score: 1, sessionOrd: 9 }),
      spread("mmm00000000001", { convergence: 3, score: 0 })
    ]
    expect(orderCandidates(rows).map((c) => c.ckey.slice(0, 3))).toEqual(["mmm", "aaa", "zzz"])
  })

  it("does not depend on the incoming order, so a replay is a cache hit", () => {
    const rows = [
      spread("a0000000000001", { convergence: 2 }),
      spread("b0000000000001", { convergence: 1 }),
      spread("c0000000000001", { convergence: 3 })
    ]
    expect(orderCandidates(rows).map((c) => c.ckey)).toEqual(
      orderCandidates([...rows].reverse()).map((c) => c.ckey)
    )
  })
})

describe("the speaker prior", () => {
  it("measures what share of each set is assistant-sourced", () => {
    const candidates = [
      spread("a0000000000001", { speaker: "assistant" }),
      spread("b0000000000001", { speaker: "assistant" }),
      spread("c0000000000001", { speaker: "user" }),
      spread("d0000000000001", { speaker: "user" })
    ]
    const kept = candidates.slice(0, 2)
    expect(speakerShare(candidates, kept)).toEqual({ candidateShare: 0.5, keptShare: 1 })
  })

  it("is zero on an empty set rather than NaN", () => {
    expect(speakerShare([], [])).toEqual({ candidateShare: 0, keptShare: 0 })
  })
})

describe("the candidate table", () => {
  it("gives one line per row, in the deterministic order, with the arms that reached it", () => {
    const rows = [
      spread("aaaaaaaaaaaa01", { convergence: 1, text: "lives in Brooklyn" }, 1),
      spread("bbbbbbbbbbbb02", {
        convergence: 4,
        text: "moved to San Francisco",
        speaker: "assistant",
        sessionDate: 20230404,
        tEvent: 20230401,
        arms: ["convergence", "probe:me|residence"]
      })
    ]
    const table = renderCandidateTable(rows)
    const lines = table.split(String.fromCharCode(10))
    expect(lines).toHaveLength(2)
    // Highest convergence first, whatever order they arrived in.
    expect(lines[0]).toContain("bbbbbb02")
    expect(lines[0]).toContain("convergence,probe:me|residence")
    expect(lines[0]).toContain("about 20230401")
    expect(lines[1]).toContain("lives in Brooklyn")
    // No event date means no "about" clause rather than "about 0".
    expect(lines[1]).not.toContain("about")
  })

  it("does not depend on the incoming order, because the prompt is the cache key", () => {
    const rows = [
      spread("aaaaaaaaaaaa01", { convergence: 1 }, 1),
      spread("bbbbbbbbbbbb02", { convergence: 4 }, 2),
      spread("cccccccccccc03", { convergence: 2 }, 3)
    ]
    expect(renderCandidateTable(rows)).toBe(renderCandidateTable([...rows].reverse()))
  })

  it("is empty for no candidates rather than a stray newline", () => {
    expect(renderCandidateTable([])).toBe("")
  })
})

describe("an empty keep set is a failure, not a decision", () => {
  it("falls back to the deterministic ordering and flags it", () => {
    // The rule the dev run's `selectorFallback` column counts. A selector that
    // kept nothing produces an empty pack, and an empty pack reads downstream
    // as "the memory does not contain it" -- a structural claim the selector
    // was never asked to make.
    const candidates = [
      spread("aaaaaaaaone", { convergence: 3, score: 4 }, 1),
      spread("bbbbbbbbtwo", { convergence: 1, score: 1 }, 2)
    ]

    const applied = applySelection(candidates, { kept: [], dropped: [], fallback: false })

    expect(applied.kept.map((c) => c.ckey)).toEqual(["aaaaaaaaone", "bbbbbbbbtwo"])
    expect(applied.fallback).toBe(true)
  })

  it("leaves a non-empty selection exactly as the selector reported it", () => {
    const kept = spread("aaaaaaaaone", {}, 1)
    const dropped = spread("bbbbbbbbtwo", {}, 2)
    const selection = {
      kept: [kept],
      dropped: [{ candidate: dropped, reason: "selector" as const }],
      fallback: false
    }

    expect(applySelection([kept, dropped], selection)).toEqual(selection)
  })

  it("keeps a failed call flagged when the fallback it produced is also empty", () => {
    expect(applySelection([], { kept: [], dropped: [], fallback: true }).fallback).toBe(true)
  })

  it("respects the turn cap in the fallback it substitutes", () => {
    const many = Array.from({ length: MAX_KEPT_TURNS + 5 }, (_, i) =>
      spread(`c${String(i).padStart(8, "0")}`, { convergence: MAX_KEPT_TURNS + 5 - i }, i)
    )

    expect(applySelection(many, { kept: [], dropped: [], fallback: false }).kept).toHaveLength(
      MAX_KEPT_TURNS
    )
  })
})
