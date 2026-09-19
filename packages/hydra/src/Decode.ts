import { Schema } from "effect"

export type Scalar = string | number | boolean
export interface HydraProperties {
  [key: string]: Scalar
}

export interface HydraNode {
  readonly id: number
  readonly labels: ReadonlyArray<string>
  readonly properties: HydraProperties
}

export interface HydraRelationship {
  readonly id: number | null
  readonly type: string
  readonly src: number
  readonly dst: number
  readonly properties: HydraProperties
}

export interface HydraPath {
  readonly nodes: ReadonlyArray<HydraNode>
  readonly relationships: ReadonlyArray<HydraRelationship>
}

export type Cell = Scalar | HydraPath | null
export type Row = Record<string, Cell>

export interface QueryResult {
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<Row>
  readonly bookmark: string | null
  readonly readEpoch: number | null
}

export interface QueryPage extends QueryResult {
  readonly queryId: string
  readonly nextCursor: number | null
}

const ScalarSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
const NullableStringSchema = Schema.Union([Schema.String, Schema.Null])
const NullableNumberSchema = Schema.Union([Schema.Number, Schema.Null])

const WrappedScalarSchema = Schema.Union([
  Schema.Struct({ String: Schema.String }),
  Schema.Struct({ Integer: Schema.Number }),
  Schema.Struct({ SignedInteger: Schema.Number }),
  Schema.Struct({ Float: Schema.Number }),
  Schema.Struct({ Bool: Schema.Boolean })
])

const RawPropertiesSchema = Schema.Record(Schema.String, WrappedScalarSchema)

const RawNodeSchema = Schema.Struct({
  id: Schema.Number,
  labels: Schema.Array(Schema.String),
  properties: RawPropertiesSchema
})

const RawRelationshipSchema = Schema.Struct({
  id: NullableNumberSchema,
  edge_type: Schema.String,
  src: Schema.Number,
  dst: Schema.Number,
  properties: RawPropertiesSchema
})

const RawPathSchema = Schema.Struct({
  nodes: Schema.Array(RawNodeSchema),
  relationships: Schema.Array(RawRelationshipSchema)
})

const RawCellSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("path"), value: RawPathSchema }),
  Schema.Struct({ type: Schema.Literal("vertex_id"), value: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("string"), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal("integer"), value: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("signed_integer"), value: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("float"), value: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("boolean"), value: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("null"), value: Schema.optionalKey(Schema.Null) })
])

/** Successful HydraDB response envelope parsed before domain projection. */
export const RawResponseSchema = Schema.Struct({
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(RawCellSchema)),
  bookmark: NullableStringSchema,
  read_epoch: NullableNumberSchema,
  query_id: Schema.String,
  next_cursor: NullableNumberSchema
}).check(
  Schema.makeFilter((response) => {
    const rowIndex = response.rows.findIndex((row) => row.length !== response.columns.length)
    return rowIndex === -1
      ? undefined
      : {
          path: ["rows", rowIndex],
          issue: `row width must equal the ${response.columns.length}-column response schema`
        }
  })
)

export type RawResponse = typeof RawResponseSchema.Type
type RawProperties = typeof RawPropertiesSchema.Type
type RawPath = typeof RawPathSchema.Type
type RawCell = typeof RawCellSchema.Type

const decodeProperties = (raw: RawProperties): HydraProperties => {
  const out: HydraProperties = {}
  for (const [key, wrapped] of Object.entries(raw)) {
    if ("String" in wrapped) out[key] = wrapped.String
    else if ("Integer" in wrapped) out[key] = wrapped.Integer
    else if ("SignedInteger" in wrapped) out[key] = wrapped.SignedInteger
    else if ("Float" in wrapped) out[key] = wrapped.Float
    else out[key] = wrapped.Bool
  }
  return out
}

export const isHydraPath = (cell: Cell | undefined): cell is HydraPath =>
  cell !== undefined && cell !== null && !Schema.is(ScalarSchema)(cell)

const decodePath = (value: RawPath): HydraPath => ({
  nodes: value.nodes.map((node) => ({
    id: node.id,
    labels: node.labels,
    properties: decodeProperties(node.properties)
  })),
  relationships: value.relationships.map((relationship) => ({
    id: relationship.id,
    type: relationship.edge_type,
    src: relationship.src,
    dst: relationship.dst,
    properties: decodeProperties(relationship.properties)
  }))
})

const decodeCell = (cell: RawCell): Cell => {
  if (cell.type === "path") return decodePath(cell.value)
  if (cell.type === "null") return null
  return cell.value
}

export const decodeResponse = (response: RawResponse): QueryResult => {
  const columns = response.columns
  const rows = response.rows.map((cells) => {
    if (cells.length !== columns.length) {
      throw new Error(`HydraDB row has ${cells.length} cells for ${columns.length} columns`)
    }
    const row: Row = {}
    columns.forEach((column, index) => {
      const cell = cells[index]
      if (cell === undefined) throw new Error("HydraDB row width invariant was violated")
      row[column] = decodeCell(cell)
    })
    return row
  })
  return {
    columns,
    rows,
    bookmark: response.bookmark,
    readEpoch: response.read_epoch
  }
}

export const decodePage = (response: RawResponse): QueryPage => ({
  ...decodeResponse(response),
  queryId: response.query_id,
  nextCursor: response.next_cursor
})
