import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { MAX_RESULT_PAGES, followCursor, type Page } from "../../src/Paging.js"
import type { Row } from "../../src/Decode.js"

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
    const source = pager(Number.MAX_SAFE_INTEGER)
    const outcome = await Effect.runPromise(
      followCursor<never>(source.page(), () => Effect.succeed(source.page()), "MATCH (n) RETURN n").pipe(
        Effect.result
      )
    )
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag === "Failure") {
      expect(outcome.failure._tag).toBe("HydraLimitError")
      expect(outcome.failure.reason).toContain(`${MAX_RESULT_PAGES} pages`)
      expect(outcome.failure.reason).toContain("truncated")
      expect(outcome.failure.query).toBe("MATCH (n) RETURN n")
    }
    expect(source.seen()).toBe(MAX_RESULT_PAGES + 1)
  })
})
