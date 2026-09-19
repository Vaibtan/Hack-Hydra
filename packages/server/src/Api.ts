import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"

/** The graph is unreachable, over its limits, or refused the statement. */
export class GraphError extends Schema.TaggedError<GraphError>()(
  "GraphError",
  { reason: Schema.String },
  { httpApiStatus: 503 }
) {}

/** No such user, session or slot. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { what: Schema.String, key: Schema.String },
  { httpApiStatus: 404 }
) {}

export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { reason: Schema.String },
  { httpApiStatus: 400 }
) {}

export const Highlight = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number
})

/** Verbatim turn text with the Span located inside it; never a Claim's text. */
export const EvidenceSpan = Schema.Struct({
  ckey: Schema.String,
  id: Schema.String,
  sid: Schema.String,
  sessionOrd: Schema.Number,
  sessionDate: Schema.Number,
  tEvent: Schema.Number,
  speaker: Schema.String,
  status: Schema.Literals(["CURRENT", "SUPERSEDED"]),
  atSession: Schema.NullOr(Schema.Number),
  excerpt: Schema.String,
  highlight: Highlight
})

export const ConvergenceRow = Schema.Struct({
  ckey: Schema.String,
  convergence: Schema.Number,
  score: Schema.Number,
  anchors: Schema.Array(Schema.String)
})

export const QueryParameters = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number])
)

/** A replayable decision trace; it is not a completeness or integrity proof. */
export const Receipt = Schema.Struct({
  question: Schema.String,
  uid: Schema.String,
  profile: Schema.Literals(["full", "fast"]),
  asOf: Schema.NullOr(Schema.Number),
  anchorTerms: Schema.Array(Schema.String),
  anchorsReachingClaims: Schema.Array(Schema.String),
  anchorsReachingNothing: Schema.Array(Schema.String),
  historical: Schema.Boolean,
  wantsCount: Schema.Boolean,
  timeRef: Schema.NullOr(Schema.String),
  convergenceThreshold: Schema.Number,
  totalClaims: Schema.Number,
  query1: Schema.String,
  query1Params: QueryParameters,
  query1Paths: Schema.Number,
  query2: Schema.NullOr(Schema.String),
  query2Paths: Schema.Number,
  models: Schema.Struct({
    reader: Schema.String,
    select: Schema.String,
    sufficiency: Schema.String
  }),
  convergence: Schema.Array(ConvergenceRow)
})

export const ArmKind = Schema.Literals(["probe", "subQuestion", "convergence", "discovery", "slotMate"])

export const PlanArm = Schema.Struct({
  label: Schema.String,
  kind: ArmKind,
  claims: Schema.Number,
  paths: Schema.Number,
  query: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean
})

export const PlanTimeScope = Schema.Struct({
  phrase: Schema.NullOr(Schema.String),
  interval: Schema.NullOr(Schema.Tuple([Schema.Number, Schema.Number])),
  inScope: Schema.Number,
  outOfScope: Schema.Number,
  applied: Schema.Boolean
})

export const PlanSelection = Schema.Struct({
  kept: Schema.Array(Schema.String),
  dropped: Schema.Array(
    Schema.Struct({ id: Schema.String, reason: Schema.Literals(["selector", "turn_cap"]) })
  ),
  reasons: Schema.Record(Schema.String, Schema.String),
  fallback: Schema.Boolean
})

export const PlanSufficiency = Schema.Struct({
  /** `skipped` when the check never ran. */
  tier: Schema.Literals(["EXACT", "INFERRABLE", "PARTIAL", "skipped"]),
  missing: Schema.String,
  premise: Schema.String,
  /** Excerpt ids the check cited that are in the pack and CURRENT. */
  premiseContradictedBy: Schema.Array(Schema.String),
  secondPass: Schema.Boolean
})

export const PlanBudget = Schema.Struct({
  budget: Schema.Number,
  estimatedTokens: Schema.Number,
  charsPerToken: Schema.Number,
  dropped: Schema.Array(
    Schema.Struct({ id: Schema.String, reason: Schema.Literal("budget"), chars: Schema.Number })
  ),
  overBudget: Schema.Boolean
})

export const Route = Schema.Literals([
  "fact",
  "preference",
  "assistant_output",
  "update",
  "count",
  "temporal",
  "multi_fact"
])

