import { Either } from "effect"
import { describe, expect, it } from "vitest"
import {
  frameSegment,
  memoryScopeKey,
  parseMemoryScope,
  scopePrefix
} from "../../src/MemoryScope.js"

describe("parseMemoryScope", () => {
  it("rejects an empty tenant or user id", () => {
    expect(parseMemoryScope("  ", "user-a")).toMatchObject({
      _tag: "Left",
      left: { _tag: "InvalidMemoryScope", field: "tenantId" }
    })
    expect(parseMemoryScope("default", "")).toMatchObject({
      _tag: "Left",
      left: { _tag: "InvalidMemoryScope", field: "uid" }
    })
  })
})

describe("scope framing", () => {
  it("is byte-length-framed, tenant-scoped, and unambiguous for separator-bearing ids", () => {
    expect(frameSegment("user-a")).toBe("6:user-a")
    expect(frameSegment("héllo")).toBe(`${Buffer.byteLength("héllo", "utf8")}:héllo`)
    expect(scopePrefix(Either.getOrThrow(parseMemoryScope("default", "user-a")))).toBe(
      "t7:default|u6:user-a"
    )
    const first = scopePrefix(Either.getOrThrow(parseMemoryScope("default", "user-a")))
    const second = scopePrefix(Either.getOrThrow(parseMemoryScope("other", "user-a")))
    expect(first).not.toBe(second)
    expect(memoryScopeKey(Either.getOrThrow(parseMemoryScope("default", "same-user")))).not.toBe(
      memoryScopeKey(Either.getOrThrow(parseMemoryScope("other", "same-user")))
    )
    const left = scopePrefix(Either.getOrThrow(parseMemoryScope("a|u1:x", "b")))
    const right = scopePrefix(Either.getOrThrow(parseMemoryScope("a", "u1:x|b")))
    expect(left).not.toBe(right)
  })
})
