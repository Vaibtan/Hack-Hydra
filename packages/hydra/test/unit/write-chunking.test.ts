import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { writeChunked } from "../../src/Client.js"
import { HydraLimitError, HydraParseError } from "../../src/Errors.js"

/**
 * The halving only ever fires under load, which is the worst possible place to
 * find out it is wrong: on the benchmark runtime a full 1 000-row chunk started
 * crossing the engine's 30 s cap around the ninth user of an ingest, and the
 * whole user was lost each time.
 */
const rows = (n: number): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({ id: i }))

const limit = (): HydraLimitError =>
  new HydraLimitError({
    reason: "client_query_runtime exceeded query timeout after 30000 ms",
    status: 500,
    query: "<test>"
  })

/** Refuses any chunk larger than `ceiling`, and records what it was sent. */
const engine = (ceiling: number) => {
  const sizes: Array<number> = []
  const send = (chunk: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
    sizes.push(chunk.length)
    return chunk.length > ceiling
      ? Effect.fail(limit())
      : Effect.succeed(undefined as unknown)
  }
  return { send, sizes }
}

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

describe("write chunking", () => {
  it("sends one chunk when the engine accepts it", async () => {
    const { send, sizes } = engine(1000)
    expect(await run(writeChunked(send, rows(500), 1000))).toBe(500)
    expect(sizes).toEqual([500])
  })

  it("splits a payload larger than the row ceiling", async () => {
    const { send, sizes } = engine(1000)
    expect(await run(writeChunked(send, rows(2500), 1000))).toBe(2500)
    expect(sizes).toEqual([1000, 1000, 500])
  })

  it("halves on a limit refusal and keeps the smaller size", async () => {
    // The engine refuses anything over 250. The first 1 000-row chunk fails,
    // then 500, then 250 succeeds — and every chunk after it is 250, not 1 000.
    const { send, sizes } = engine(250)
    expect(await run(writeChunked(send, rows(1000), 1000))).toBe(1000)
    expect(sizes).toEqual([1000, 500, 250, 250, 250, 250])
  })

  it("re-chunks only what is left, when a LATER chunk is the one refused", async () => {
    // Every other test in this file refuses the *first* chunk, so
    // `chunks.slice(index)` was never exercised: replacing it with
    // `chunks.flat()` left them all green while production re-sent every row
    // already committed and returned `written` larger than the payload.
    let calls = 0
    const sizes: Array<number> = []
    const send = (chunk: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
      calls++
      sizes.push(chunk.length)
      // The third 1 000-row chunk crosses the cap; everything else is fine.
      return calls === 3 && chunk.length > 500 ? Effect.fail(limit()) : Effect.succeed(undefined as unknown)
    }
    expect(await run(writeChunked(send, rows(3000), 1000))).toBe(3000)
    // 1000, 1000 committed; the third is refused and the *remainder* halves.
    expect(sizes).toEqual([1000, 1000, 1000, 500, 500])
  })

  it("loses no rows when it re-chunks mid-write", async () => {
    let seen = 0
    const send = (chunk: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
      if (chunk.length > 100) return Effect.fail(limit())
      seen += chunk.length
      return Effect.succeed(undefined as unknown)
    }
    expect(await run(writeChunked(send, rows(613), 800))).toBe(613)
    expect(seen).toBe(613)
  })

  it("gives up rather than looping once a single row is refused", async () => {
    const { send } = engine(0)
    const outcome = await run(Effect.either(writeChunked(send, rows(4), 4)))
    expect(outcome._tag).toBe("Left")
  })

  it("does not halve on an error that halving cannot fix", async () => {
    const sizes: Array<number> = []
    const send = (chunk: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
      sizes.push(chunk.length)
      return Effect.fail(
        new HydraParseError({ reason: "syntax", code: "invalid_request", query: "<test>" })
      )
    }
    const outcome = await run(Effect.either(writeChunked(send, rows(1000), 1000)))
    expect(outcome._tag).toBe("Left")
    // One attempt, not a halving cascade: a parse error is the same answer at
    // every size and each retry would cost another round trip.
    expect(sizes).toEqual([1000])
  })

  it("writes nothing for an empty payload", async () => {
    const { send, sizes } = engine(1000)
    expect(await run(writeChunked(send, [], 1000))).toBe(0)
    expect(sizes).toEqual([])
  })
})
