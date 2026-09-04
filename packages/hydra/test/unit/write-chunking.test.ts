import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { DELETE_ROWS_PER_CHUNK, writeChunked } from "../../src/Chunking.js"
import { isLimit } from "../../src/Classify.js"
import { HydraLimitError, HydraParseError } from "../../src/Errors.js"

const rows = (n: number): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({ id: i }))

const limit = (reason = "client_query_runtime exceeded query timeout after 30000 ms"): HydraLimitError =>
  new HydraLimitError({ reason, status: 500, query: "<test>" })

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
    expect(await run(writeChunked(send, rows(500), { maxRows: 1000 }))).toBe(500)
    expect(sizes).toEqual([500])
  })

  it("splits a payload larger than the row ceiling", async () => {
    const { send, sizes } = engine(1000)
    expect(await run(writeChunked(send, rows(2500), { maxRows: 1000 }))).toBe(2500)
    expect(sizes).toEqual([1000, 1000, 500])
  })

  it("halves on a limit refusal and keeps the smaller size", async () => {
    const { send, sizes } = engine(250)
    expect(await run(writeChunked(send, rows(1000), { maxRows: 1000 }))).toBe(1000)
    expect(sizes).toEqual([1000, 500, 250, 250, 250, 250])
  })

  it("re-chunks only what is left, when a LATER chunk is the one refused", async () => {
    let calls = 0
    const sizes: Array<number> = []
    const send = (chunk: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
      calls++
      sizes.push(chunk.length)
      return calls === 3 && chunk.length > 500 ? Effect.fail(limit()) : Effect.succeed(undefined as unknown)
    }
    expect(await run(writeChunked(send, rows(3000), { maxRows: 1000 }))).toBe(3000)
    expect(sizes).toEqual([1000, 1000, 1000, 500, 500])
  })

  it("loses no rows when it re-chunks mid-write", async () => {
    let seen = 0
    const send = (chunk: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
      if (chunk.length > 100) return Effect.fail(limit())
      seen += chunk.length
      return Effect.succeed(undefined as unknown)
    }
    expect(await run(writeChunked(send, rows(613), { maxRows: 800 }))).toBe(613)
    expect(seen).toBe(613)
  })

  it("gives up rather than looping once a single row is refused", async () => {
    const { send } = engine(0)
    const outcome = await run(Effect.either(writeChunked(send, rows(4), { maxRows: 4 })))
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
    const outcome = await run(Effect.either(writeChunked(send, rows(1000), { maxRows: 1000 })))
    expect(outcome._tag).toBe("Left")
    expect(sizes).toEqual([1000])
  })

  it("writes nothing for an empty payload", async () => {
    const { send, sizes } = engine(1000)
    expect(await run(writeChunked(send, [], { maxRows: 1000 }))).toBe(0)
    expect(sizes).toEqual([])
  })
})

describe("delete chunking", () => {
  const halveOn = (error: HydraLimitError | HydraParseError) =>
    isLimit(error) && !/delete_vertex_scan_edges/.test(error.reason)

  it("starts at the delete chunk size and halves on a timeout", async () => {
    const { send, sizes } = engine(10)
    expect(await run(writeChunked(send, rows(40), { maxRows: DELETE_ROWS_PER_CHUNK, halveOn }))).toBe(40)
    expect(sizes).toEqual([40, 20, 10, 10, 10, 10])
  })

  it("keeps the halved size for the rest of the delete", async () => {
    const { send, sizes } = engine(20)
    expect(await run(writeChunked(send, rows(100), { maxRows: DELETE_ROWS_PER_CHUNK, halveOn }))).toBe(100)
    expect(sizes).toEqual([40, 20, 20, 20, 20, 20])
  })

  it("fails at once on the store-wide edge-scan cap, which no batch size fixes", async () => {
    const sizes: Array<number> = []
    const send = (chunk: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
      sizes.push(chunk.length)
      return Effect.fail(
        limit("delete_vertex_scan_edges rejected by admission control: actual 1000001 exceeds limit 1000000")
      )
    }
    const outcome = await run(
      Effect.either(writeChunked(send, rows(40), { maxRows: DELETE_ROWS_PER_CHUNK, halveOn }))
    )
    expect(outcome._tag).toBe("Left")
    expect(sizes).toEqual([40])
  })
})
