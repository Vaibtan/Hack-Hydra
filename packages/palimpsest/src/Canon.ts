import { stems } from "./Tokenize.js"
import type { ExtractedEntity } from "./Extract.js"

/**
 * Canon reconciliation.
 *
 * Extraction runs on a session alone, with no knowledge of the user, so the
 * same call can be cached and shared across every user whose haystack contains
 * that session. The cost of that is that two sessions can name the same thing
 * differently — "hamster" and "pet hamster", "MoMA" and "the moma". Reconciling
 * them happens here, deterministically and for free, rather than by paying for
 * a bigger prompt.
 *
 * The match key is an entity's stems, sorted and joined: it survives
 * pluralisation, articles, possessives and word order. Aliases produce keys
 * too, so "moma" and "museum of modern art" collapse if either side declared
 * the other.
 *
 * **This has to be a fixpoint.** A re-ingest reconciles the same claims against
 * the entities the previous ingest wrote, and if that produced a different
 * answer the slot count would move on every run. A sequential "first canon to
 * claim a key wins" pass is not a fixpoint: an entity registered late can
 * introduce a key that an entity processed earlier would have matched, so the
 * output can contain one entity's alias as another entity's canon — and the
 * next run then merges them. Grouping by connected component removes the order
 * dependence entirely.
 */

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

/** Union-find over entity indices, keyed by shared match keys. */
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
  // One member per distinct canon on each side. `existing` members are marked,
  // because a canon already in the graph must win — otherwise a re-ingest
  // renames vertices that are already written.
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
    // An already-written canon wins; ties break alphabetically so the choice is
    // the same on every run.
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
