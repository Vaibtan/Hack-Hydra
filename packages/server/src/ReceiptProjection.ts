import type { V2Answer } from "@palimpsest/palimpsest"
import type { RetrievalPlan } from "./Api.js"

/** The plan for the demo panel: the receipt already carries the full queries, so the arms' are cut. */
export const projectPlan = (answered: V2Answer): typeof RetrievalPlan.Type => {
  const plan = answered.ask.plan
  const read = answered.read
  return {
    route: plan.route,
    routeReason: plan.routeReason,
    flags: Object.entries(plan.flags)
      .filter(([, on]) => on === true)
      .map(([name]) => name)
      .sort(),
    subQuestions: plan.subQuestions,
    probes: plan.probes,
    extraTerms: plan.extraTerms,
    arms: plan.arms.map((arm) => ({
      label: arm.label,
      kind: arm.kind,
      claims: arm.claims,
      paths: arm.paths,
      query: arm.query === null ? null : `${arm.query.slice(0, 120)}…`,
      timedOut: arm.timedOut
    })),
    union: plan.union,
    timeScope: plan.timeScope,
    selection: plan.selection,
    sufficiency: plan.sufficiency,
    budget: plan.budget,
    intervalSentence: plan.intervalSentence,
    stages: {
      ...answered.ask.timings.stages,
      ...(read === null ? {} : { hydrate: read.hydrateMs, read: read.readMs })
    },
    askMs: answered.ask.timings.askMs + (read === null ? 0 : read.readMs),
    graphMs: answered.ask.timings.graphMs + (read === null ? 0 : read.hydrateMs)
  }
}
