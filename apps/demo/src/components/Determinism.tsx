import { useState } from "react"
import { api } from "../api"

/**
 * The determinism widget.
 *
 * The claim is precise and the widget must not overstate it: **retrieval is
 * deterministic given a fixed graph.** The hash is `sha256` over the sorted
 * claim keys of the evidence set, so N runs of the same question against the
 * same graph produce one hash. *Extraction* is not deterministic — it is an LLM
 * call — and what makes a whole run reproducible is the disk cache, not the
 * graph. Both halves of that are said out loud here.
 */
export const Determinism = ({
  uid,
  question,
  questionDate,
  asOf
}: {
  readonly uid: string
  readonly question: string
  readonly questionDate: string
  readonly asOf: number | undefined
}) => {
  const [hashes, setHashes] = useState<ReadonlyArray<string>>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runs = 8

  const run = async () => {
    setRunning(true)
    setError(null)
    setHashes([])
    const seen: Array<string> = []
    try {
      for (let i = 0; i < runs; i++) {
        // `retrieveOnly` so this measures retrieval, which is the thing that
        // is deterministic — not the reader, which is another model call.
        const result = await api.ask(uid, {
          question,
          questionDate,
          retrieveOnly: true,
          ...(asOf === undefined ? {} : { asOf })
        })
        seen.push(result.hash)
        setHashes([...seen])
      }
    } catch (cause: unknown) {
      setError(String(cause))
    } finally {
      setRunning(false)
    }
  }

  const distinct = new Set(hashes).size

  return (
    <div className="panel">
      <h2>Determinism</h2>
      <div className="row">
        <button onClick={run} disabled={running || question.trim() === ""}>
          {running ? <span className="spinner" /> : null} Ask {runs} times
        </button>
        {hashes.length > 0 && (
          <span className={distinct === 1 ? "chip current" : "chip miss"}>
            {hashes.length} runs · {distinct} distinct hash{distinct === 1 ? "" : "es"}
          </span>
        )}
      </div>

      {error !== null && <p className="error">{error}</p>}

      {hashes.length > 0 && (
        <div className="hashes">
          {hashes.map((hash, index) => (
            <span className="hash" key={index}>
              {hash.slice(0, 16)}
            </span>
          ))}
        </div>
      )}

      <p className="muted" style={{ marginTop: 10 }}>
        The hash is sha256 over the sorted claim keys of the evidence set. Retrieval is
        deterministic <em>given a fixed graph</em> — two bounded MSpaths calls and pure scoring,
        no sampling anywhere. Extraction is not: it is a model call, and what makes a whole
        benchmark run reproducible is the on-disk LLM cache, not the graph.
      </p>
    </div>
  )
}