export const RetrievalPlan = Schema.Struct({
  route: Route,
  routeReason: Schema.String,
  flags: Schema.Array(Schema.String),
  subQuestions: Schema.Array(Schema.String),
  probes: Schema.Array(Schema.String),
  extraTerms: Schema.Array(Schema.String),
  arms: Schema.Array(PlanArm),
  union: Schema.Struct({ candidates: Schema.Number, dropped: Schema.Number }),
  timeScope: PlanTimeScope,
  selection: PlanSelection,
  sufficiency: PlanSufficiency,
  budget: PlanBudget,
  intervalSentence: Schema.NullOr(Schema.String),
  stages: Schema.Record(Schema.String, Schema.Number),
  askMs: Schema.Number,
  /** The HydraDB stages alone. */
  graphMs: Schema.Number
})

export const AskRequest = Schema.Struct({
  question: Schema.String,
  /** Opaque causal floor returned by a prior ingest; absent means no read-your-writes guarantee. */
  bookmark: Schema.optional(Schema.String),
  /** The question's own date, as the dataset writes it. Used for date arithmetic. */
  questionDate: Schema.optional(Schema.String),
  /** Read the memory as it stood at session `k`. */
  asOf: Schema.optional(Schema.Number),
  historical: Schema.optional(Schema.Boolean),
  /** Skip the pack and the reader: the retrieval verdict, plan and hydrated evidence only. */
  retrieveOnly: Schema.optional(Schema.Boolean),
  /** `fast` drops the sufficiency check and its second pass. Defaults to `fast`. */
  profile: Schema.optional(Schema.Literals(["full", "fast"]))
})

export const AbstentionReason = Schema.Literals([
  "A1_no_anchors",
  "A2_no_convergence",
  "INSUFFICIENT_EVIDENCE",
  "CONTRADICTED_PREMISE"
])

export const AskResponse = Schema.Struct({
  verdict: Schema.Literals(["ANSWER", "ABSENT"]),
  reason: Schema.NullOr(AbstentionReason),
  answer: Schema.NullOr(Schema.String),
  /** The reader declined: distinct from a structural ABSENT. */
  notInMemory: Schema.Boolean,
  reasoning: Schema.String,
  citedIds: Schema.Array(Schema.String),
  evidence: Schema.Array(EvidenceSpan),
  receipt: Receipt,
  plan: RetrievalPlan,
  /** The read's span hash when there was a read, else sha256 over the sorted evidence keys. */
  hash: Schema.String,
  latencyMs: Schema.Number
})

export const IngestTurn = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String
})

export const IngestSessionRequest = Schema.Struct({
  /** The session's own id. Defaults to a content hash when omitted. */
  sid: Schema.optional(Schema.String),
  /** `2023/04/10 (Mon) 17:50`, the only timestamp format the dataset uses. */
  date: Schema.String,
  turns: Schema.Array(IngestTurn)
})

export const IngestSessionResponse = Schema.Struct({
  uid: Schema.String,
  sid: Schema.String,
  sessionOrd: Schema.Number,
  claims: Schema.Number,
  dropped: Schema.Number,
  touchedSlots: Schema.Array(Schema.String),
  supersessions: Schema.Number,
  alreadyPresent: Schema.Boolean,
  /** HydraDB's opaque causal token; send it on a later ask to require this write. */
  bookmark: Schema.NullOr(Schema.String),
  stats: Schema.Struct({
    claims: Schema.Number,
    entities: Schema.Number,
    slots: Schema.Number,
    tokens: Schema.Number,
    sessions: Schema.Number,
    turns: Schema.Number,
    supersessions: Schema.Number,
    contestedSlots: Schema.Number
  })
})

/** `queryVisible` stays false: indexing alone never selects a retrieval generation. */
export const SourceIndexSessionResponse = Schema.Struct({
  uid: Schema.String,
  sid: Schema.String,
  commitId: Schema.String,
  sourceDigest: Schema.String,
  extractionGeneration: Schema.String,
  indexGeneration: Schema.String,
  state: Schema.Literals(["INDEXED", "ENRICHED", "CONSOLIDATED", "COMMITTED"]),
  alreadyAtTarget: Schema.Boolean,
  queryVisible: Schema.Literal(false)
})

