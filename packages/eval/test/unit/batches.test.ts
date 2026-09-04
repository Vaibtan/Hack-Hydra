import { describe, expect, it } from "vitest"
import { mergeBatches, type BatchPart } from "../../src/index.js"

interface Row {
  readonly questionId: string
}

const part = (
  index: number,
  count: number,
  ids: ReadonlyArray<string>,
  extra: Record<string, unknown> = {}
): BatchPart<Row> => ({
  name: `b${index}`,
  envelope: {
    prefix: "g3",
    variant: [],
    batch: { index, count, population: ["a", "b", "c", "d"] },
    rows: ids.map((questionId) => ({ questionId })),
    ...extra
  }
})

const FIELDS = ["prefix", "variant"]

describe("merging batches", () => {
  it("joins a complete set in population order", () => {
    const { refusals, merged } = mergeBatches([part(2, 2, ["d", "c"]), part(1, 2, ["a", "b"])], FIELDS)
    expect(refusals).toEqual([])
    expect(merged?.rows.map((row) => row.questionId)).toEqual(["a", "b", "c", "d"])
    expect(merged?.count).toBe(2)
  })

  it("refuses a missing batch, a duplicated index and a row answered twice", () => {
    const { refusals, merged } = mergeBatches(
      [part(1, 3, ["a", "b"]), part(1, 3, ["b"])],
      FIELDS
    )
    expect(merged).toBeNull()
    expect(refusals).toContain("batch 2 of 3 is missing")
    expect(refusals).toContain("two files claim the same batch index")
    expect(refusals).toContain("b was answered by more than one batch")
  })

  it("refuses batches whose envelopes disagree on a measurement field", () => {
    const { refusals } = mergeBatches(
      [part(1, 2, ["a", "b"], { prefix: "g2" }), part(2, 2, ["c", "d"])],
      FIELDS
    )
    expect(refusals.some((line) => line.includes("`prefix`"))).toBe(true)
  })

  it("refuses a batch whose variant differs from the others", () => {
    const { refusals } = mergeBatches(
      [part(1, 2, ["a", "b"], { variant: ["profile-fast"] }), part(2, 2, ["c", "d"])],
      FIELDS
    )
    expect(refusals.some((line) => line.includes("`variant`"))).toBe(true)
  })

  it("refuses batches cut from different populations, and a file with no batch record", () => {
    const other = part(2, 2, ["c", "d"])
    const cut = { ...other, envelope: { ...other.envelope, batch: { index: 2, count: 2, population: ["a", "b", "c"] } } }
    expect(mergeBatches([part(1, 2, ["a", "b"]), cut], FIELDS).refusals).toContain(
      "the batches were cut from different populations"
    )
    const { batch: _batch, ...noBatch } = part(1, 1, ["a"]).envelope
    expect(mergeBatches([{ name: "x", envelope: noBatch }], FIELDS).refusals).toContain(
      "x carries no batch record"
    )
  })

  it("orders by question id when the batches carry no population, as the reader A/B does", () => {
    const parts = [part(1, 2, ["b"]), part(2, 2, ["a"])].map((one) => ({
      ...one,
      envelope: { ...one.envelope, batch: { index: one.envelope.batch!.index, count: 2 } }
    }))
    const { merged } = mergeBatches(parts, FIELDS)
    expect(merged?.population).toBeNull()
    expect(merged?.rows.map((row) => row.questionId)).toEqual(["a", "b"])
  })
})
