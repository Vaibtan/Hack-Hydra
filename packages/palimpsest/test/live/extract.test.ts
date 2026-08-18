import { datasetPath, loadQuestion } from "@palimpsest/dataset"
import { Llm, LlmLive } from "@palimpsest/llm"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { extractSession, mergeEntities } from "../../src/index.js"

/**
 * Extraction against the real model and a real session. Everything asserted
 * here is a property the day-1 gate depends on, and none of it can be checked
 * against a mock: whether the model produces claims from assistant turns,
 * whether the quotes it returns can be located, and whether an entity canon
 * survives into the next session's prompt.
 *
 * Cached after the first run, so this costs nothing on re-runs.
 */
const hasOracle = existsSync(datasetPath("oracle"))

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(Effect.provide(effect, LlmLive()) as unknown as Effect.Effect<A, E, never>)

/** A car-servicing haystack: user facts, assistant recommendations, and dates. */
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

    // Every span must be a real span into the turn it names — this is the
    // property the whole "index over verbatim transcript" thesis rests on.
    for (const claim of first.claims) {
      const turn = question.sessions[0]!.turns[claim.span.turnIdx]
      expect(turn).toBeDefined()
      expect(claim.span.cs).toBeGreaterThanOrEqual(0)
      expect(claim.span.ce).toBeGreaterThan(claim.span.cs)
      expect(claim.span.ce).toBeLessThanOrEqual(turn!.text.length)
      expect(claim.speaker).toBe(turn!.role)
    }

    // Assistant turns are in scope: single-session-assistant is 56 questions.
    expect(first.claims.some((c) => c.speaker === "assistant")).toBe(true)
    // Write-time query expansion depends on these existing.
    expect(first.claims.every((c) => c.keywords.length > 0)).toBe(true)
    // Supersession can only fire if claims land in slots.
    expect(first.claims.some((c) => c.slot !== null)).toBe(true)

    // The second session was prompted with the first's entities, so at least
    // one canon must be reused rather than reinvented.
    const secondCanons = new Set(second.claims.flatMap((c) => c.entities.map((e) => e.canon)))
    const reused = known.filter((entity) => secondCanons.has(entity.canon))
    expect(reused.length).toBeGreaterThan(0)
  })
})
