import { Effect } from "effect"
import { isLimit } from "./Classify.js"
import { MAX_BODY_BYTES } from "./Cypher.js"
import type { JsonObject } from "./JsonValue.js"

const BODY_BUDGET = Math.floor(MAX_BODY_BYTES * 0.8)

/** Sized by admission control (1 024 rows), not throughput. */
export const MERGE_ROWS_PER_CHUNK = 1_000

/** `DETACH DELETE` retires ~2.3 vertices/s, so the 30 s cap allows ~65 per statement. */
export const DELETE_ROWS_PER_CHUNK = 40

export const chunkRows = <T>(rows: ReadonlyArray<T>, maxRows: number): Array<Array<T>> => {
  const chunks: Array<Array<T>> = []
  let current: Array<T> = []
  let bytes = 0
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1
    if (current.length > 0 && (bytes + size > BODY_BUDGET || current.length >= maxRows)) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(row)
    bytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export interface WriteChunkedOptions<E> {
  readonly maxRows: number
  /** Which failures are worth halving the chunk for. Defaults to any `HydraLimitError`. */
  readonly halveOn?: (error: E) => boolean
}

export const writeChunked = <E, T extends JsonObject>(
  send: (rows: ReadonlyArray<T>) => Effect.Effect<unknown, E>,
  payload: ReadonlyArray<T>,
  options: WriteChunkedOptions<E>
): Effect.Effect<number, E> =>
  Effect.gen(function* () {
    const halveOn = options.halveOn ?? isLimit
    let size = options.maxRows
    let chunks = chunkRows(payload, size)
    let index = 0
    let written = 0
    while (index < chunks.length) {
      const chunk = chunks[index]!
      const outcome = yield* send(chunk).pipe(Effect.result)
      if (outcome._tag === "Success") {
        written += chunk.length
        index++
        continue
      }
      if (!halveOn(outcome.failure) || size === 1) {
        return yield* Effect.fail(outcome.failure)
      }
      size = Math.max(1, Math.floor(size / 2))
      chunks = chunkRows(chunks.slice(index).flat(), size)
      index = 0
    }
    return written
  })
