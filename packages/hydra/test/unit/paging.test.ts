import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { MAX_RESULT_PAGES, followCursor, type Page } from "../../src/Client.js"
import type { Row } from "../../src/index.js"

/**
 * The page cap, in the abstract.
 *
 * `send` follows a read's `next_cursor` to exhaustion because ignoring it
 * truncates silently — the 1024-row wall. The cap on *how many* pages it will
 * follow used to have the same failure mode one order of magnitude up: at 200
 * pages it stopped and returned what it had, and 204 800 rows of a longer
 * result is indistinguishable from a complete one. It is an error now, and this
 * is the test that says so without needing 200 real round trips.
 */
const row = (n: number): Row => ({ n })

/** A source of `total` rows, one row per page, as the engine pages them. */
const pager = (total: number) => {
  let served = 0
  const page = (): Page => {
    served++
    return {
      rows: [row(served)],
      nextCursor: served < total ? `c${served}` : null,
      queryId: "q1"
    }
  }
  return { page, seen: () => served }
}

describe("followCursor", () => {
  it("returns the first page unchanged when there is no cursor", async () => {
    const rows = await Effect.runPromise(
      followCursor<never>({ rows: [row(1)], nextCursor: null, queryId: "q" }, () => Effect.die("unreachable"), "q")
    )
    expect(rows).toEqual([row(1)])
  })

  it("concatenates every page of a multi-page read", async () => {
    const source = pager(5)
    const rows = await Effect.runPromise(
      followCursor<never>(source.page(), () => Effect.succeed(source.page()), "q")
    )
    expect(rows).toHaveLength(5)
    expect(rows.map((r) => r["n"])).toEqual([1, 2, 3, 4, 5])
  })

  it("stops on an empty page, which is how a read ends on a page boundary", async () => {
    const rows = await Effect.runPromise(
      followCursor<never>(
        { rows: [row(1)], nextCursor: "c1", queryId: "q" },
        () => Effect.succeed({ rows: [], nextCursor: null, queryId: "q" }),
        "q"
      )
    )
    expect(rows).toEqual([row(1)])
  })

  it("carries the query_id forward, which continuing a cursor requires", async () => {
    const seen: Array<string | null> = []
    await Effect.runPromise(
      followCursor<never>(
        { rows: [row(1)], nextCursor: "c1", queryId: "q1" },
        (_cursor, queryId) => {
          seen.push(queryId)
          return Effect.succeed({ rows: [row(2)], nextCursor: null, queryId: null })
        },
        "q"
      )
    )
    expect(seen).toEqual(["q1"])
  })

  it("fails rather than returning a truncated result past the page cap", async () => {
    // A cursor that never ends — a server bug, a runaway query, or simply a
    // result larger than anything this schema can produce. Any of the three
    // must be loud.
    const source = pager(Number.MAX_SAFE_INTEGER)
    const outcome = await Effect.runPromise(
      followCursor<never>(source.page(), () => Effect.succeed(source.page()), "MATCH (n) RETURN n").pipe(
        Effect.either
      )
    )
    expect(outcome._tag).toBe("Left")
    if (outcome._tag === "Left") {
      expect(outcome.left._tag).toBe("HydraLimitError")
      expect(outcome.left.reason).toContain(`${MAX_RESULT_PAGES} pages`)
      expect(outcome.left.reason).toContain("truncated")
      expect(outcome.left.query).toBe("MATCH (n) RETURN n")
    }
    // It read the cap and then stopped, rather than looping.
    expect(source.seen()).toBe(MAX_RESULT_PAGES + 1)
  })
})
