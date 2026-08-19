import { useEffect, useState } from "react"
import { api, type ContestedSlot, type SlotChain } from "../api"

/**
 * The supersession chain for one slot.
 *
 * "Current" is not a flag anyone sets — it is the *absence* of an outgoing
 * `SUPERSEDED_BY` edge as of session k. So a struck-through claim here is not
 * marked stale in the data; it is stale because an edge points out of it, and
 * moving the as-of slider changes which edges are visible without touching the
 * graph.
 */
export const Chain = ({
  uid,
  slots,
  asOf
}: {
  readonly uid: string
  readonly slots: ReadonlyArray<ContestedSlot>
  readonly asOf: number | undefined
}) => {
  const [skey, setSkey] = useState<string>("")
  const [chain, setChain] = useState<SlotChain | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Default to the slot with the most claims — the one most likely to hold a
  // real chain, which is what the demo opens on.
  useEffect(() => {
    if (slots.length === 0) return
    setSkey((current) =>
      current !== "" && slots.some((slot) => slot.skey === current)
        ? current
        : [...slots].sort((a, b) => b.nClaims - a.nClaims)[0]!.skey
    )
  }, [slots])

  useEffect(() => {
    if (skey === "") return
    let live = true
    setError(null)
    api
      .slot(uid, skey, asOf)
      .then((result) => live && setChain(result))
      .catch((cause: unknown) => live && setError(String(cause)))
    return () => {
      live = false
    }
  }, [uid, skey, asOf])

  if (slots.length === 0) {
    return (
      <div className="panel">
        <h2>Supersession chain</h2>
        <p className="muted">No slot in this history holds two claims yet.</p>
      </div>
    )
  }

  return (
    <div className="panel">
      <h2>Supersession chain{asOf === undefined ? "" : ` — as of session ${asOf}`}</h2>
      <select value={skey} onChange={(event) => setSkey(event.target.value)}>
        {[...slots]
          .sort((a, b) => b.nClaims - a.nClaims)
          .map((slot) => (
            <option key={slot.skey} value={slot.skey}>
              {slot.entityName} | {slot.attr} ({slot.nClaims} claims)
            </option>
          ))}
      </select>

      {error !== null && <p className="error">{error}</p>}

      <div style={{ marginTop: 12 }}>
        {chain?.claims.map((claim) => (
          <div
            className={`chain-item${claim.supersededBy !== null ? " is-superseded" : ""}`}
            key={claim.ckey}
          >
            <div className="ord">s{claim.sessionOrd}</div>
            <div className="body">
              <div className="claim">{claim.text}</div>
              <div className="chips">
                <span className={`chip ${claim.supersededBy === null ? "current" : "superseded"}`}>
                  {claim.supersededBy === null
                    ? "CURRENT"
                    : `SUPERSEDED @ s${claim.atSession ?? "?"}`}
                </span>
              </div>
            </div>
          </div>
        ))}
        {chain !== null && chain.claims.length === 0 && (
          <p className="muted">Nothing filled this slot yet at this point in the history.</p>
        )}
      </div>
    </div>
  )
}
