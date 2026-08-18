/**
 * HydraDB's HTTP response is doubly typed: result cells carry `{type, value}`
 * and vertex/edge properties carry `{String|Integer|SignedInteger|Float|Bool}`.
 * Nothing outside this module should ever see either envelope.
 */

/** The five HydraDB property types, as plain TS. */
export type Scalar = string | number | boolean

export interface HydraNode {
  readonly id: number
  readonly labels: ReadonlyArray<string>
  readonly properties: Record<string, Scalar>
}

export interface HydraRelationship {
  readonly id: number
  readonly type: string
  readonly src: number
  readonly dst: number
  readonly properties: Record<string, Scalar>
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

const PROPERTY_TAGS = ["String", "Integer", "SignedInteger", "Float", "Bool"] as const

const decodeProperties = (raw: unknown): Record<string, Scalar> => {
  const out: Record<string, Scalar> = {}
  if (raw === null || typeof raw !== "object") return out
  for (const [key, wrapped] of Object.entries(raw as Record<string, unknown>)) {
    if (wrapped === null || typeof wrapped !== "object") continue
    const box = wrapped as Record<string, unknown>
    for (const tag of PROPERTY_TAGS) {
      if (tag in box) {
        out[key] = box[tag] as Scalar
        break
      }
    }
  }
  return out
}

const decodePath = (raw: unknown): HydraPath => {
  const value = (raw ?? {}) as { nodes?: ReadonlyArray<unknown>; relationships?: ReadonlyArray<unknown> }
  return {
    nodes: (value.nodes ?? []).map((n) => {
      const node = n as { id: number; labels?: ReadonlyArray<string>; properties?: unknown }
      return {
        id: node.id,
        labels: node.labels ?? [],
        properties: decodeProperties(node.properties)
      }
    }),
    relationships: (value.relationships ?? []).map((r) => {
      const rel = r as { id: number; edge_type: string; src: number; dst: number; properties?: unknown }
      return {
        id: rel.id,
        type: rel.edge_type,
        src: rel.src,
        dst: rel.dst,
        properties: decodeProperties(rel.properties)
      }
    })
  }
}

const decodeCell = (raw: unknown): Cell => {
  if (raw === null || typeof raw !== "object") return raw as Cell
  const cell = raw as { type?: string; value?: unknown }
  if (cell.type === "path") return decodePath(cell.value)
  // `vertex_id`, `integer`, `float`, `boolean`, `string`, `null` all carry a
  // plain JSON value that already means what it says.
  return (cell.value ?? null) as Cell
}

export interface RawResponse {
  readonly columns?: ReadonlyArray<string>
  readonly rows?: ReadonlyArray<ReadonlyArray<unknown>>
  readonly bookmark?: string | null
  readonly read_epoch?: number | null
}

export const decodeResponse = (raw: RawResponse): QueryResult => {
  const columns = raw.columns ?? []
  const rows = (raw.rows ?? []).map((cells) => {
    const row: Row = {}
    columns.forEach((column, index) => {
      row[column] = decodeCell(cells[index])
    })
    return row
  })
  return {
    columns,
    rows,
    bookmark: raw.bookmark ?? null,
    readEpoch: raw.read_epoch ?? null
  }
}
