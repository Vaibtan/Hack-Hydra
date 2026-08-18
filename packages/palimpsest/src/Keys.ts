/**
 * Every key in the graph starts with `uid|`. That prefix is the whole of our
 * multi-tenancy: the local token is scoped to `default/default`, so all 500
 * benchmark users share one graph and must not be able to see each other.
 * Nothing outside this module builds a key by hand.
 */

export const sessionKey = (uid: string, sid: string): string => `${uid}|sess|${sid}`

export const turnKey = (uid: string, sid: string, turnIdx: number): string =>
  `${uid}|turn|${sid}|${turnIdx}`

/**
 * Turn text over HydraDB's 32 743-byte string property cap spills into numbered
 * chunk vertices; `readTurn` reassembles them.
 */
export const turnChunkKey = (uid: string, sid: string, turnIdx: number, chunkIdx: number): string =>
  `${uid}|turnc|${sid}|${turnIdx}|${chunkIdx}`

export const entityKey = (uid: string, canon: string): string => `${uid}|e|${canon}`

export const slotKey = (uid: string, entityCanon: string, attr: string): string =>
  `${uid}|s|${entityCanon}|${attr}`

export const claimKey = (uid: string, digest: string): string => `${uid}|c|${digest}`

export const tokenKey = (uid: string, stem: string): string => `${uid}|t|${stem}`

/**
 * The constant `Claim.kind` value. `MSpaths` needs a *property* to select
 * targets on, and a per-user constant makes every source→claim pair reachable
 * with the default `pathCount` — see the probe table in the review.
 */
export const claimKind = (uid: string): string => `${uid}|claim`

/** Prefix for `STARTS WITH` scans over one user's tokens. */
export const tokenPrefix = (uid: string): string => `${uid}|t|`
