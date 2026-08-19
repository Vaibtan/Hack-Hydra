import type { AskResponse } from "../api"

/**
 * The verdict card.
 *
 * Three outcomes, three colours, because they mean genuinely different things
 * and the writeup's honesty depends on not blurring them:
 *
 *  - **ANSWER** (green) — claims converged and the reader read them.
 *  - **ABSENT** (violet) — *structural*. `A1`: no anchor of the question exists
 *    in this user's graph at all. `A2`: anchors exist but no claim was reached
 *    by enough of them. Backed by the query and its thin result.
 *  - **NOT_IN_MEMORY** (amber) — the right spans *were* reached and did not
 *    contain the answer. This is the reader declining, one layer later, and it
 *    is not the same claim as A1/A2.
 */

const REASON: Record<string, string> = {
  A1_no_anchors: "A1 — no anchor of this question exists in this user's memory",
  A2_no_convergence: "A2 — anchors exist, but no claim was reached by enough of them"
}

export const Verdict = ({ result }: { readonly result: AskResponse }) => {
  const kind =
    result.verdict === "ABSENT" ? "absent" : result.notInMemory ? "notinmemory" : "answer"
  const label =
    result.verdict === "ABSENT"
      ? `ABSENT · ${result.reason === "A1_no_anchors" ? "A1" : "A2"}`
      : result.notInMemory
        ? "ABSENT · NOT_IN_MEMORY"
        : "ANSWER"

  return (
    <div className={`verdict ${kind}`}>
      <div className="label">{label}</div>

      {result.verdict === "ABSENT" ? (
        <>
          <div className="answer-text">Not in memory</div>
          <div className="why">
            {REASON[result.reason ?? ""] ?? "structural abstention"}. The receipt below is the
            query that was run and what it reached — the abstention is shown, not asserted.
          </div>
        </>
      ) : result.notInMemory ? (
        <>
          <div className="answer-text">Not in memory</div>
          <div className="why">
            Retrieval reached {result.evidence.length} spans and the reader found no answer in
            them. Different from A1/A2: the right text was reached and did not contain it.
            {result.premiseSupported === false && result.premiseNote !== ""
              ? ` Failed premise: ${result.premiseNote}`
              : ""}
          </div>
        </>
      ) : (
        <>
          <div className="answer-text">{result.answer}</div>
          {result.reasoning !== "" && <div className="why">{result.reasoning}</div>}
        </>
      )}

      <div className="chips">
        <span className="chip">{result.evidence.length} spans</span>
        <span className="chip">{result.receipt.query1Paths} paths</span>
        <span className="chip">convergence ≥ {result.receipt.convergenceThreshold}</span>
        <span className="chip">{(result.latencyMs / 1000).toFixed(2)} s</span>
        {result.receipt.asOf !== null && (
          <span className="chip superseded">as of session {result.receipt.asOf}</span>
        )}
      </div>
    </div>
  )
}
