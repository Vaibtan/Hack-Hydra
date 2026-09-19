import { Effect } from "effect"

type BehaviorImplementation<Service> = {
  readonly [Key in keyof Service]?: Service[Key] extends (...args: ReadonlyArray<never>) => void
    ? (...args: ReadonlyArray<never>) => void
    : Service[Key]
}

/**
 * Declares a deliberately partial, behavior-focused service double. Tests using
 * this helper must exercise only the methods present in `implementation`.
 */
export const behaviorFake = <Service extends object>(
  implementation: BehaviorImplementation<Service>
): Service => {
  // SAFETY: the caller supplies every service method reached by the focused test; an omitted method fails immediately if the test expands its behavior.
  return implementation as Service
}

/** Runs an effect whose remaining declared requirements belong to behavior fakes. */
export const runWithBehaviorFakes = <A, E>(effect: Effect.Effect<A, E, unknown>): Promise<A> => {
  // SAFETY: behaviorFake implementations used by the caller do not access the ambient dependencies declared by their production service signatures.
  return Effect.runPromise(effect as Effect.Effect<A, E, never>)
}
