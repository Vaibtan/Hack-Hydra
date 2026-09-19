import type { HydraPath } from "@palimpsest/hydra"
import { describe, expect, it } from "vitest"
import {
  chunksByKey,
  claimChunks,
  evidenceTurns,
  middleEntityNames,
  reachedRows,
  reassemble,
  sessionTurns,
  slotFills,
  turnChunks
} from "../../src/Rows.js"

type Node = HydraPath["nodes"][number]
type Properties = Node["properties"]

const node = (id: number, label: string, properties: Properties): Node => ({
  id,
  labels: [label],
  properties
})

const pathOf = (nodes: ReadonlyArray<Node>, types: ReadonlyArray<string>): HydraPath => ({
  nodes,
  relationships: types.map((type, i) => ({
    id: 100 + i,
    type,
    src: nodes[i]?.id ?? 0,
    dst: nodes[i + 1]?.id ?? 0,
    properties: {}
  }))
})

const token = node(1, "Token", { stem: "mortgag", tkey: "u|t|mortgag", df: 3 })
const entity = node(2, "Entity", { ekey: "u|e|wells", name: "Wells Fargo" })
const claimNode = (over: Properties = {}): Node =>
  node(3, "Claim", {
    ckey: "u|c|abc",
    text: "pre-approved for 350k",
    speaker: "user",
    ctype: "event",
    session_ord: 4,
    session_date: 20230410,
    t_event: 20230401,
    t_prec: "day",
    sid: "s4",
    source_session_id: "src-4",
    turn_idx: 2,
    cs: 10,
    ce: 32,
    ...over
  })

describe("reachedRows", () => {
  it("decodes a direct Token -> Claim path with every claim field", () => {
    const [row] = reachedRows([pathOf([token, claimNode()], ["HITS"])])
    expect(row).toEqual({
      anchor: "mortgag",
      df: 3,
      hops: 1,
      claim: {
        ckey: "u|c|abc",
        text: "pre-approved for 350k",
        speaker: "user",
        ctype: "event",
        sessionOrd: 4,
        sessionDate: 20230410,
        tEvent: 20230401,
        tPrec: "day",
        sid: "s4",
        sessionKey: "src-4",
        turnIdx: 2,
        cs: 10,
        ce: 32
      }
    })
  })

  it.each([
    ["a two-hop path through an Entity", [token, entity, claimNode()], ["NAMES", "MENTIONS"], 2],
    ["a two-hop path whose middle node is missing", [token, claimNode()], ["NAMES", "MENTIONS"], 2]
  ])("takes hops from the relationships on %s", (_, nodes, types, hops) => {
    const rows = reachedRows([pathOf(nodes, types)])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.hops).toBe(hops)
    expect(rows[0]!.claim.ckey).toBe("u|c|abc")
  })

  it("falls back to the token key when the source has no stem", () => {
    const bare = node(1, "Token", { tkey: "u|t|mortgag", df: 1 })
    expect(reachedRows([pathOf([bare, claimNode()], ["HITS"])])[0]!.anchor).toBe("u|t|mortgag")
  })

  it("falls back to sid when the claim carries no source_session_id", () => {
    const { source_session_id: _dropped, ...withoutSource } = claimNode().properties
    const rows = reachedRows([pathOf([token, node(3, "Claim", withoutSource)], ["HITS"])])
    expect(rows[0]!.claim.sessionKey).toBe("s4")
  })

  it.each([
    ["a path that ends where it starts", pathOf([token], [])],
    ["a target with no claim key", pathOf([token, node(3, "Claim", { text: "x" })], ["HITS"])],
    ["an empty node list", { nodes: [], relationships: [] } satisfies HydraPath]
  ])("skips %s", (_, path) => {
    expect(reachedRows([path])).toEqual([])
  })

  it("defaults missing numbers to zero", () => {
    const sparse = node(3, "Claim", { ckey: "u|c|x" })
    expect(reachedRows([pathOf([token, sparse], ["HITS"])])[0]!.claim).toMatchObject({
      sessionOrd: 0,
      cs: 0,
      ce: 0,
      sid: "",
      sessionKey: ""
    })
  })
})

