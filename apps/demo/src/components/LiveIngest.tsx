import { useState } from "react"
import { api, type IngestResult } from "../api"


const PLACEHOLDER = `user: I moved again last week — I'm in Lisbon now, not Berlin.
assistant: Lisbon is a big change from Berlin. How are you finding it?
user: Much warmer. The flat is in Alfama and I can walk to work in ten minutes.`

const today = (): string => {
  const now = new Date()
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ` +
    `(${days[now.getDay()]}) ${pad(now.getHours())}:${pad(now.getMinutes())}`
  )
}

export const parseTurns = (
  text: string
): ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }> => {
  const turns: Array<{ role: "user" | "assistant"; content: string }> = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(user|assistant)\s*:\s*(.*)$/i.exec(line)
    if (match !== null) {
      const role = match[1]?.toLowerCase()
      if (role !== "user" && role !== "assistant") continue
      turns.push({
        role,
        content: match[2] ?? ""
      })
    } else if (line.trim() !== "" && turns.length > 0) {
      const last = turns[turns.length - 1]!
      last.content = `${last.content}\n${line}`.trim()
    } else if (line.trim() !== "") {
      turns.push({ role: "user", content: line.trim() })
    }
  }
  return turns.filter((turn) => turn.content !== "")
}

export const LiveIngest = ({
  uid,
  onIngested
}: {
  readonly uid: string
  readonly onIngested: (result: IngestResult) => void
}) => {
  const [text, setText] = useState(PLACEHOLDER)
  const [date, setDate] = useState(today())
  const [state, setState] = useState<"idle" | "writing" | "done">("idle")
  const [result, setResult] = useState<IngestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const turns = parseTurns(text)

  const submit = async () => {
    setState("writing")
    setError(null)
    setResult(null)
    try {
      const ingested = await api.ingestSession(uid, { date, turns })
      setResult(ingested)
      setState("done")
      onIngested(ingested)
    } catch (cause: unknown) {
      setError(String(cause))
      setState("idle")
    }
  }

  return (
    <div className="panel">
      <h2>Live ingest — the same path the benchmark takes</h2>

      <div className="row" style={{ marginBottom: 8 }}>
        <input
          type="text"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          style={{ flex: "1 1 220px" }}
          aria-label="session date"
        />
      </div>

      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        aria-label="session turns"
      />

      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={submit} disabled={state === "writing" || turns.length === 0}>
          {state === "writing" ? <span className="spinner" /> : null} Ingest this session
        </button>
        <span className="muted">
          {turns.length} turn{turns.length === 1 ? "" : "s"} · extraction and supersession run
          server-side
        </span>
      </div>

      {state === "writing" && (
        <p className="muted" style={{ marginTop: 8 }}>
          writing the transcript, extracting claims, reconciling entities, then the supersession
          pass over the slots this session touched…
        </p>
      )}

      {error !== null && <p className="error">{error}</p>}

      {result !== null && (
        <div style={{ marginTop: 12 }}>
          {result.alreadyPresent ? (
            <p className="muted">
              This exact session is already in the graph, so nothing was added — ingest is
              idempotent by session, which is what keeps `df` from inflating on a re-post.
            </p>
          ) : (
            <>
              <div className="chips">
                <span className="chip current">session {result.sessionOrd}</span>
                <span className="chip">{result.claims} claims</span>
                <span className="chip">{result.touchedSlots.length} slots touched</span>
                <span className="chip">{result.supersessions} supersessions</span>
                {result.dropped > 0 && <span className="chip miss">{result.dropped} spans dropped</span>}
              </div>
              <p className="muted" style={{ marginTop: 8 }}>
                Now {result.stats.claims} claims across {result.stats.sessions} sessions. Ask
                again — the client carries this write's causal bookmark to the read, without
                relying on process affinity.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
