import type { RetrievalPlan } from "../api"

/**
 * The v2 plan, as stages.
 *
 * The receipt panel beside this one shows what was *read* — the exact
 * `algo.MSpaths` statement, the path counts, the convergence table. This one
 * shows what was *decided*, which is a different question and the one a viewer
 * actually has after watching an answer appear: which route did it take, which
 * arms fired, was a window applied, what did the selector throw away and why.
 *
 * Rendered as a sequence because the pipeline is one — route, arms, scope,
 * select, sufficiency, read — and a table of numbers would hide that each stage
 * only sees what the one before it left.
 */

const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`)

const day = (n: number): string =>
  `${Math.floor(n / 10000)}-${String(Math.floor(n / 100) % 100).padStart(2, "0")}-${String(n % 100).padStart(2, "0")}`

const Stage = ({
  n,
  title,
  took,
  children
}: {
  readonly n: number
  readonly title: string
  readonly took?: number | undefined
  readonly children: React.ReactNode
}) => (
  <div className="stage">
    <div className="stage-head">
      <span className="stage-n">{n}</span>
      <span className="stage-title">{title}</span>
      {took !== undefined && <span className="stage-ms mono">{ms(took)}</span>}
    </div>
    <div className="stage-body">{children}</div>
  </div>
)

export const PlanPanel = ({ plan }: { readonly plan: RetrievalPlan }) => {
  // Concurrent stages overlap, so the per-stage numbers do not sum to `askMs`.
  // Saying so is the difference between a timing panel and a misleading one.
  const armMs = Math.max(
    0,
    ...plan.arms.map((arm) => plan.stages[arm.label] ?? 0)
  )
  const reached = plan.arms.filter((arm) => arm.claims > 0)
  const empty = plan.arms.filter((arm) => arm.claims === 0)

  return (
    <div className="panel">
      <h2>Plan</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        {ms(plan.askMs)} end to end, of which {ms(plan.graphMs)} was HydraDB. Stages run
        concurrently, so their times do not sum.
      </div>

      <Stage n={1} title={`understand — ${plan.route}`} took={plan.stages["understand"]}>
        <div className="chips">
          <span className="chip hit">{plan.route}</span>
          {plan.routeReason !== "model" && <span className="chip">{plan.routeReason}</span>}
          {plan.flags.map((flag) => (
            <span key={flag} className="chip">
              {flag}
            </span>
          ))}
        </div>
        {plan.subQuestions.length > 0 && (
          <ul className="tight">
            {plan.subQuestions.map((sub) => (
              <li key={sub}>{sub}</li>
            ))}
          </ul>
        )}
        {plan.probes.length > 0 && (
          <div className="muted" style={{ marginTop: 6 }}>
            slot probes: <span className="mono">{plan.probes.join("  ")}</span>
          </div>
        )}
      </Stage>

      <Stage n={2} title={`arms — ${plan.union.candidates} candidates`} took={armMs}>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>arm</th>
                <th>claims</th>
                <th>paths</th>
                <th>ms</th>
              </tr>
            </thead>
            <tbody>
              {plan.arms.map((arm) => (
                <tr key={arm.label} className={arm.claims === 0 ? "muted" : undefined}>
                  <td className="mono">
                    {arm.label}
                    {arm.timedOut && <span className="chip miss"> timed out</span>}
                  </td>
                  <td className="mono">{arm.claims}</td>
                  <td className="mono">{arm.paths}</td>
                  <td className="mono">{ms(plan.stages[arm.label] ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          {reached.length} of {plan.arms.length} arms reached a claim
          {empty.length > 0 && ` · ${empty.length} empty, which is an answer too`}
          {plan.union.dropped > 0 && ` · ${plan.union.dropped} dropped by the union cap`}
        </div>
        {plan.extraTerms.length > 0 && (
          <div className="muted" style={{ marginTop: 6 }}>
            second pass, widened by:{" "}
            <span className="mono">{plan.extraTerms.join(" ")}</span>
          </div>
        )}
      </Stage>

      <Stage n={3} title="scope">
        {plan.timeScope.applied && plan.timeScope.interval !== null ? (
          <>
            <div>
              &ldquo;{plan.timeScope.phrase}&rdquo; resolved to {day(plan.timeScope.interval[0])} up
              to {day(plan.timeScope.interval[1])}
            </div>
            <div className="muted">
              {plan.timeScope.inScope} in the window, {plan.timeScope.outOfScope} outside it
              {plan.timeScope.inScope < 10 && plan.timeScope.outOfScope > 0 && (
                <> — too few inside to drop the rest, so both were kept</>
              )}
            </div>
          </>
        ) : (
          <span className="muted">no time phrase in the question — nothing to scope by</span>
        )}
      </Stage>

      <Stage n={4} title={`select — ${plan.selection.kept.length} kept`} took={plan.stages["select"]}>
        {plan.selection.fallback && (
          <div className="chip miss" style={{ marginBottom: 6 }}>
            selector fell back to the deterministic ranking
          </div>
        )}
        <div className="chips">
          {plan.selection.kept.slice(0, 24).map((id) => (
            <span key={id} className="chip hit" title={plan.selection.reasons[id] ?? ""}>
              {id}
              {plan.selection.reasons[id] !== undefined && (
                <span className="muted"> {plan.selection.reasons[id]}</span>
              )}
            </span>
          ))}
        </div>
        {plan.selection.dropped.length > 0 && (
          <div className="muted" style={{ marginTop: 6 }}>
            {plan.selection.dropped.filter((d) => d.reason === "selector").length} dropped by the
            selector, {plan.selection.dropped.filter((d) => d.reason === "turn_cap").length} by the
            turn cap
          </div>
        )}
      </Stage>

      <Stage n={5} title="sufficiency" took={plan.stages["sufficiency"]}>
        {plan.sufficiency.tier === "skipped" ? (
          <span className="muted">
            skipped — this route answers from one excerpt, and the fast profile never runs it
          </span>
        ) : (
          <>
            <span className={plan.sufficiency.tier === "PARTIAL" ? "chip miss" : "chip hit"}>
              {plan.sufficiency.tier}
            </span>
            {plan.sufficiency.missing !== "" && (
              <div className="muted" style={{ marginTop: 6 }}>
                missing: {plan.sufficiency.missing}
              </div>
            )}
            {plan.sufficiency.premise !== "" && (
              <div className="muted" style={{ marginTop: 6 }}>
                premise the excerpts contradict: {plan.sufficiency.premise}
              </div>
            )}
            {plan.sufficiency.secondPass && (
              <div className="muted" style={{ marginTop: 6 }}>
                went back once for the missing piece
              </div>
            )}
          </>
        )}
      </Stage>

      <Stage n={6} title="read" took={plan.stages["read"]}>
        <span className="muted">
          hydrated in {ms(plan.stages["hydrate"] ?? 0)} — verbatim turn text, never a claim's own
          words
        </span>
        {plan.budget !== null && (
          <div className="muted" style={{ marginTop: 6 }}>
            {plan.budget.estimatedTokens} of {plan.budget.budget} reader tokens, estimated at{" "}
            {plan.budget.charsPerToken} characters each
            {plan.budget.dropped.length > 0 && (
              <>
                {" "}
                — {plan.budget.dropped.length} excerpt
                {plan.budget.dropped.length === 1 ? "" : "s"} dropped to fit
              </>
            )}
            {/* Reachable and worth showing: probe hits are never dropped, so a
                question that named several can exceed the budget with nothing
                left that may be cut. */}
            {plan.budget.overBudget && (
              <> — over budget, and every excerpt left is one the question named</>
            )}
          </div>
        )}
        {plan.intervalSentence !== null && (
          <div className="muted" style={{ marginTop: 6 }}>
            the reader was also told: {plan.intervalSentence}
          </div>
        )}
      </Stage>
    </div>
  )
}
