import { Effect } from "effect"
import type { Row } from "./Decode.js"
import { HydraLimitError } from "./Errors.js"

/** 200 pages of 1024 rows is past the engine's own 100 k result-vertex cap; exceeding it is an error, never a truncated result. */
export const MAX_RESULT_PAGES = 200

/** One response's worth of a paged read. */
export interface Page {
  readonly rows: ReadonlyArray<Row>
  readonly nextCursor: string | number | null
  readonly queryId: string | null
}

export const followCursor = <E>(
  first: Page,
  nextPage: (cursor: string | number, queryId: string | null) => Effect.Effect<Page, E>,
  query: string
): Effect.Effect<ReadonlyArray<Row>, E | HydraLimitError> =>
  Effect.gen(function* () {
    const rows = [...first.rows]
    let cursor = first.nextCursor
    let queryId = first.queryId

    for (let page = 1; cursor !== null && cursor !== ""; page++) {
      if (page > MAX_RESULT_PAGES) {
        return yield* new HydraLimitError({
          reason:
            `result exceeded ${MAX_RESULT_PAGES} pages (${rows.length} rows) and the cursor is ` +
            `still open — refusing to return a silently truncated result`,
          status: 413,
          query
        })
      }
      const next = yield* nextPage(cursor, queryId)
      if (next.rows.length === 0) break
      rows.push(...next.rows)
      cursor = next.nextCursor
      queryId = next.queryId ?? queryId
    }

    return rows
  })
