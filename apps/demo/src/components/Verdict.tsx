import type { AskResponse } from "../api"

const REASON: Record<NonNullable<AskResponse["reason"]>, string> = {
  A1_no_anchors: "A1 — no anchor of this question exists in this user's memory",
  A2_no_convergence: "A2 — anchors exist, but no claim was reached by enough of them",
  INSUFFICIENT_EVIDENCE: "the excerpts reached do not hold everything the question needs",
  CONTRADICTED_PREMISE: "the question assumes something the excerpts contradict"
}

const SHORT: Record<NonNullable<AskResponse["reason"]>, string> = {
  A1_no_anchors: "A1",
  A2_no_convergence: "A2",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
  CONTRADICTED_PREMISE: "CONTRADICTED_PREMISE"
}

export const Verdict = ({ result }: { readonly result: AskResponse }) => {
  const kind =
    result.verdict === "ABSENT" ? "absent" : result.notInMemory ? "notinmemory" : "answer"
  const label =
    result.verdict === "ABSENT"
      ? `ABSENT · ${result.reason === null ? "" : SHORT[result.reason]}`
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
            {result.reason === null ? "structural abstention" : REASON[result.reason]}. The receipt
            below is the query that was run and what it reached — the abstention is shown, not
            asserted.
            {result.plan.sufficiency.premise !== ""
              ? ` Premise: ${result.plan.sufficiency.premise}`
              : ""}
          </div>
        </>
      ) : result.notInMemory ? (
        <>
          <div className="answer-text">Not in memory</div>
          <div className="why">
            Retrieval reached {result.evidence.length} spans and the reader found no answer in
            them. Different from A1/A2: the right text was reached and did not contain it.
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
