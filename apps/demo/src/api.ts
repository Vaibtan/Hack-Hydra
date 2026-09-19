import * as S from "@palimpsest/server/api"
import { Schema } from "effect"

export type Highlight = typeof S.Highlight.Type
export type EvidenceSpan = typeof S.EvidenceSpan.Type
export type ConvergenceRow = typeof S.ConvergenceRow.Type
export type Receipt = typeof S.Receipt.Type
export type PlanArm = typeof S.PlanArm.Type
export type RetrievalPlan = typeof S.RetrievalPlan.Type
export type AskResponse = typeof S.AskResponse.Type
export type AskInput = typeof S.AskRequest.Type
export type SessionRow = typeof S.SessionRow.Type
export type DerivedAssertionSourceSpan = typeof S.DerivedAssertionSourceSpan.Type
export type DerivedIndexAssertion = typeof S.DerivedIndexAssertion.Type
export type SlotChain = typeof S.SlotChainResponse.Type
export type Stats = typeof S.StatsResponse.Type
export type ContestedSlot = Stats["contested"][number]
export type WarmResult = typeof S.WarmResponse.Type
export type IngestResult = typeof S.IngestSessionResponse.Type
export type IngestInput = typeof S.IngestSessionRequest.Type

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`)
    this.name = "ApiError"
  }
}

const request = async <Contract extends Schema.Top>(
  contract: Contract,
  path: string,
  init?: RequestInit
): Promise<Schema.Schema.Type<Contract>> => {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  })
  if (!response.ok) throw new ApiError(response.status, await response.text())
  return Schema.decodeUnknownSync(contract)(await response.json())
}

export const api = {
  ask: (uid: string, input: AskInput): Promise<AskResponse> =>
    request(S.AskResponse, `/users/${encodeURIComponent(uid)}/ask`, {
      method: "POST",
      body: JSON.stringify(input)
    }),

  sessions: (uid: string): Promise<ReadonlyArray<SessionRow>> =>
    request(Schema.Array(S.SessionRow), `/users/${encodeURIComponent(uid)}/sessions`),

  /** Reads what the next ask will read; a failure must not stop the user asking. */
  warm: async (uid: string): Promise<WarmResult | null> => {
    try {
      return await request(S.WarmResponse, `/users/${encodeURIComponent(uid)}/warm`, {
        method: "POST"
      })
    } catch {
      return null
    }
  },

  stats: (uid: string): Promise<Stats> =>
    request(S.StatsResponse, `/users/${encodeURIComponent(uid)}/stats`),

  slot: (uid: string, skey: string, asOf?: number): Promise<SlotChain> =>
    request(
      S.SlotChainResponse,
      `/users/${encodeURIComponent(uid)}/slots/${encodeURIComponent(skey)}` +
        (asOf === undefined ? "" : `?asOf=${asOf}`)
    ),

  ingestSession: (uid: string, session: IngestInput): Promise<IngestResult> =>
    request(S.IngestSessionResponse, `/users/${encodeURIComponent(uid)}/sessions`, {
      method: "POST",
      body: JSON.stringify(session)
    })
}

/** `20231130` to `30 Nov 2023`. */
export const formatDateInt = (dateInt: number): string => {
  const text = String(dateInt)
  if (text.length !== 8) return text
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const month = months[Number(text.slice(4, 6)) - 1] ?? "?"
  return `${Number(text.slice(6, 8))} ${month} ${text.slice(0, 4)}`
}
