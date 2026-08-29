import type { DatasetSession } from "@palimpsest/dataset"
import type { ExtractedClaim } from "../../src/Extract.js"
import type { SourceRevision } from "../../src/IngestManifest.js"
import {
  createExtractionGeneration,
  createIndexGeneration,
  planIndexGraphWrite,
  sourceTurnKey
} from "../../src/index.js"
import { canonicalSessionSource } from "../../src/SourceIdentity.js"
import { describe, expect, it } from "vitest"

const session: DatasetSession = {
  sid: "session-a",
  key: "session-a",
  sessionOrd: 1,
  date: { raw: "2026-08-20", dateInt: 20260820, ts: 1_755_657_600_000 },
  turns: [{ turnIdx: 0, role: "user", text: "I live in Mumbai.", hasAnswer: false }]
}

const source = canonicalSessionSource(session)
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

    expect(plan._tag).toBe("Right")
    if (plan._tag === "Left") return

    expect(plan.right.entities).toHaveLength(1)
    expect(plan.right.claims).toHaveLength(1)
    expect(plan.right.slots).toHaveLength(1)
    expect(plan.right.tokens.length).toBeGreaterThan(0)
    expect(plan.right.claims[0]?.properties["index_generation"]).toBe(generation.id)
    expect(plan.right.claims[0]?.properties["source_digest"]).toBe(source.sourceDigest)
    expect(plan.right.relations).toContainEqual(
      expect.objectContaining({
        type: "INDEX_EVIDENCE",
        dstLabel: "SourceTurn",
        dstKey: sourceTurnKey("user-a", "session-a", source.sourceDigest, 0),
        properties: expect.objectContaining({
          index_generation: generation.id,
          source_digest: source.sourceDigest,
          cs: 0,
          ce: 15
        })
      })
    )
    expect(plan.right.entityIdentities[0]).toMatchObject({ canon: "the user", etype: "self" })
  })

  it("rejects a claim whose evidence span cannot resolve inside the source revision", () => {
    const plan = planIndexGraphWrite({
      generation,
      revision,
      session,
      claims: [{ ...claim, span: { ...claim.span, turnIdx: 9 } }]
    })

    expect(plan).toMatchObject({ _tag: "Left", left: { reason: "unknownTurn" } })
  })
})
