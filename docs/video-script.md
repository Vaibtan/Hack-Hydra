# Palimpsest — demo video script

Target **under 5 minutes**. One take, no cuts needed. Everything below is real and reproducible;
nothing is staged.

## Before recording

```powershell
docker start hydradb          # from PowerShell, never Git Bash
```

```bash
pnpm serve                    # API on :8787
pnpm demo                     # UI on http://localhost:5173
```

**Warm the node first.** HydraDB faults a traversal into its page cache on first touch, so the very
first ask against a user costs ~10–15 s and every one after it ~0.1–2 s. Before recording, ask the
mortgage question once and run one trajectory. It is the engine's cache, not the read path, and it
is not worth explaining on camera.

Have `852ce960` loaded, question set to the knowledge-update preset, and the browser at a width
where the two-column grid is visible.

---

## 0:00 — 0:25 · The thesis

> Most memory layers extract facts and then answer from the extraction. That makes the system a
> summary of a summary — and when it is wrong, there is nothing to check.
>
> Palimpsest stores the transcript verbatim in HydraDB and builds a graph that *indexes* it. Every
> claim points at a character span in a real turn. The reader never sees a claim's text — it sees
> the transcript.

Point at the masthead: **3 113 claims · 39 sessions · 5 supersessions** for this one user.

## 0:25 — 1:10 · Ask, and the receipt

Click **Ask** on the loaded question:

> *"What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?"*

Answer lands: **$400,000**.

> Two things to look at. On the right, the evidence is verbatim transcript with the span the graph
> pointed at marked in yellow — that is what the reader read.
>
> On the left is the receipt, and this is the part I actually care about. That is the exact
> `algo.MSpaths` statement that ran. Thirteen of the fifteen anchors reached a claim; the two that
> reached nothing are struck through. 287 paths on query 1, 25 on query 2. And the convergence
> table: relevance here is how many *distinct* question anchors reach the same claim — a structural
> score, so it can be shown rather than asserted.

## 1:10 — 1:50 · Absence, told apart

Click the **never mentioned** preset — *"What breed is my Bernese mountain dog?"*

> **ABSENT, A2.** Three of seven anchors resolve, nothing converges, zero spans. The receipt is the
> proof: this is the query that was run and this is what it reached.

Click the **false premise** preset — *"How many engineers do I manage at Wells Fargo?"*

> Different colour, different claim. Retrieval reached 65 spans — this user really does talk about
> engineers and about Wells Fargo — but the reader read them and refused, because he is a senior
> engineer who never became a manager.
>
> Those are two different failures and the system says which is which: nothing was reachable, versus
> the right text was reached and did not contain it. **Be honest about this** — on a well-populated
> graph the structural verdict rarely fires. What the structure buys is proof of what was searched.
> Abstention itself lands on the reader.

## 1:50 — 2:50 · The scrubber

Back to the knowledge-update question. Click **Run the whole trajectory**.

> The same question, asked as of every session in turn. Watch the answer move.
>
> **NOT_IN_MEMORY** through sessions 1 and 2 — before he ever said it, the memory says so, instead
> of leaking a value it will only learn later. At session 3 it becomes **$350,000**. It holds there
> for thirty-four sessions. At session 37 it becomes **$400,000**.
>
> There is no snapshot here, no branch, no second copy of the graph. As-of is two integer
> comparisons: `session_ord ≤ k` on claims, `at_session ≤ k` on supersession edges. HydraDB's
> bookmarks are causal floors — they cannot do this, and this does not need them.

Drag the slider back to session 4 and point at the chain panel.

> And "current" is not a flag anyone sets. It is the *absence* of an outgoing `SUPERSEDED_BY` edge
> as of session k. Move the slider and the struck-through claim changes, because a different set of
> edges is visible — the graph itself never changed.

## 2:50 — 3:50 · Live ingest

Scroll to the live-ingest panel. The textarea is pre-filled with a short session; edit the city if
you like.

> This is not a different code path. A session typed here gets written verbatim, extracted with one
> LLM call, reconciled against the entities this user already has, and then the supersession pass
> runs over the slots it touched.

Click **Ingest this session**, narrate while it runs (a few seconds):

> New claims, new slots touched, and — there — a supersession, because he already had a residence
> and now he has a different one.

Ask *"Where do I live?"*

> The answer sees the session written seconds ago, with no delay and no retry. One HydraDB client
> holds the bookmark from the write and replays it into the next read, so ingest-then-ask is
> read-your-writes.

## 3:50 — 4:20 · Determinism

Click **Ask 8 times** in the determinism panel.

> Eight runs, one hash. The hash is sha256 over the sorted claim keys of the evidence set, so this
> says retrieval is deterministic **given a fixed graph** — two bounded MSpaths calls and pure
> scoring, no sampling.
>
> Extraction is *not* deterministic; it is a model call. What makes a whole benchmark run
> reproducible is the on-disk cache, not the graph. Both halves of that are in the writeup.

## 4:20 — 4:50 · The numbers

Cut to `results/table-100.md` (or the terminal).

> On a 100-question slice of LongMemEval_S — real haystacks, forty-odd distractor sessions each,
> all thirty unanswerable questions included — scored by the official LongMemEval judge, against
> BM25 top-10 turns and full-context over the whole haystack, same reader prompt and same judge for
> all three.

Read the accuracy, the abstention column, and the reader-token column.

> The reader-token column is the one to look at next to accuracy. Full context sends the whole
> haystack; this sends the spans that converged.

## 4:50 — 5:00 · Close

> The graph is an index over the transcript. Every answer points at a span, every abstention shows
> the query that found nothing, and as-of is a filter rather than a snapshot. Repo and writeup are
> linked below.

---

## Things to have ready but not show

- `pnpm smoke` passing 15/15, in case a reviewer asks whether the API is real.
- `docs/run-log.md`, if anyone asks what the benchmark cost.
- The engine-limit table in `CONTEXT.md` — the 1024-row wall, the label-scan finding, the
  `pathCount` trap, the writer-lease and request-id faults. It is the most interesting page in the
  repo and the wrong thing to spend video seconds on.

## If something goes wrong on camera

- **First ask is slow** → the node's page cache is cold. Keep talking; it lands.
- **`GraphError 503`** → HydraDB is down. `docker start hydradb`.
- **Every write 503s** → the node was killed mid-write and cannot reclaim its writer lease. Stop it,
  move `_writer_leases/v2/cell-0` aside, start it. See `docs/run-log.md`.
