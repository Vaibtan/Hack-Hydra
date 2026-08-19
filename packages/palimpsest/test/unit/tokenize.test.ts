import { describe, expect, it } from "vitest"
import { MAX_TOKENS_PER_CLAIM, claimTokens, stem, stems } from "../../src/index.js"

describe("stem", () => {
  it("makes a plural and its singular agree, which is what anchors need", () => {
    for (const [plural, singular] of [
      ["hamsters", "hamster"],
      ["boxes", "box"],
      ["companies", "company"],
      ["children", "child"],
      ["people", "person"],
      ["knives", "knife"]
    ]) {
      expect(stem(plural!)).toBe(stem(singular!))
    }
  })

  it("makes an inflected verb agree with its base form", () => {
    expect(stem("moved")).toBe(stem("move"))
    expect(stem("running")).toBe(stem("run"))
    expect(stem("serviced")).toBe(stem("service"))
  })

  it("leaves words alone when stripping would merge unrelated terms", () => {
    expect(stem("bus")).toBe("bus")
    expect(stem("analysis")).toBe("analysis")
    expect(stem("gps")).toBe("gps")
    expect(stem("class")).toBe("class")
  })
})

describe("stems", () => {
  it("keeps content words and drops stopwords", () => {
    // "serviced" and "time" keep their stems; "just", "got", "my", "for",
    // "the" are function words and disappear.
    expect(stems("I just got my car serviced for the first time")).toEqual([
      "car",
      "servic",
      "first",
      "tim"
    ])
  })

  it("splits on punctuation but keeps numbers and possessives intact", () => {
    expect(stems("Wells Fargo's pre-approval was $450,000")).toEqual([
      "well",
      "fargo",
      "pre",
      "approval",
      "450",
      "000"
    ])
  })

  it("is idempotent, so a question term and an ingest term meet at the same key", () => {
    const once = stems("Where do I keep my hamsters?")
    expect(stems(once.join(" "))).toEqual(once)
  })
})

describe("claimTokens", () => {
  it("puts LLM keywords first so hypernyms survive the cap", () => {
    const tokens = claimTokens({
      text: "The user bought a silver Honda Civic on February 10th.",
      keywords: ["vehicle", "automobile"],
      entityNames: ["honda civic"]
    })
    expect(tokens.slice(0, 2)).toEqual(["vehicl", "automobil"])
    expect(tokens).toContain("honda")
    expect(tokens).toContain("silver")
  })

  it("de-duplicates across the three sources", () => {
    const tokens = claimTokens({
      text: "The hamster is called Nibbles.",
      keywords: ["hamster", "pet"],
      entityNames: ["hamster"]
    })
    expect(tokens.filter((t) => t === "hamster")).toHaveLength(1)
  })

  it("caps the number of tokens on any one claim", () => {
    const tokens = claimTokens({
      text: Array.from({ length: 80 }, (_, i) => `word${i}`).join(" "),
      keywords: [],
      entityNames: []
    })
    expect(tokens).toHaveLength(MAX_TOKENS_PER_CLAIM)
  })
})

describe("stem, on words that collide with Object.prototype", () => {
  /**
   * `IRREGULAR` is a plain object literal, so `IRREGULAR["constructor"]` used to
   * return the Object constructor function and `stem` threw
   * `base.endsWith is not a function`. `stems` lowercases before looking up, so
   * "constructor" is the only word that can reach it — and it reaches it in any
   * conversation about code, which is how it crashed the BM25 baseline.
   */
  it("stems 'constructor' instead of throwing", () => {
    expect(() => stem("constructor")).not.toThrow()
    expect(stem("constructor")).toBe("constructor")
  })

  it("tokenises a sentence containing it", () => {
    const terms = stems("The constructor takes a prototype and a valueOf override")
    expect(terms).toContain("constructor")
    expect(terms).toContain("prototyp")
  })

  it("still applies the irregular plurals it actually owns", () => {
    expect(stem("children")).toBe("child")
    // "knives" -> "knife" from the table, then the trailing `e` comes off like
    // every other form, so it meets "knife" and "knifes" on the same key.
    expect(stem("knives")).toBe("knif")
    expect(stem("knife")).toBe("knif")
  })
})
