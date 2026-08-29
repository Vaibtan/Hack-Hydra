import { describe, expect, it } from "vitest"
import type { Candidate } from "../../src/Arms.js"
import {
  ALWAYS_KEEP_TOP_CONVERGENCE,
  MAX_KEPT_TURNS,
  enforceSelection,
  orderCandidates,
  shortId,
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
