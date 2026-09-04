import { datasetPath, loadQuestion } from "@palimpsest/dataset"
import { Llm, LlmLive } from "@palimpsest/llm"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { extractSession, mergeEntities } from "../../src/Extract.js"

const hasOracle = existsSync(datasetPath("oracle"))

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(Effect.provide(effect, LlmLive()) as unknown as Effect.Effect<A, E, never>)

const UID = "gpt4_2655b836"

describe.skipIf(!hasOracle)("extractSession", () => {
  it("returns located claims from both speakers, with keywords and stable canons", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* Llm
        const question = yield* loadQuestion("oracle", UID).pipe(Effect.orDie)
        const first = yield* extractSession(question.sessions[0]!)
        const known = mergeEntities([], first.claims)
        const second = yield* extractSession(question.sessions[1]!, known)
        return { question, first, second, known }
      })
    )

    const { question, first, second, known } = outcome

    expect(first.claims.length).toBeGreaterThan(5)

    for (const claim of first.claims) {
      const turn = question.sessions[0]!.turns[claim.span.turnIdx]
      expect(turn).toBeDefined()
      expect(claim.span.cs).toBeGreaterThanOrEqual(0)
      expect(claim.span.ce).toBeGreaterThan(claim.span.cs)
      expect(claim.span.ce).toBeLessThanOrEqual(turn!.text.length)
      expect(claim.speaker).toBe(turn!.role)
    }

    expect(first.claims.some((c) => c.speaker === "assistant")).toBe(true)
    expect(first.claims.every((c) => c.keywords.length > 0)).toBe(true)
    expect(first.claims.some((c) => c.slot !== null)).toBe(true)

    const secondCanons = new Set(second.claims.flatMap((c) => c.entities.map((e) => e.canon)))
    const reused = known.filter((entity) => secondCanons.has(entity.canon))
    expect(reused.length).toBeGreaterThan(0)
  })
})
