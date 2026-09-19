export interface BatchEnvelope {
  readonly batch?: {
    readonly index: number
    readonly count: number
    readonly population?: ReadonlyArray<string>
  }
  readonly rows: ReadonlyArray<{ readonly questionId: string }>
}

export interface BatchPart<Envelope extends BatchEnvelope = BatchEnvelope> {
  readonly name: string
  readonly envelope: Envelope
}

export interface MergedBatches<Row> {
  readonly count: number
  readonly population: ReadonlyArray<string> | null
  readonly rows: ReadonlyArray<Row>
}

export interface MergeBatchesReport<Row> {
  readonly refusals: ReadonlyArray<string>
  readonly merged: MergedBatches<Row> | null
}

const stringify = <Value>(value: Value): string => JSON.stringify(value ?? null)

/** Refuses, rather than repairs, a batch set that is not one whole measurement. */
export const mergeBatches = <
  Envelope extends BatchEnvelope
>(
  parts: ReadonlyArray<BatchPart<Envelope>>,
  fields: ReadonlyArray<Extract<keyof Envelope, string>>
): MergeBatchesReport<Envelope["rows"][number]> => {
  const refusals: Array<string> = []
  const batches = parts.map((part) => {
    if (part.envelope.batch === undefined) refusals.push(`${part.name} carries no batch record`)
    return part.envelope.batch
  })
  const count = batches[0]?.count
  if (count === undefined) return { refusals, merged: null }
  if (batches.some((one) => one?.count !== count)) {
    refusals.push(
      "the files disagree about how many batches there are: " +
        [...new Set(batches.map((one) => one?.count))].join(", ")
    )
  }
  const seen = new Set(batches.map((one) => one?.index))
  for (let index = 1; index <= count; index++) {
    if (!seen.has(index)) refusals.push(`batch ${index} of ${count} is missing`)
  }
  if (seen.size !== batches.length) refusals.push("two files claim the same batch index")

  for (const field of fields) {
    const values = [...new Set(parts.map((part) => stringify(part.envelope[field])))]
    if (values.length > 1) {
      refusals.push(`the batches disagree on \`${field}\`: ${values.join(" vs ")}`)
    }
  }

  const population = batches[0]?.population ?? null
  if (batches.some((one) => stringify(one?.population) !== stringify(population))) {
    refusals.push("the batches were cut from different populations")
  }

  const byId = new Map<string, Envelope["rows"][number]>()
  for (const row of parts.flatMap((part) => part.envelope.rows)) {
    if (byId.has(row.questionId)) {
      refusals.push(`${row.questionId} was answered by more than one batch`)
    }
    byId.set(row.questionId, row)
  }
  const order = population ?? [...byId.keys()].sort((a, b) => a.localeCompare(b))
  for (const questionId of order) {
    if (!byId.has(questionId)) refusals.push(`${questionId} is in no batch's rows`)
  }
  if (refusals.length > 0) return { refusals, merged: null }
  return {
    refusals,
    merged: { count, population, rows: order.map((questionId) => byId.get(questionId)!) }
  }
}