describe("slotFills", () => {
  const slot = node(5, "Slot", { skey: "u|s|me|mortgage" })

  it("reads Claim -FILLS-> Slot and Slot <-FILLS- Claim alike", () => {
    const outgoing = slotFills([pathOf([claimNode(), slot], ["FILLS"])])
    const incoming = slotFills([pathOf([slot, claimNode()], ["FILLS"])])
    expect(outgoing).toEqual([{ skey: "u|s|me|mortgage", ckey: "u|c|abc" }])
    expect(incoming).toEqual(outgoing)
  })

  it("keeps a fill whose claim key is missing and drops one whose slot key is", () => {
    expect(slotFills([pathOf([slot, node(9, "Claim", {})], ["FILLS"])])).toEqual([
      { skey: "u|s|me|mortgage", ckey: "" }
    ])
    expect(slotFills([pathOf([node(5, "Slot", {}), claimNode()], ["FILLS"])])).toEqual([])
  })
})

describe("middleEntityNames", () => {
  it("names the entity a two-hop path passed through and nothing off a one-hop path", () => {
    expect(middleEntityNames([pathOf([token, entity, claimNode()], ["NAMES", "MENTIONS"])])).toEqual([
      "Wells Fargo"
    ])
    expect(middleEntityNames([pathOf([token, claimNode()], ["HITS"])])).toEqual([])
    expect(
      middleEntityNames([pathOf([token, node(2, "Entity", {}), claimNode()], ["NAMES", "MENTIONS"])])
    ).toEqual([])
  })
})

describe("turn rows", () => {
  const session = node(7, "Session", { sess: "u|sess|s4" })
  const turn = node(8, "Turn", { turn: "u|turn|s4|2", text: "hello", chunks: 2, role: "assistant" })

  it("decodes Turn <- Session by the turn's own key", () => {
    expect(sessionTurns([pathOf([turn, session], ["HAS_TURN"])])).toEqual([
      { key: "u|turn|s4|2", text: "hello", chunks: 2, role: "assistant" }
    ])
    expect(sessionTurns([pathOf([node(8, "Turn", { text: "x" }), session], ["HAS_TURN"])])).toEqual([])
  })

  it("decodes Claim -EVIDENCE-> Turn keyed by the claim", () => {
    expect(evidenceTurns([pathOf([claimNode(), turn], ["EVIDENCE"])])).toEqual([
      { ckey: "u|c|abc", text: "hello", chunks: 2 }
    ])
    expect(evidenceTurns([pathOf([claimNode()], [])])).toEqual([])
  })

  it("reads chunk tails off both walks and only at the expected depth", () => {
    const chunk = node(9, "TurnChunk", { chunk_idx: 1, text: " world" })
    expect(claimChunks([pathOf([claimNode(), turn, chunk], ["EVIDENCE", "HAS_CHUNK"])])).toEqual([
      { key: "u|c|abc", idx: 1, text: " world" }
    ])
    expect(claimChunks([pathOf([claimNode(), turn], ["EVIDENCE"])])).toEqual([])
    expect(turnChunks([pathOf([turn, chunk], ["HAS_CHUNK"])])).toEqual([
      { key: "u|turn|s4|2", idx: 1, text: " world" }
    ])
    expect(turnChunks([pathOf([turn, chunk, chunk], ["HAS_CHUNK", "HAS_CHUNK"])])).toEqual([])
  })

  it("reassembles chunks in index order whatever order they arrived in", () => {
    const rows = [
      { key: "k", idx: 2, text: "C" },
      { key: "k", idx: 1, text: "B" }
    ]
    expect(reassemble("A", rows)).toBe("ABC")
    expect(reassemble("A", [])).toBe("A")
  })

  it("groups chunk rows by key, preserving arrival order", () => {
    const grouped = chunksByKey([
      { key: "a", idx: 2, text: "2" },
      { key: "b", idx: 1, text: "1" },
      { key: "a", idx: 1, text: "1" }
    ])
    expect([...grouped.keys()]).toEqual(["a", "b"])
    expect(grouped.get("a")!.map((row) => row.idx)).toEqual([2, 1])
  })
})
