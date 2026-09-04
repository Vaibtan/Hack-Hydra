import type { HydraPath } from "@palimpsest/hydra"

type PathNode = HydraPath["nodes"][number]

const str = (node: PathNode | undefined, key: string): string =>
  node === undefined ? "" : String(node.properties[key] ?? "")

const num = (node: PathNode | undefined, key: string): number =>
  node === undefined ? 0 : Number(node.properties[key] ?? 0)

const first = (path: HydraPath): PathNode | undefined => path.nodes[0]
const last = (path: HydraPath): PathNode | undefined => path.nodes[path.nodes.length - 1]

/** The Claim vertex's own properties, as every walk that ends on a Claim returns them. */
export interface ClaimFields {
  readonly ckey: string
  readonly text: string
  readonly speaker: string
  readonly ctype: string
  readonly sessionOrd: number
  readonly sessionDate: number
  readonly tEvent: number
  readonly tPrec: string
  readonly sid: string
  /** `source_session_id`, falling back to `sid` on a graph written before the property existed. */
  readonly sessionKey: string
  readonly turnIdx: number
  readonly cs: number
  readonly ce: number
}

const claimFields = (node: PathNode): ClaimFields => ({
  ckey: str(node, "ckey"),
  text: str(node, "text"),
  speaker: str(node, "speaker"),
  ctype: str(node, "ctype"),
  sessionOrd: num(node, "session_ord"),
  sessionDate: num(node, "session_date"),
  tEvent: num(node, "t_event"),
  tPrec: str(node, "t_prec"),
  sid: str(node, "sid"),
  sessionKey: str(node, "source_session_id") || str(node, "sid"),
  turnIdx: num(node, "turn_idx"),
  cs: num(node, "cs"),
  ce: num(node, "ce")
})

/** One `Source -> ... -> Claim` path: the anchor it started from and the Claim it reached. */
export interface ReachedRow {
  readonly anchor: string
  readonly df: number
  readonly hops: number
  readonly claim: ClaimFields
}

export const reachedRows = (paths: ReadonlyArray<HydraPath>): ReadonlyArray<ReachedRow> =>
  paths.flatMap((path) => {
    const source = first(path)
    const target = last(path)
    if (source === undefined || target === undefined || source === target) return []
    const claim = claimFields(target)
    if (claim.ckey === "") return []
    return [
      {
        anchor: str(source, "stem") || str(source, "tkey"),
        df: num(source, "df"),
        hops: path.relationships.length,
        claim
      }
    ]
  })

/** One `FILLS` path in either direction. `ckey` may be empty; `skey` never is. */
export interface SlotFill {
  readonly skey: string
  readonly ckey: string
}

export const slotFills = (paths: ReadonlyArray<HydraPath>): ReadonlyArray<SlotFill> =>
  paths.flatMap((path) => {
    const head = first(path)
    const tail = last(path)
    const skey = str(head, "skey") || str(tail, "skey")
    if (skey === "") return []
    return [{ skey, ckey: str(head, "ckey") || str(tail, "ckey") }]
  })

export const middleEntityNames = (paths: ReadonlyArray<HydraPath>): ReadonlyArray<string> =>
  paths.flatMap((path) => {
    if (path.nodes.length !== 3) return []
    const name = str(path.nodes[1], "name")
    return name === "" ? [] : [name]
  })

/** A Turn vertex as `Turn <- Session` returns it, keyed by its own `turn` key. */
export interface TurnText {
  readonly key: string
  readonly text: string
  readonly chunks: number
  readonly role: string
}

export const sessionTurns = (paths: ReadonlyArray<HydraPath>): ReadonlyArray<TurnText> =>
  paths.flatMap((path) => {
    const node = first(path)
    const key = str(node, "turn")
    if (node === undefined || key === "") return []
    return [{ key, text: str(node, "text"), chunks: num(node, "chunks"), role: str(node, "role") }]
  })

/** A Turn vertex as `Claim -EVIDENCE-> Turn` returns it, keyed by the Claim. */
export interface EvidenceTurn {
  readonly ckey: string
  readonly text: string
  readonly chunks: number
}

export const evidenceTurns = (paths: ReadonlyArray<HydraPath>): ReadonlyArray<EvidenceTurn> =>
  paths.flatMap((path) => {
    const claim = first(path)
    const turn = last(path)
    if (claim === undefined || turn === undefined || claim === turn) return []
    return [{ ckey: str(claim, "ckey"), text: str(turn, "text"), chunks: num(turn, "chunks") }]
  })

/** One `HAS_CHUNK` tail, keyed by the walk's source vertex. */
export interface ChunkRow {
  readonly key: string
  readonly idx: number
  readonly text: string
}

const chunkRow = (key: string, chunk: PathNode): ChunkRow => ({
  key,
  idx: num(chunk, "chunk_idx"),
  text: str(chunk, "text")
})

/** `Claim -EVIDENCE-> Turn -HAS_CHUNK-> Chunk`, keyed by `ckey`. */
export const claimChunks = (paths: ReadonlyArray<HydraPath>): ReadonlyArray<ChunkRow> =>
  paths.flatMap((path) => {
    if (path.relationships.length !== 2) return []
    const chunk = path.nodes[2]
    if (chunk === undefined) return []
    return [chunkRow(str(first(path), "ckey"), chunk)]
  })

/** `Turn -HAS_CHUNK-> Chunk`, keyed by the Turn key. */
export const turnChunks = (paths: ReadonlyArray<HydraPath>): ReadonlyArray<ChunkRow> =>
  paths.flatMap((path) => {
    if (path.relationships.length !== 1) return []
    const key = str(first(path), "turn")
    const chunk = path.nodes[1]
    if (key === "" || chunk === undefined) return []
    return [chunkRow(key, chunk)]
  })

/** Appends the spilled tail of a turn that exceeded the engine's string cap, in chunk order. */
export const reassemble = (base: string, chunks: ReadonlyArray<ChunkRow>): string =>
  base +
  [...chunks]
    .sort((a, b) => a.idx - b.idx)
    .map((chunk) => chunk.text)
    .join("")

/** Chunk rows grouped by key, in the order they arrived. */
export const chunksByKey = (rows: ReadonlyArray<ChunkRow>): ReadonlyMap<string, ReadonlyArray<ChunkRow>> => {
  const grouped = new Map<string, Array<ChunkRow>>()
  for (const row of rows) {
    const bucket = grouped.get(row.key) ?? []
    bucket.push(row)
    grouped.set(row.key, bucket)
  }
  return grouped
}
