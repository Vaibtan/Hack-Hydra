import type {
  PlanSufficiency,
  Receipt as RetrievalReceipt,
  V2Answer
} from "@palimpsest/palimpsest"

/**
 * Projects the retrieval trace into the HTTP contract without dropping any
 * input required to replay the diagnostic rendering.
 */
export const projectRetrievalReceipt = (receipt: RetrievalReceipt) => ({
  question: receipt.question,
  uid: receipt.uid,
  pipeline: receipt.pipeline,
  profile: receipt.profile,
  asOf: receipt.asOf,
  anchorTerms: receipt.anchorTerms,
  anchorsReachingClaims: receipt.anchorsReachingClaims,
  anchorsReachingNothing: receipt.anchorsReachingNothing,
  historical: receipt.historical,
  wantsCount: receipt.wantsCount,
  timeRef: receipt.timeRef,
  convergenceThreshold: receipt.convergenceThreshold,
  totalClaims: receipt.totalClaims,
  query1: receipt.query1,
  query1Params: receipt.query1Params,
  query1Paths: receipt.query1Paths,
  query2: receipt.query2,
  query2Paths: receipt.query2Paths,
  models: receipt.models,
  convergence: receipt.convergence
})

/**
 * Projects the v2 plan for the demo panel: what each stage decided, and how
 * long it took.
 *
 * The receipt says what was *read*; the plan says what was *decided*, and the
 * panel exists because those are different questions. A viewer who has just
 * watched an answer appear wants to know which route it took, which arms fired,
 * whether a window was applied and what the selector threw away — none of which
 * a query string tells them.
 *
 * The queries are dropped here on purpose. They are in the receipt already, in
 * full, and repeating four kilobytes of Cypher inside the plan would make the
 * panel's payload mostly text nobody reads.
 */
export const projectPlan = (answered: V2Answer) => {
  const plan = answered.ask.plan
  if (plan === null) return null
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
      // Named, not inlined: the full text is in the receipt, and a panel is not
      // the place to render it twice.
      query: arm.query === null ? null : `${arm.query.slice(0, 120)}…`,
      timedOut: arm.timedOut
    })),
    union: plan.union,
    timeScope: plan.timeScope,
    selection: plan.selection,
    // Off the plan, not reassembled here. `answerV2` writes the verdict back
    // onto the plan it returns, so the panel, the results row and the CLI all
    // read the field #29 asks for rather than three private projections of it.
    sufficiency: plan.sufficiency ?? ({
      tier: "skipped",
      missing: "",
      premise: "",
      premiseContradictedBy: [],
      secondPass: false
    } satisfies PlanSufficiency),
    budget: plan.budget,
    intervalSentence: plan.intervalSentence,
    stages: {
      ...answered.ask.timings.stages,
      ...(answered.read === null
        ? {}
        : { hydrate: answered.read.hydrateMs, read: answered.read.readMs })
    },
    askMs: answered.ask.timings.askMs + (answered.read?.readMs ?? 0),
    graphMs: answered.ask.timings.graphMs + (answered.read?.hydrateMs ?? 0)
  }
}
