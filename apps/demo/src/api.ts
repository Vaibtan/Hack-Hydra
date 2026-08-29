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
  /** Which read path answered. `v1` is the shipped one. */
  readonly pipeline: "v1" | "v2"
  readonly profile: "full" | "fast"
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
  readonly query1Params: Readonly<Record<string, string | number>>
  readonly query1Paths: number
  readonly query2: string | null
  readonly query2Paths: number
  readonly convergence: ReadonlyArray<ConvergenceRow>
}


/**
 * The v2 plan: what each stage decided, and how long it took.
 *
 * The receipt says what was *read*; this says what was *decided*. Null on v1,
 * which has no plan — the panel renders the receipt alone in that case, because
 * showing the two pipelines side by side is the point of the demo.
 */
export interface PlanArm {
  readonly label: string
  readonly kind: string
  readonly claims: number
  readonly paths: number
  readonly query: string | null
  readonly timedOut: boolean
}

export interface RetrievalPlan {
  readonly route: string
  readonly routeReason: string
  readonly flags: ReadonlyArray<string>
  readonly subQuestions: ReadonlyArray<string>
  readonly probes: ReadonlyArray<string>
  readonly extraTerms: ReadonlyArray<string>
  readonly arms: ReadonlyArray<PlanArm>
  readonly union: { readonly candidates: number; readonly dropped: number }
  readonly timeScope: {
    readonly phrase: string | null
    readonly interval: readonly [number, number] | null
    readonly inScope: number
    readonly outOfScope: number
    readonly applied: boolean
  }
  readonly selection: {
    readonly kept: ReadonlyArray<string>
    readonly dropped: ReadonlyArray<{ readonly id: string; readonly reason: string }>
    readonly reasons: Readonly<Record<string, string>>
    readonly fallback: boolean
  }
  readonly sufficiency: {
    readonly tier: string
    readonly missing: string
    readonly premise: string
    readonly skipped: boolean
    readonly secondPass: boolean
  }
  readonly intervalSentence: string | null
  readonly stages: Readonly<Record<string, number>>
  readonly askMs: number
  readonly graphMs: number
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
  /** Null on v1. */
  readonly plan: RetrievalPlan | null
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

export interface DerivedAssertionSourceSpan {
  readonly sourceDigest: string
  readonly logicalSessionId: string
  readonly sid: string
  readonly turnIdx: number
  readonly offsetStart: number
  readonly offsetEnd: number
  readonly speaker: string
  readonly excerpt: string
  readonly highlight: Highlight
}

/** Model-generated index output paired with its actual verbatim source span. */
export interface DerivedIndexAssertion {
  readonly assertionKey: string
  readonly derivedText: string
  readonly sessionOrd: number
  readonly tEvent: number
  readonly sid: string
  readonly source: DerivedAssertionSourceSpan
  readonly supersededBy: string | null
  readonly atSession: number | null
}

export interface SlotChain {
  readonly skey: string
  readonly asOf: number | null
  readonly assertions: ReadonlyArray<DerivedIndexAssertion>
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
  readonly bookmark?: string
  readonly questionDate?: string
  readonly asOf?: number
  readonly historical?: boolean
  readonly retrieveOnly?: boolean
  readonly premiseCheck?: boolean
  readonly pipeline?: "v1" | "v2"
  readonly profile?: "full" | "fast"
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

  /**
   * Pulls one user's counts so the first real ask is not also the first page
   * fault.
   *
   * HydraDB's object-store cache is cold per user, and the demo's first ask
   * after selecting someone would otherwise pay an 11 s cold convergence walk
   * in front of an audience. `stats` is an indexed read by id off the `User`
   * vertex — cheap on its own, and enough to pull that user's pages in.
   */
  warm: async (uid: string): Promise<void> => {
    try {
      await request(`/users/${encodeURIComponent(uid)}/stats`)
    } catch {
      // Warming is an optimisation. A failure here must not stop the user
      // asking a question -- the ask will report its own error if there is one.
    }
  },

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