export const SessionRow = Schema.Struct({
  sid: Schema.String,
  sessionOrd: Schema.Number,
  dateInt: Schema.Number,
  ts: Schema.Number,
  turns: Schema.Number
})

export const DerivedAssertionSourceSpan = Schema.Struct({
  sourceDigest: Schema.String,
  logicalSessionId: Schema.String,
  sid: Schema.String,
  turnIdx: Schema.Number,
  offsetStart: Schema.Number,
  offsetEnd: Schema.Number,
  speaker: Schema.String,
  excerpt: Schema.String,
  highlight: Highlight
})

/** A model-generated index assertion with the verbatim span it was derived from; not evidence. */
export const DerivedIndexAssertion = Schema.Struct({
  assertionKey: Schema.String,
  derivedText: Schema.String,
  sessionOrd: Schema.Number,
  tEvent: Schema.Number,
  sid: Schema.String,
  source: DerivedAssertionSourceSpan,
  /** Null when this claim is CURRENT as of the requested session. */
  supersededBy: Schema.NullOr(Schema.String),
  atSession: Schema.NullOr(Schema.Number)
})

export const SlotChainResponse = Schema.Struct({
  skey: Schema.String,
  asOf: Schema.NullOr(Schema.Number),
  assertions: Schema.Array(DerivedIndexAssertion)
})

export const StatsResponse = Schema.Struct({
  uid: Schema.String,
  claims: Schema.Number,
  entities: Schema.Number,
  slots: Schema.Number,
  tokens: Schema.Number,
  sessions: Schema.Number,
  turns: Schema.Number,
  supersessions: Schema.Number,
  contestedSlots: Schema.Number,
  contested: Schema.Array(
    Schema.Struct({
      skey: Schema.String,
      entityName: Schema.String,
      attr: Schema.String,
      nClaims: Schema.Number
    })
  )
})

const UidPath = Schema.Struct({ uid: Schema.String })
const SlotPath = Schema.Struct({ uid: Schema.String, skey: Schema.String })

const AsOfQuery = Schema.Struct({
  asOf: Schema.optional(Schema.NumberFromString)
})

/** What a warm reached, so a warm that touched nothing is visible. */
export const WarmResponse = Schema.Struct({
  uid: Schema.String,
  entities: Schema.Number,
  slots: Schema.Number,
  sessions: Schema.Number,
  tokens: Schema.Number,
  slotClaims: Schema.Number,
  turns: Schema.Number,
  failed: Schema.Number,
  truncated: Schema.Boolean,
  ms: Schema.Number
})

export const users = HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.post("ingestSession", "/users/:uid/sessions", {
      params: UidPath,
      payload: IngestSessionRequest,
      success: IngestSessionResponse,
      error: [GraphError, BadRequest]
    })
  )
  .add(
    HttpApiEndpoint.post("sourceIndexSession", "/users/:uid/source-index", {
      params: UidPath,
      payload: IngestSessionRequest,
      success: SourceIndexSessionResponse,
      error: [GraphError, BadRequest]
    })
  )
  .add(
    HttpApiEndpoint.post("ask", "/users/:uid/ask", {
      params: UidPath,
      payload: AskRequest,
      success: AskResponse,
      error: [GraphError, NotFound]
    })
  )
  .add(
    HttpApiEndpoint.get("sessions", "/users/:uid/sessions", {
      params: UidPath,
      success: Schema.Array(SessionRow),
      error: GraphError
    })
  )
  .add(
    HttpApiEndpoint.get("slot", "/users/:uid/slots/:skey", {
      params: SlotPath,
      query: AsOfQuery,
      success: SlotChainResponse,
      error: [GraphError, NotFound]
    })
  )
  .add(
    HttpApiEndpoint.get("stats", "/users/:uid/stats", {
      params: UidPath,
      success: StatsResponse,
      error: [GraphError, NotFound]
    })
  )
  .add(
    HttpApiEndpoint.post("warm", "/users/:uid/warm", {
      params: UidPath,
      success: WarmResponse,
      error: [GraphError, NotFound]
    })
  )

export class PalimpsestApi extends HttpApi.make("palimpsest").add(users) {}
