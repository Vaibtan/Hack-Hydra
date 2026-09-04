import { describe, expect, it } from "vitest"
import {
  DELETE_BY_ID_STATEMENT,
  renderGetByIdQuery,
  renderRelMergeStatement,
  renderVertexMergeStatement
} from "../../src/Cypher.js"

describe("write and by-id statements", () => {
  it("renders the vertex upsert as MERGE-by-id followed by SET", () => {
    expect(renderVertexMergeStatement("Claim", ["kind", "text"])).toBe(
      "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Claim, " +
        "n.__palimpsest_full_key = row.__palimpsest_full_key, n.kind = row.kind, n.text = row.text"
    )
  })

  it("renders the relationship upsert with the full key set beside the properties", () => {
    expect(renderRelMergeStatement("FILLS", "Claim", "Slot", ["at_session"])).toBe(
      "UNWIND $rows AS row MATCH (s:Claim {id: row.s}), (d:Slot {id: row.d}) " +
        "MERGE (s)-[r:FILLS {id: row.r}]->(d) SET r.__palimpsest_full_key = row.__palimpsest_full_key, " +
        "r.at_session = row.at_session"
    )
  })

  it("renders a relationship upsert with no properties", () => {
    expect(renderRelMergeStatement("HAS_TURN", "Session", "Turn", [])).toBe(
      "UNWIND $rows AS row MATCH (s:Session {id: row.s}), (d:Turn {id: row.d}) " +
        "MERGE (s)-[r:HAS_TURN {id: row.r}]->(d) SET r.__palimpsest_full_key = row.__palimpsest_full_key"
    )
  })

  it("projects the full key last on a by-id read", () => {
    expect(renderGetByIdQuery("User", ["claims", "tokens"])).toBe(
      "MATCH (n:User {id: $id}) RETURN n.claims AS claims, n.tokens AS tokens, " +
        "n.__palimpsest_full_key AS __palimpsest_full_key"
    )
  })

  it("deletes by id through UNWIND", () => {
    expect(DELETE_BY_ID_STATEMENT).toBe("UNWIND $rows AS row MATCH (n {id: row.id}) DETACH DELETE n")
  })

  it("refuses an identifier that is not a fixed ASCII name", () => {
    expect(() => renderVertexMergeStatement("Claim", ["kind; DROP"])).toThrow(/invalid property identifier/)
    expect(() => renderRelMergeStatement("HAS TURN", "Session", "Turn", [])).toThrow(/invalid relType/)
  })
})
