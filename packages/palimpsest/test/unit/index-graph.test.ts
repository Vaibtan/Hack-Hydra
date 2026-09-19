import type { DatasetSession } from "@palimpsest/dataset"
import type { ExtractedClaim } from "../../src/Extract.js"
import type { SourceRevision } from "../../src/IngestManifest.js"
import { createIndexGeneration } from "../../src/IndexGeneration.js"
import { indexSlotKey, planIndexGraphWrite } from "../../src/IndexGraph.js"
import { parseMemoryScope } from "../../src/MemoryScope.js"
import { createExtractionGeneration } from "../../src/SourceIdentity.js"
import { sourceSessionKey, sourceTurnKey } from "../../src/SourceTranscript.js"
import { canonicalSessionSource } from "../../src/SourceIdentity.js"
import { Result } from "effect"
import { describe, expect, it } from "vitest"

const session: DatasetSession = {
  sid: "session-a",
  key: "session-a",
  sessionOrd: 1,
  date: { raw: "2026-08-20", dateInt: 20260820, ts: 1_755_657_600_000 },
  turns: [{ turnIdx: 0, role: "user", text: "I live in Mumbai.", hasAnswer: false }]
}

const source = canonicalSessionSource(session)

const scope = Result.getOrThrow(parseMemoryScope("default", "user-a"))
const otherTenantScope = Result.getOrThrow(parseMemoryScope("other-tenant", "user-a"))
const revision: SourceRevision = {
  tenant: "default",
  uid: "user-a",
  logicalSessionId: session.key,
  sourceDigest: source.sourceDigest,
  sourceBytes: source.sourceBytes,
  extractionGeneration: "extract-v1-test",
  sessionOrdinal: 1,
  commitId: "ingest-test",
  state: "SOURCE_DURABLE",
  manifestVersion: 1,
  failureCode: null,
  failureRetryable: null
}

const generation = createIndexGeneration({
  extractionGeneration: createExtractionGeneration({
    extractor: { id: "claim-extractor", revision: "git:abc123" },
    model: { id: "provider/model", revision: "snapshot:2026-08-20" },
    tokenizer: { id: "provider/tokenizer", revision: "v1" },
    promptTemplate: "Extract claims.",
    outputSchema: { type: "object", version: 1 }
  }),
  graphWriter: { id: "palimpsest-index-graph", revision: "git:abc123" },
  graphSchema: { id: "palimpsest-index-schema", revision: "v1" }
})

const claim: ExtractedClaim = {
  text: "The user lives in Mumbai.",
  speaker: "user",
  ctype: "fact",
  entities: [{ canon: "the user", etype: "self", aliases: ["I"] }],
  slot: { entityCanon: "the user", attr: "residence" },
  tEvent: 0,
  tPrec: "none",
  span: { turnIdx: 0, cs: 0, ce: 15 },
  keywords: ["Mumbai"],
  located: "exact"
}

describe("planIndexGraphWrite", () => {
  it("isolates every derived record by source revision and index generation", () => {
    const plan = planIndexGraphWrite({ generation, revision, session, claims: [claim] })

    expect(plan._tag).toBe("Success")
    if (plan._tag === "Failure") return

    expect(plan.success.entities).toHaveLength(1)
    expect(plan.success.claims).toHaveLength(1)
    expect(plan.success.slots).toHaveLength(1)
    expect(plan.success.tokens.length).toBeGreaterThan(0)
    expect(plan.success.claims[0]?.properties["index_generation"]).toBe(generation.id)
    expect(plan.success.claims[0]?.properties["source_digest"]).toBe(source.sourceDigest)
    expect(plan.success.relations).toContainEqual(
      expect.objectContaining({
        type: "INDEX_EVIDENCE",
        dstLabel: "SourceTurn",
        dstKey: sourceTurnKey(scope, "session-a", source.sourceDigest, 0),
        properties: expect.objectContaining({
          index_generation: generation.id,
          source_digest: source.sourceDigest,
          cs: 0,
          ce: 15
        })
      })
    )
    expect(plan.success.entityIdentities[0]).toMatchObject({ canon: "the user", etype: "self" })
  })

  it("rejects a claim whose evidence span cannot resolve inside the source revision", () => {
    const plan = planIndexGraphWrite({
      generation,
      revision,
      session,
      claims: [{ ...claim, span: { ...claim.span, turnIdx: 9 } }]
    })

    expect(plan).toMatchObject({ _tag: "Failure", failure: { reason: "unknownTurn" } })
  })

  it("scopes every derived key by tenant so equal user ids cannot share graph keys", () => {
    const plan = planIndexGraphWrite({ generation, revision, session, claims: [claim] })
    if (plan._tag === "Failure") return expect.unreachable()

    const otherRevision: SourceRevision = { ...revision, tenant: "other-tenant" }
    const other = planIndexGraphWrite({ generation, revision: otherRevision, session, claims: [claim] })
    if (other._tag === "Failure") return expect.unreachable()

    const keys = [
      ...plan.success.claims.map((vertex) => vertex.key),
      ...plan.success.slots.map((vertex) => vertex.key),
      ...plan.success.tokens.map((vertex) => vertex.key)
    ]
    const otherKeys = [
      ...other.success.claims.map((vertex) => vertex.key),
      ...other.success.slots.map((vertex) => vertex.key),
      ...other.success.tokens.map((vertex) => vertex.key)
    ]
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(otherKeys).not.toContain(key)
    }
    expect(sourceSessionKey(scope, "session-a", source.sourceDigest)).not.toBe(
      sourceSessionKey(otherTenantScope, "session-a", source.sourceDigest)
    )
    // Free-text segments are length-framed: an attr containing a separator
    // cannot alias another attr.
    expect(
      indexSlotKey(scope, generation.id, "session-a", source.sourceDigest, "identity", "a|b")
    ).not.toBe(indexSlotKey(scope, generation.id, "session-a", source.sourceDigest, "identity", "a"))
  })
})
