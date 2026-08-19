import { useCallback, useEffect, useState } from "react"
import { api, type AskResponse, type SessionRow, type Stats } from "./api"
import { Chain } from "./components/Chain"
import { Determinism } from "./components/Determinism"
import { Evidence } from "./components/Evidence"
import { LiveIngest } from "./components/LiveIngest"
import { ReceiptPanel } from "./components/ReceiptPanel"
import { Scrubber } from "./components/Scrubber"
import { Verdict } from "./components/Verdict"

/**
 * The demo opens on `852ce960` and its knowledge-update question, because that
 * user has a real three-step mortgage chain in `mortgage | price` and the
 * scrubber has something to show from the first frame.
 */
const DEMO_UID = "852ce960"
const DEMO_QUESTION =
  "What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?"
const DEMO_DATE = "2023/12/18 (Mon) 04:17"

/**
 * Questions worth having one keystroke away in a five-minute video: the chain,
 * a false premise the reader has to refuse, and a question about something this
 * user never mentioned at all.
 */
const PRESETS: ReadonlyArray<{ readonly label: string; readonly question: string }> = [
  { label: "knowledge update", question: DEMO_QUESTION },
  { label: "false premise", question: "How many engineers do I manage at Wells Fargo?" },
  { label: "never mentioned", question: "What breed is my Bernese mountain dog?" }
]

export const App = () => {
  const [uid, setUid] = useState(DEMO_UID)
  const [question, setQuestion] = useState(DEMO_QUESTION)
  const [questionDate, setQuestionDate] = useState(DEMO_DATE)
  const [asOf, setAsOf] = useState<number | undefined>(undefined)
  const [premiseCheck, setPremiseCheck] = useState(false)

  const [result, setResult] = useState<AskResponse | null>(null)
  const [sessions, setSessions] = useState<ReadonlyArray<SessionRow>>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadUser = useCallback(async (who: string) => {
    setError(null)
    try {
      const [rows, s] = await Promise.all([api.sessions(who), api.stats(who)])
      setSessions(rows)
      setStats(s)
    } catch (cause: unknown) {
      setSessions([])
      setStats(null)
      setError(String(cause))
    }
  }, [])

  useEffect(() => {
    void loadUser(uid)
  }, [uid, loadUser])

  const ask = useCallback(async () => {
    if (question.trim() === "") return
    setAsking(true)
    setError(null)
    try {
      setResult(
        await api.ask(uid, {
          question,
          questionDate,
          premiseCheck,
          ...(asOf === undefined ? {} : { asOf })
        })
      )
    } catch (cause: unknown) {
      setResult(null)
      setError(String(cause))
    } finally {
      setAsking(false)
    }
  }, [uid, question, questionDate, asOf, premiseCheck])

  // Re-ask when the scrubber moves, so the slider drives the answer directly.
  useEffect(() => {
    if (result !== null) void ask()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf])

  return (
    <div className="app">
      <header className="masthead">
        <h1>Palimpsest</h1>
        <div className="tagline">
          The graph is an index <em>over</em> verbatim transcript, not a replacement for it. Every
          answer points at a span; every abstention shows the query that found nothing.
        </div>
        <div className="who">
          {stats === null
            ? uid
            : `${uid} · ${stats.claims.toLocaleString("en-US")} claims · ${stats.sessions} sessions · ${stats.supersessions} supersessions`}
        </div>
      </header>

      <div className="panel">
        <h2>Ask</h2>
        <div className="row" style={{ marginBottom: 8 }}>
          <input
            type="text"
            value={uid}
            onChange={(event) => setUid(event.target.value.trim())}
            style={{ flex: "0 1 200px" }}
            aria-label="user id"
          />
          <input
            type="text"
            value={questionDate}
            onChange={(event) => setQuestionDate(event.target.value)}
            style={{ flex: "0 1 220px" }}
            aria-label="question date"
          />
        </div>
        <div className="row">
          <input
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void ask()
            }}
            style={{ flex: "1 1 380px" }}
            aria-label="question"
          />
          <button onClick={() => void ask()} disabled={asking}>
            {asking ? <span className="spinner" /> : null} Ask
          </button>
        </div>
        <div className="chips" style={{ marginTop: 8 }}>
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              className="ghost"
              style={{ fontSize: 12, padding: "3px 9px" }}
              onClick={() => setQuestion(preset.question)}
            >
              {preset.label}
            </button>
          ))}
          <label className="chip" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={premiseCheck}
              onChange={(event) => setPremiseCheck(event.target.checked)}
              style={{ width: "auto", marginRight: 5 }}
            />
            premise check
          </label>
        </div>

        {error !== null && <p className="error">{error}</p>}

        {result !== null && (
          <div style={{ marginTop: 14 }}>
            <Verdict result={result} />
          </div>
        )}
      </div>

      {result !== null && (
        <div className="grid">
          <ReceiptPanel receipt={result.receipt} />
          <Evidence spans={result.evidence} cited={result.citedIds} />
        </div>
      )}

      <div className="grid">
        <Scrubber
          uid={uid}
          question={question}
          questionDate={questionDate}
          sessions={sessions}
          asOf={asOf}
          onAsOf={setAsOf}
        />
        <Chain uid={uid} slots={stats?.contested ?? []} asOf={asOf} />
      </div>

      <div className="grid">
        <LiveIngest
          uid={uid}
          onIngested={() => {
            void loadUser(uid)
            void ask()
          }}
        />
        <Determinism uid={uid} question={question} questionDate={questionDate} asOf={asOf} />
      </div>
    </div>
  )
}
