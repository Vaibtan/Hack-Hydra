import { stems } from "./Tokenize.js"
import type { ExtractedEntity } from "./Extract.js"

export const matchKeys = (entity: ExtractedEntity): ReadonlyArray<string> => {
  const keys = new Set<string>()
  for (const name of [entity.canon, ...entity.aliases]) {
    const key = [...stems(name)].sort().join(" ")
    if (key !== "") keys.add(key)
  }
  return [...keys]
}

export interface Reconciled {
  readonly entities: ReadonlyArray<ExtractedEntity>
  /** Maps a canon as extracted to the canon actually written. */
  readonly rename: ReadonlyMap<string, string>
}

class Groups {
  private readonly parent: Array<number> = []

  add(): number {
    this.parent.push(this.parent.length)
    return this.parent.length - 1
  }

  find(index: number): number {
    let root = index
    while (this.parent[root] !== root) root = this.parent[root]!
    let walk = index
    while (this.parent[walk] !== root) {
      const next = this.parent[walk]!
      this.parent[walk] = root
      walk = next
    }
    return root
  }

  union(a: number, b: number): void {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA !== rootB) this.parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB)
  }
}

const ETYPE_PRIORITY: ReadonlyArray<ExtractedEntity["etype"]> = [
  "self",
  "person",
  "pet",
  "place",
  "org",
  "event",
  "thing",
  "topic"
]

export const reconcile = (
  existing: ReadonlyArray<ExtractedEntity>,
  incoming: ReadonlyArray<ExtractedEntity>
): Reconciled => {
  const members: Array<{ canon: string; etype: ExtractedEntity["etype"]; aliases: Set<string>; existing: boolean }> = []
  const byCanon = new Map<string, number>()

  const addMember = (entity: ExtractedEntity, isExisting: boolean): number => {
    const found = byCanon.get(entity.canon)
    if (found !== undefined) {
      const member = members[found]!
      for (const alias of entity.aliases) member.aliases.add(alias)
      member.existing ||= isExisting
      return found
    }
    const index = members.length
    members.push({
      canon: entity.canon,
      etype: entity.etype,
      aliases: new Set(entity.aliases),
      existing: isExisting
    })
    byCanon.set(entity.canon, index)
    return index
  }

  for (const entity of existing) addMember(entity, true)
  for (const entity of incoming) addMember(entity, false)

  const groups = new Groups()
  for (let i = 0; i < members.length; i++) groups.add()

  const firstWithKey = new Map<string, number>()
  for (let index = 0; index < members.length; index++) {
    const member = members[index]!
    for (const key of matchKeys({ canon: member.canon, etype: member.etype, aliases: [...member.aliases] })) {
      const first = firstWithKey.get(key)
      if (first === undefined) firstWithKey.set(key, index)
      else groups.union(first, index)
    }
  }

  const components = new Map<number, Array<number>>()
  for (let index = 0; index < members.length; index++) {
    const root = groups.find(index)
    const bucket = components.get(root)
    if (bucket === undefined) components.set(root, [index])
    else bucket.push(index)
  }

  const rename = new Map<string, string>()
  const entities: Array<ExtractedEntity> = []

  for (const indices of components.values()) {
    const group = indices.map((index) => members[index]!)
    const pool = group.some((member) => member.existing)
      ? group.filter((member) => member.existing)
      : group
    const canon = [...pool].sort((a, b) => a.canon.localeCompare(b.canon))[0]!.canon

    const aliases = new Set<string>()
    let etype: ExtractedEntity["etype"] = "topic"
    for (const member of group) {
      for (const alias of member.aliases) aliases.add(alias)
      if (member.canon !== canon) {
        aliases.add(member.canon)
        rename.set(member.canon, canon)
      }
      if (ETYPE_PRIORITY.indexOf(member.etype) < ETYPE_PRIORITY.indexOf(etype)) etype = member.etype
    }
    aliases.delete(canon)

    entities.push({ canon, etype, aliases: [...aliases].sort() })
  }

  return {
    entities: entities.sort((a, b) => a.canon.localeCompare(b.canon)),
    rename
  }
}
