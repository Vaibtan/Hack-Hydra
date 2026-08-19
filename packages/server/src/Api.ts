import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"

/**
 * The HTTP surface, defined once as schemas so the demo and the smoke script
 * share the *types* with the server rather than re-declaring them.
 *
 * The shapes here are deliberately the library's own vocabulary — verdict,
 * receipt, span, chain — because the demo's whole job is to show those. An API
 * that flattened a receipt into a "score" would make the thing being
 * demonstrated unshowable.
 */

// ---- errors -----------------------------------------------------------------

/**
 * The graph is unreachable, over its limits, or refused the statement. Surfaced
 * with the engine's own reason text, which is precise and worth propagating.
 */
export class GraphError extends Schema.TaggedError<GraphError>()(
  "GraphError",
  { reason: Schema.String },
  HttpApiSchema.annotations({ status: 503 })
) {}

/** No such user, session or slot. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { what: Schema.String, key: Schema.String },
  HttpApiSchema.annotations({ status: 404 })
) {}

/** The request was well-formed but asks for something impossible. */
export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { reason: Schema.String },
  HttpApiSchema.annotations({ status: 400 })
) {}

// ---- shared shapes ----------------------------------------------------------

export const Highlight = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number
})

/**
 * One piece of evidence: verbatim turn text with the Span located inside it.
 * The reader never sees a Claim's text and neither does the UI — `excerpt` is
 * the transcript, and `highlight` says which characters the graph pointed at.
 */
export const EvidenceSpan = Schema.Struct({
  ckey: Schema.String,
  id: Schema.String,
  sid: Schema.String,
  sessionOrd: Schema.Number,
  sessionDate: Schema.Number,
  tEvent: Schema.Number,
  speaker: Schema.String,
  status: Schema.Literal("CURRENT", "SUPERSEDED"),
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

/** Everything a judge needs to re-run the read by hand and get the same paths. */
export const Receipt = Schema.Struct({
  question: Schema.String,
  uid: Schema.String,
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
  query1Paths: Schema.Number,
  query2: Schema.NullOr(Schema.String),
  query2Paths: Schema.Number,
  convergence: Schema.Array(ConvergenceRow)
})

export const AskRequest = Schema.Struct({
  question: Schema.String,
  /** The question's own date, as the dataset writes it. Used for date arithmetic. */
  questionDate: Schema.optional(Schema.String),
  /** Read the memory as it stood at session `k`. */
  asOf: Schema.optional(Schema.Number),
  historical: Schema.optional(Schema.Boolean),
  /** Skip the reader and return the structural verdict and evidence only. */
  retrieveOnly: Schema.optional(Schema.Boolean),
  premiseCheck: Schema.optional(Schema.Boolean)
})

export const AskResponse = Schema.Struct({
  verdict: Schema.Literal("ANSWER", "ABSENT"),
  /** `A1_no_anchors` / `A2_no_convergence`, or null when the verdict is ANSWER. */
  reason: Schema.NullOr(Schema.String),
  answer: Schema.NullOr(Schema.String),
  /** The reader declined — the third abstention line, distinct from A1/A2. */
  notInMemory: Schema.Boolean,
  reasoning: Schema.String,
  citedIds: Schema.Array(Schema.String),
  premiseSupported: Schema.NullOr(Schema.Boolean),
  premiseNote: Schema.String,
  evidence: Schema.Array(EvidenceSpan),
  receipt: Receipt,
  /** sha256 over the sorted evidence keys. Same graph, same question, same hash. */
  hash: Schema.String,
  latencyMs: Schema.Number
})

// ---- ingest -----------------------------------------------------------------

export const IngestTurn = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
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
  /** True when this exact session was already in the graph and nothing was added. */
  alreadyPresent: Schema.Boolean,
  /** HydraDB's causal token. Read-your-writes is threaded inside the server, but
   *  the caller gets it so it can prove the ask that follows saw this write. */
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

// ---- reads ------------------------------------------------------------------

export const SessionRow = Schema.Struct({
  sid: Schema.String,
  sessionOrd: Schema.Number,
  dateInt: Schema.Number,
  ts: Schema.Number,
  turns: Schema.Number
})

export const ChainClaimRow = Schema.Struct({
  ckey: Schema.String,
  text: Schema.String,
  sessionOrd: Schema.Number,
  tEvent: Schema.Number,
  sid: Schema.String,
  /** Null when this claim is CURRENT as of the requested session. */
  supersededBy: Schema.NullOr(Schema.String),
  atSession: Schema.NullOr(Schema.Number)
})

export const SlotChainResponse = Schema.Struct({
  skey: Schema.String,
  asOf: Schema.NullOr(Schema.Number),
  claims: Schema.Array(ChainClaimRow)
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
  /** Slots holding ≥ 2 claims — the ones a supersession chain can exist in. */
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

/**
 * `asOf` arrives as a query string, so it is a string schema that parses to a
 * number rather than `Schema.Number`, which would reject `"4"`.
 */
const AsOfQuery = Schema.Struct({
  asOf: Schema.optional(Schema.NumberFromString)
})

export const users = HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.post("ingestSession", "/users/:uid/sessions")
      .setPath(UidPath)
      .setPayload(IngestSessionRequest)
      .addSuccess(IngestSessionResponse)
      .addError(GraphError)
      .addError(BadRequest)
  )
  .add(
    HttpApiEndpoint.post("ask", "/users/:uid/ask")
      .setPath(UidPath)
      .setPayload(AskRequest)
      .addSuccess(AskResponse)
      .addError(GraphError)
      .addError(NotFound)
  )
  .add(
    HttpApiEndpoint.get("sessions", "/users/:uid/sessions")
      .setPath(UidPath)
      .addSuccess(Schema.Array(SessionRow))
      .addError(GraphError)
  )
  .add(
    HttpApiEndpoint.get("slot", "/users/:uid/slots/:skey")
      .setPath(SlotPath)
      .setUrlParams(AsOfQuery)
      .addSuccess(SlotChainResponse)
      .addError(GraphError)
      .addError(NotFound)
  )
  .add(
    HttpApiEndpoint.get("stats", "/users/:uid/stats")
      .setPath(UidPath)
      .addSuccess(StatsResponse)
      .addError(GraphError)
      .addError(NotFound)
  )

export class PalimpsestApi extends HttpApi.make("palimpsest").add(users) {}
