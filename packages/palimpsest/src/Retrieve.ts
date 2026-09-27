import type { Llm } from "@palimpsest/llm"
import { Context, Effect, Layer } from "effect"
import { IngestManifest, type IngestManifestError } from "./IngestManifest.js"
import {
  abstentionReason,
  determinismHash,
  emptySelection,
  planFromArms,
  selectionRow,
  type AskOptions,
  type AskResult
} from "./Plan.js"
import {
  resolveQueryContext,
  type ActiveSnapshotCorrupt,
  type MemoryScopeNotFound,
  type NoActiveSnapshot,
  type QueryContext,
  type QueryPrincipal
} from "./QueryContext.js"
import { applyAsOf, orderEvidence } from "./Scoring.js"
import { applySelection, candidateId, enforceSelection, select } from "./Select.js"
import { SnapshotSearch, type SnapshotReadError } from "./SnapshotArms.js"

/** An ask result bound to the snapshot that produced it; the reader reuses the binding. */
export interface SnapshotAskResult extends AskResult {
  readonly query: QueryContext
}

export type SnapshotAskError =
  | SnapshotReadError
  | NoActiveSnapshot
  | MemoryScopeNotFound
  | ActiveSnapshotCorrupt
  | IngestManifestError

const make = Effect.gen(function* () {
  const manifest = yield* IngestManifest
  const search = yield* SnapshotSearch

  /** Bind one request to its snapshot, then understand, gather, plan, select, label as-of. */
  const ask = (
    principal: QueryPrincipal,
    requestedUid: string,
    question: string,
    options: AskOptions = {}
  ): Effect.Effect<SnapshotAskResult, SnapshotAskError, Llm> =>
    Effect.gen(function* () {
      const query = yield* Effect.provideService(
        resolveQueryContext({
          principal,
          requestedUid,
          ...(options.perspective !== undefined && { perspective: options.perspective }),
          ...(options.asOf !== undefined && { asOf: options.asOf })
        }),
        IngestManifest,
        manifest
      )
      const gathered = yield* search.gather(query, question, options)
      const planned = planFromArms({
        ...gathered,
        temporal: {
          perspective: query.perspective,
          snapshotId: query.snapshot.id,
          coverage: query.coverage,
          stats: gathered.stats,
          upstreamFiltered: gathered.perspectiveFiltered
        }
      })
      const timings = () => ({
        askMs: Date.now() - gathered.askStarted,
        graphMs: gathered.graphMs,
        stages: { ...gathered.clock.stages }
      })

      if (planned.grounded.length === 0) {
        const incomplete =
          planned.plan.temporal !== null && !planned.plan.temporal.completeness.complete
        return {
          verdict: incomplete ? ("INCOMPLETE" as const) : ("ABSENT" as const),
          reason: incomplete ? ("INCOMPLETE_MEMORY" as const) : abstentionReason(planned),
          evidence: [],
          receipt: planned.receipt,
          hash: determinismHash([]),
          timings: timings(),
          plan: { ...planned.plan, protectedKeys: [], selection: emptySelection },
          query
        }
      }

      const candidates = planned.scoped.claims
      const selection =
        gathered.ablations.noSelect === true
          ? {
              ...enforceSelection(candidates, new Set(candidates.map(candidateId))),
              reasons: {},
              cached: true
            }
          : yield* gathered.clock.timed(
              "select",
              select(
                question,
                options.questionDate ?? String(gathered.questionDate),
                gathered.understood.route,
                candidates
              )
            )
      const applied = applySelection(candidates, selection)
      const evidence = orderEvidence(
        applyAsOf(applied.kept, gathered.edges, gathered.asOf),
        gathered.historical
      )

      return {
        verdict: "ANSWER" as const,
        reason: null,
        evidence,
        receipt: planned.receipt,
        hash: determinismHash(evidence.map((claim) => claim.ckey)),
        timings: timings(),
        plan: {
          ...planned.plan,
          protectedKeys: applied.kept
            .filter((candidate) => candidate.kind === "probe")
            .map((candidate) => candidate.ckey),
          selection: selectionRow(applied, selection.reasons)
        },
        query
      }
    })

  return { ask } as const
})

export type Retrieve = Effect.Success<typeof make>
const RetrieveTag = Context.Service<Retrieve>("palimpsest/Retrieve")
export const Retrieve = Object.assign(RetrieveTag, { layer: Layer.effect(RetrieveTag, make) })
