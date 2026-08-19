import { formatDateInt, type EvidenceSpan } from "../api"

/**
 * The evidence list.
 *
 * The text here is the **verbatim transcript**, not a claim's text. A Claim is
 * an index entry — a paraphrase produced by an earlier model — and showing it
 * would make the whole system a summary of a summary. What is shown is the turn
 * text around the Span, with the Span itself marked, which is the thing the
 * graph was built to point at.
 */
export const Evidence = ({
  spans,
  cited
}: {
  readonly spans: ReadonlyArray<EvidenceSpan>
  readonly cited: ReadonlyArray<string>
}) => {
  if (spans.length === 0) {
    return (
      <div className="panel">
        <h2>Evidence</h2>
        <p className="muted">
          No evidence. A structural abstention reaches nothing by construction — that is the claim
          it makes, and the receipt is how it is checked.
        </p>
      </div>
    )
  }

  return (
    <div className="panel">
      <h2>Evidence — verbatim transcript, span marked</h2>
      {spans.map((span) => {
        const start = Math.max(0, Math.min(span.highlight.start, span.excerpt.length))
        const end = Math.max(start, Math.min(span.highlight.end, span.excerpt.length))
        const wasCited = cited.includes(span.id)
        return (
          <div className="evidence" key={span.ckey}>
            <header>
              <span className={`chip ${span.status === "CURRENT" ? "current" : "superseded"}`}>
                {span.status === "CURRENT"
                  ? "CURRENT"
                  : `SUPERSEDED @ s${span.atSession ?? "?"}`}
              </span>
              <span>session {span.sessionOrd}</span>
              <span>{formatDateInt(span.sessionDate)}</span>
              <span>{span.speaker}</span>
              <span>[{span.id}]</span>
              {wasCited && <span className="chip hit">cited</span>}
            </header>
            <div className="text">
              {span.excerpt.slice(0, start)}
              <mark>{span.excerpt.slice(start, end)}</mark>
              {span.excerpt.slice(end)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
