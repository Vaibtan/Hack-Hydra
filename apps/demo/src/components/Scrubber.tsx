import { useState } from "react"
import { api, formatDateInt, type SessionRow } from "../api"

export interface TrajectoryStep {
  readonly k: number
  readonly dateInt: number
  readonly label: string
  readonly evidence: number
  readonly changed: boolean
}

/**
 * The as-of scrubber.
 *
 * As-of is **data-level**: `session_ord ≤ k` on claims and `at_session ≤ k` on
 * supersession edges. Two integer comparisons. There is no snapshot, no branch,
 * and no second copy of the graph — HydraDB's bookmarks are causal floors, not
 * time travel, and this could not be built on them.
 *
 * The property that has to be earned is the *first* one: before a fact was ever
 * stated, the memory says so, rather than leaking a value it will only learn
 * later. Running the trajectory is what shows that.
 */
export const Scrubber = ({
  uid,
  question,
  questionDate,
  sessions,
  asOf,
  onAsOf
}: {
  readonly uid: string
  readonly question: string
  readonly questionDate: string
  readonly sessions: ReadonlyArray<SessionRow>
  readonly asOf: number | undefined
  readonly onAsOf: (k: number | undefined) => void
}) => {
  const [trajectory, setTrajectory] = useState<ReadonlyArray<TrajectoryStep>>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const last = sessions.length
  const current = asOf ?? last

  const runTrajectory = async () => {
    setRunning(true)
    setError(null)
    setTrajectory([])
    setProgress(0)
    const steps: Array<TrajectoryStep> = []
    let previous: string | null = null
    try {
      for (let k = 1; k <= last; k++) {
        const result = await api.ask(uid, { question, questionDate, asOf: k })
        const label =
          result.verdict === "ABSENT"
            ? result.reason === "A1_no_anchors"
              ? "ABSENT A1"
              : "ABSENT A2"
            : result.notInMemory
              ? "NOT_IN_MEMORY"
              : (result.answer ?? "")
        steps.push({
          k,
          dateInt: sessions[k - 1]?.dateInt ?? 0,
          label,
          evidence: result.evidence.length,
          changed: label !== previous
        })
        previous = label
        setProgress(k)
        setTrajectory([...steps])
      }
    } catch (cause: unknown) {
      setError(String(cause))
    } finally {
      setRunning(false)
    }
  }

  const changes = trajectory.filter((step) => step.changed)

  return (
    <div className="panel">
      <h2>As-of scrubber — one graph, no snapshots</h2>

      <div className="row" style={{ marginBottom: 8 }}>
        <span className="chip">
          session {current} of {last}
        </span>
        <span className="chip">{formatDateInt(sessions[current - 1]?.dateInt ?? 0)}</span>
        {asOf !== undefined && (
          <button className="ghost" onClick={() => onAsOf(undefined)}>
            back to now
          </button>
        )}
      </div>

      <input
        type="range"
        min={1}
        max={Math.max(1, last)}
        value={current}
        disabled={last === 0}
        onChange={(event) => {
          const k = Number(event.target.value)
          onAsOf(k >= last ? undefined : k)
        }}
      />

      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={runTrajectory} disabled={running || last === 0 || question.trim() === ""}>
          {running ? <span className="spinner" /> : null} Run the whole trajectory
        </button>
        {running && (
          <span className="muted">
            asking as of every session — {progress}/{last}
          </span>
        )}
      </div>

      {error !== null && <p className="error">{error}</p>}

      {trajectory.length > 0 && (
        <>
          <div className="traj">
            {trajectory.map((step) => (
              <span
                key={step.k}
                className={`step${step.changed ? " changed" : ""}`}
                title={`session ${step.k} · ${formatDateInt(step.dateInt)} · ${step.evidence} spans`}
              >
                s{step.k} {step.changed ? step.label : "·"}
              </span>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 10 }}>
            {changes.length} distinct answer{changes.length === 1 ? "" : "s"} across {last}{" "}
            sessions:{" "}
            {changes.map((step) => `s${step.k} → ${step.label}`).join("  ·  ")}
          </p>
        </>
      )}
    </div>
  )
}
