export const userKey = (uid: string): string => `${uid}|user`

export const sessionKey = (uid: string, sid: string): string => `${uid}|sess|${sid}`

export const turnKey = (uid: string, sid: string, turnIdx: number): string =>
  `${uid}|turn|${sid}|${turnIdx}`

export const turnChunkKey = (uid: string, sid: string, turnIdx: number, chunkIdx: number): string =>
  `${uid}|turnc|${sid}|${turnIdx}|${chunkIdx}`

export const entityKey = (uid: string, canon: string): string => `${uid}|e|${canon}`

export const slotKey = (uid: string, entityCanon: string, attr: string): string =>
  `${uid}|s|${entityCanon}|${attr}`

export const claimKey = (uid: string, digest: string): string => `${uid}|c|${digest}`

export const tokenKey = (uid: string, stem: string): string => `${uid}|t|${stem}`

export const claimKind = (uid: string): string => `${uid}|claim`

export const tokenPrefix = (uid: string): string => `${uid}|t|`
