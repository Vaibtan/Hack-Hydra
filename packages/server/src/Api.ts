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

/** Serializable scalar parameters for the Hydra-specific diagnostic rendering. */
export const QueryParameters = Schema.Record({
  key: Schema.String,
  value: Schema.Union(Schema.String, Schema.Number)
})

/** A replayable decision trace; it is not a completeness or integrity proof. */
export const Receipt = Schema.Struct({
  question: Schema.String,
  uid: Schema.String,
  /** Which read path answered: the shipped `v1`, or the `v2` retrieval plan. */
  pipeline: Schema.Literal("v1", "v2"),
  profile: Schema.Literal("full", "fast"),
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
  /**
   * The read path's three model ids. `pipeline` says which were called: v1 uses
   * `reader` alone, v2 uses all three.
   */
  models: Schema.Struct({
    reader: Schema.String,
    select: Schema.String,
    sufficiency: Schema.String
  }),
  convergence: Schema.Array(ConvergenceRow)
})


/**
 * The v2 plan, as the demo renders it: route -> arms -> scope -> select ->
 * sufficiency -> read, each with what it decided.
 *
 * Null on v1, which has no plan. The panel therefore has to handle its absence
 * rather than assuming it — a demo that only works on v2 would quietly stop
 * being able to show the comparison the whole talk is about.
 */
export const PlanArm = Schema.Struct({
  label: Schema.String,
  kind: Schema.String,
  claims: Schema.Number,
  paths: Schema.Number,
  query: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean
})

export const PlanTimeScope = Schema.Struct({
  phrase: Schema.NullOr(Schema.String),
  interval: Schema.NullOr(Schema.Tuple(Schema.Number, Schema.Number)),
  inScope: Schema.Number,
  outOfScope: Schema.Number,
  applied: Schema.Boolean
})

export const PlanSelection = Schema.Struct({
  kept: Schema.Array(Schema.String),
  dropped: Schema.Array(Schema.Struct({ id: Schema.String, reason: Schema.String })),
  reasons: Schema.Record({ key: Schema.String, value: Schema.String }),
  fallback: Schema.Boolean
})

export const PlanSufficiency = Schema.Struct({
  /** `EXACT` / `INFERRABLE` / `PARTIAL`, or `skipped` when the call never ran. */
  tier: Schema.String,
  missing: Schema.String,
  premise: Schema.String,
  /** Excerpt ids the check cited, after the CURRENT-and-in-pack verification. */
  premiseContradictedBy: Schema.Array(Schema.String),
  secondPass: Schema.Boolean
})

/**
 * What the token budget cost. Ids and reasons, not a count: a count says how
 * many excerpts went and not which, or why.
 */
export const PlanBudget = Schema.Struct({
  budget: Schema.Number,
  estimatedTokens: Schema.Number,
  charsPerToken: Schema.Number,
  dropped: Schema.Array(
    Schema.Struct({ id: Schema.String, reason: Schema.String, chars: Schema.Number })
  ),
  overBudget: Schema.Boolean
})

export const RetrievalPlan = Schema.Struct({
  route: Schema.String,
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
  /** Null when the ask abstained before anything was packed. */
  budget: Schema.NullOr(PlanBudget),
  intervalSentence: Schema.NullOr(Schema.String),
  /** Per-stage wall time. Concurrent stages overlap, so these do not sum. */
  stages: Schema.Record({ key: Schema.String, value: Schema.Number }),
  askMs: Schema.Number,
  /** The HydraDB stages alone, so the index has an honest number of its own. */
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
  /** Skip the reader and return the structural verdict and evidence only. */
  retrieveOnly: Schema.optional(Schema.Boolean),
  premiseCheck: Schema.optional(Schema.Boolean),
  /** `v1` is the shipped path; `v2` is the retrieval plan. Defaults to `v1`. */
  pipeline: Schema.optional(Schema.Literal("v1", "v2")),
  /** `fast` drops the sufficiency check and its second pass. Defaults to `full`. */
  profile: Schema.optional(Schema.Literal("full", "fast"))
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
  /** The v2 plan, or null on v1 — which has no plan to show. */
  plan: Schema.NullOr(RetrievalPlan),
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
  /** HydraDB's opaque causal token. Send it on a later ask to require this write. */
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

/**
 * Result of the new bounded source/index path. `queryVisible` remains false:
 * indexing alone never selects a retrieval generation or claims terminal
 * ingest success.
 */
export const SourceIndexSessionResponse = Schema.Struct({
  uid: Schema.String,
  sid: Schema.String,
  commitId: Schema.String,
  sourceDigest: Schema.String,
  extractionGeneration: Schema.String,
  indexGeneration: Schema.String,
  state: Schema.Literal("INDEXED", "ENRICHED", "CONSOLIDATED", "COMMITTED"),
  alreadyAtTarget: Schema.Boolean,
  queryVisible: Schema.Literal(false)
})

// ---- reads ------------------------------------------------------------------

export const SessionRow = Schema.Struct({
  sid: Schema.String,
  sessionOrd: Schema.Number,
  dateInt: Schema.Number,
  ts: Schema.Number,
  turns: Schema.Number
})

/** The exact verbatim transcript slice that a derived assertion points to. */
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

/**
 * A model-generated index assertion, deliberately distinct from evidence.
 * Its `source` is the verbatim transcript span the assertion was derived from.
 */
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

/**
 * What a warm actually touched.
 *
 * Counts rather than a bare 204 because a warm that silently reached nothing is
 * indistinguishable from one that worked, and the whole reason this endpoint
 * exists is that the previous warm — a by-id read of the `User` vertex — did not
 * touch the blocks the cold ask pays for.
 */
export const WarmResponse = Schema.Struct({
  uid: Schema.String,
  entities: Schema.Number,
  slots: Schema.Number,
  sessions: Schema.Number,
  /** Reached backwards along `NAMES` from the entities; there is no User->Token edge. */
  tokens: Schema.Number,
  /** Claims reached through `FILLS` from the slots — the shape of Query 2. */
  slotClaims: Schema.Number,
  turns: Schema.Number,
  /** Walks that failed. A warm that reached nothing must not look like success. */
  failed: Schema.Number,
  /** The budget ran out before every walk was made. */
  truncated: Schema.Boolean,
  ms: Schema.Number
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
    HttpApiEndpoint.post("sourceIndexSession", "/users/:uid/source-index")
      .setPath(UidPath)
      .setPayload(IngestSessionRequest)
      .addSuccess(SourceIndexSessionResponse)
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
  /**
   * Reads the blocks the next ask will read, so the first question after
   * selecting a user is not the one that pays for them.
   *
   * `POST` rather than `GET` because it is an instruction and not a resource:
   * nothing is returned that a caller wants for its own sake, and a `GET` would
   * invite a cache in front of it.
   */
  .add(
    HttpApiEndpoint.post("warm", "/users/:uid/warm")
      .setPath(UidPath)
      .addSuccess(WarmResponse)
      .addError(GraphError)
      .addError(NotFound)
  )

export class PalimpsestApi extends HttpApi.make("palimpsest").add(users) {}
