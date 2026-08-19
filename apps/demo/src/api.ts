/**
 * The API, as the demo sees it.
 *
 * Hand-written types rather than a generated client: the demo is a
 * single-purpose app against a five-endpoint API, and a generated client would
 * add a build step to the one part of the project a viewer is most likely to
 * read.
 */

export interface Highlight {
  readonly start: number
  readonly end: number
}

export interface EvidenceSpan {
  readonly ckey: string
  readonly id: string
  readonly sid: string
  readonly sessionOrd: number
  readonly sessionDate: number
  readonly tEvent: number
  readonly speaker: string
  readonly status: "CURRENT" | "SUPERSEDED"
  readonly atSession: number | null
  readonly excerpt: string
  readonly highlight: Highlight
}

export interface ConvergenceRow {
  readonly ckey: string
  readonly convergence: number
  readonly score: number
  readonly anchors: ReadonlyArray<string>
}

export interface Receipt {
  readonly question: string
  readonly uid: string
  readonly asOf: number | null
  readonly anchorTerms: ReadonlyArray<string>
  readonly anchorsReachingClaims: ReadonlyArray<string>
  readonly anchorsReachingNothing: ReadonlyArray<string>
  readonly historical: boolean
  readonly wantsCount: boolean
  readonly timeRef: string | null
  readonly convergenceThreshold: number
  readonly totalClaims: number
  readonly query1: string
  readonly query1Paths: number
  readonly query2: string | null
  readonly query2Paths: number
  readonly convergence: ReadonlyArray<ConvergenceRow>
}

export interface AskResponse {
  readonly verdict: "ANSWER" | "ABSENT"
  readonly reason: string | null
  readonly answer: string | null
  readonly notInMemory: boolean
  readonly reasoning: string
  readonly citedIds: ReadonlyArray<string>
  readonly premiseSupported: boolean | null
  readonly premiseNote: string
  readonly evidence: ReadonlyArray<EvidenceSpan>
  readonly receipt: Receipt
  readonly hash: string
  readonly latencyMs: number
}

export interface SessionRow {
  readonly sid: string
  readonly sessionOrd: number
  readonly dateInt: number
  readonly ts: number
  readonly turns: number
}

export interface ChainClaim {
  readonly ckey: string
  readonly text: string
  readonly sessionOrd: number
  readonly tEvent: number
  readonly sid: string
  readonly supersededBy: string | null
  readonly atSession: number | null
}

export interface SlotChain {
  readonly skey: string
  readonly asOf: number | null
  readonly claims: ReadonlyArray<ChainClaim>
}

export interface ContestedSlot {
  readonly skey: string
  readonly entityName: string
  readonly attr: string
  readonly nClaims: number
}

export interface Stats {
  readonly uid: string
  readonly claims: number
  readonly entities: number
  readonly slots: number
  readonly tokens: number
  readonly sessions: number
  readonly turns: number
  readonly supersessions: number
  readonly contestedSlots: number
  readonly contested: ReadonlyArray<ContestedSlot>
}

export interface IngestResult {
  readonly uid: string
  readonly sid: string
  readonly sessionOrd: number
  readonly claims: number
  readonly dropped: number
  readonly touchedSlots: ReadonlyArray<string>
  readonly supersessions: number
  readonly alreadyPresent: boolean
  readonly bookmark: string | null
  readonly stats: Omit<Stats, "uid" | "contested">
}

export interface AskInput {
  readonly question: string
  readonly questionDate?: string
  readonly asOf?: number
  readonly historical?: boolean
  readonly retrieveOnly?: boolean
  readonly premiseCheck?: boolean
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`)
    this.name = "ApiError"
  }
}

const request = async <A>(path: string, init?: RequestInit): Promise<A> => {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
  })
  if (!response.ok) throw new ApiError(response.status, await response.text())
  return (await response.json()) as A
}

export const api = {
  ask: (uid: string, input: AskInput): Promise<AskResponse> =>
    request(`/users/${encodeURIComponent(uid)}/ask`, {
      method: "POST",
      body: JSON.stringify(input)
    }),

  sessions: (uid: string): Promise<ReadonlyArray<SessionRow>> =>
    request(`/users/${encodeURIComponent(uid)}/sessions`),

  stats: (uid: string): Promise<Stats> => request(`/users/${encodeURIComponent(uid)}/stats`),

  slot: (uid: string, skey: string, asOf?: number): Promise<SlotChain> =>
    request(
      `/users/${encodeURIComponent(uid)}/slots/${encodeURIComponent(skey)}` +
        (asOf === undefined ? "" : `?asOf=${asOf}`)
    ),

  ingestSession: (
    uid: string,
    session: {
      readonly date: string
      readonly turns: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }>
    }
  ): Promise<IngestResult> =>
    request(`/users/${encodeURIComponent(uid)}/sessions`, {
      method: "POST",
      body: JSON.stringify(session)
    })
}

/** `20231130` → `30 Nov 2023`, because a date is read far more often than it is sorted. */
export const formatDateInt = (dateInt: number): string => {
  const text = String(dateInt)
  if (text.length !== 8) return text
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const month = months[Number(text.slice(4, 6)) - 1] ?? "?"
  return `${Number(text.slice(6, 8))} ${month} ${text.slice(0, 4)}`
}
