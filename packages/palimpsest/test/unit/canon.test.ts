import { describe, expect, it } from "vitest"
import { matchKeys, reconcile } from "../../src/index.js"
import type { ExtractedEntity } from "../../src/index.js"

const entity = (
  canon: string,
  etype: ExtractedEntity["etype"] = "thing",
  aliases: ReadonlyArray<string> = []
): ExtractedEntity => ({ canon, etype, aliases })

describe("matchKeys", () => {
  it("ignores articles, plurals, possessives and word order", () => {
    expect(matchKeys(entity("the hamsters"))[0]).toBe(matchKeys(entity("hamster"))[0])
    expect(matchKeys(entity("charity 5k run"))[0]).toBe(matchKeys(entity("5k charity run"))[0])
  })

  it("offers a key for every alias, so either side can make the link", () => {
    const keys = matchKeys(entity("moma", "org", ["museum of modern art"]))
    expect(keys).toContain(matchKeys(entity("museum of modern art"))[0])
  })
})

describe("reconcile", () => {
  it("keeps the canon already in the graph and renames the new spelling to it", () => {
    const result = reconcile([entity("hamster", "pet")], [entity("the hamsters", "pet")])
    expect(result.rename.get("the hamsters")).toBe("hamster")
    expect(result.entities.map((e) => e.canon)).toEqual(["hamster"])
  })

  it("links two spellings through a declared alias", () => {
    const result = reconcile(
      [entity("moma", "org", ["museum of modern art"])],
      [entity("museum of modern art", "org")]
    )
    expect(result.rename.get("museum of modern art")).toBe("moma")
  })

  it("leaves genuinely different entities alone", () => {
    const result = reconcile([entity("hamster", "pet")], [entity("goldfish", "pet")])
    expect(result.rename.size).toBe(0)
    expect(result.entities.map((e) => e.canon)).toEqual(["goldfish", "hamster"])
  })

  it("accumulates aliases, including the spelling it renamed away from", () => {
    const result = reconcile([entity("hamster", "pet", ["nibbles"])], [entity("the hamsters", "pet")])
    const merged = result.entities[0]!
    expect(merged.aliases).toContain("nibbles")
    expect(merged.aliases).toContain("the hamsters")
  })

  it("collapses two new spellings of the same thing onto one canon", () => {
    const result = reconcile([], [entity("hamster", "pet"), entity("hamsters", "pet")])
    expect(result.entities).toHaveLength(1)
    expect(result.rename.get("hamsters")).toBe("hamster")
  })

  it("is a fixpoint: reconciling its own output changes nothing", () => {
    // A re-ingest reconciles the same claims against the entities the previous
    // ingest wrote. If that produced a different answer, the slot count would
    // move on every run — which it did, until this became order-independent.
    const incoming = [
      entity("journal", "thing", ["template"]),
      entity("template", "thing"),
      entity("bullet journals", "thing"),
      entity("moma", "org", ["museum of modern art"]),
      entity("museum of modern art", "org")
    ]
    const first = reconcile([], incoming)
    const second = reconcile(first.entities, incoming)

    expect(second.entities).toEqual(first.entities)
    expect([...second.rename].sort()).toEqual([...first.rename].sort())
  })

  it("does not leave one entity's alias standing as another entity's canon", () => {
    // The failure that made re-ingest non-idempotent: "template" survived as a
    // canon while also being an alias of "journal", so the next pass merged it.
    const result = reconcile([], [
      entity("journal", "thing", ["template"]),
      entity("template", "thing")
    ])
    const canons = new Set(result.entities.map((e) => e.canon))
    for (const written of result.entities) {
      for (const alias of written.aliases) expect(canons.has(alias)).toBe(false)
    }
  })

  it("is order-independent for the graph's existing entities", () => {
    const existing = [entity("hamster", "pet"), entity("moma", "org")]
    const a = reconcile(existing, [entity("the hamsters", "pet")])
    const b = reconcile([...existing].reverse(), [entity("the hamsters", "pet")])
    expect(a.rename.get("the hamsters")).toBe(b.rename.get("the hamsters"))
  })
})
