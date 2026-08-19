import type { Receipt } from "../api"

/**
 * The receipt.
 *
 * This is the differentiator, so it shows the *actual* artefacts rather than a
 * summary of them: the exact `algo.MSpaths` statement that ran, which anchors
 * reached a claim and which reached nothing, the path counts, and the
 * convergence table behind the ranking. Enough for someone to re-run the read
 * by hand and get the same paths.
 *
 * Structural abstention does not carry the pitch on a well-populated graph —
 * with ~2 000 claims and ~15 resolved anchors, something always converges. What
 * the structure delivers is *proof of what was searched*, and that is this
 * panel.
 */
export const ReceiptPanel = ({ receipt }: { readonly receipt: Receipt }) => (
  <div className="panel">
    <h2>Receipt</h2>

    <dl className="kv">
      <dt>threshold</dt>
      <dd>
        convergence ≥ {receipt.convergenceThreshold} — the one tunable in the read path, printed
        in every receipt
      </dd>
      <dt>anchors</dt>
      <dd>
        {receipt.anchorTerms.length} asked, {receipt.anchorsReachingClaims.length} reached a claim
      </dd>
      <dt>paths</dt>
      <dd>
        query 1: {receipt.query1Paths} · query 2: {receipt.query2Paths}
      </dd>
      <dt>idf N</dt>
      <dd>{receipt.totalClaims.toLocaleString("en-US")} claims in this user's memory</dd>
      {receipt.timeRef !== null && (
        <>
          <dt>time ref</dt>
          <dd>{receipt.timeRef}</dd>
        </>
      )}
      <dt>question</dt>
      <dd>
        {receipt.historical ? "historical" : "present-tense"}
        {receipt.wantsCount ? " · wants a count" : ""}
      </dd>
    </dl>

    <div style={{ marginTop: 14 }}>
      <div className="muted" style={{ marginBottom: 5 }}>
        anchors that reached a claim
      </div>
      <div className="chips">
        {receipt.anchorsReachingClaims.map((term) => (
          <span key={term} className="chip hit">
            {term}
          </span>
        ))}
        {receipt.anchorsReachingClaims.length === 0 && (
          <span className="muted">none — this is what A1 means</span>
        )}
      </div>
    </div>

    {receipt.anchorsReachingNothing.length > 0 && (
      <div style={{ marginTop: 10 }}>
        <div className="muted" style={{ marginBottom: 5 }}>
          asked for, reached nothing
        </div>
        <div className="chips">
          {receipt.anchorsReachingNothing.map((term) => (
            <span key={term} className="chip miss">
              {term}
            </span>
          ))}
        </div>
      </div>
    )}

    <div style={{ marginTop: 14 }}>
      <div className="muted" style={{ marginBottom: 5 }}>
        query 1 — anchors to claims, one round trip
      </div>
      <pre className="cypher">{receipt.query1}</pre>
    </div>

    {receipt.query2 !== null && (
      <div style={{ marginTop: 10 }}>
        <div className="muted" style={{ marginBottom: 5 }}>
          query 2 — the candidates' slots, so a replaced value is visible too
        </div>
        <pre className="cypher">{receipt.query2}</pre>
      </div>
    )}

    {receipt.convergence.length > 0 && (
      <div style={{ marginTop: 14 }}>
        <div className="muted" style={{ marginBottom: 5 }}>
          convergence table — how many distinct anchors reached each claim
        </div>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>claim</th>
                <th>conv</th>
                <th>Σ idf</th>
                <th>anchors</th>
              </tr>
            </thead>
            <tbody>
              {receipt.convergence.slice(0, 12).map((row) => (
                <tr key={row.ckey}>
                  <td className="mono">{row.ckey.slice(-8)}</td>
                  <td className="mono">{row.convergence}</td>
                  <td className="mono">{row.score.toFixed(2)}</td>
                  <td className="mono" style={{ whiteSpace: "normal" }}>
                    {row.anchors.join(" ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )}
  </div>
)
