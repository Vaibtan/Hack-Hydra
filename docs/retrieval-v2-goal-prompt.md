# Goal prompt for the Retrieval v2 implementation session

Paste everything below the line into a fresh Claude Code session (Opus 5) in this repo.

---

Implement **Retrieval v2** for Palimpsest. The spec is `docs/spec-retrieval-v2.md` (revision 2, 2026-08-29) and is mirrored as GitHub issue #22; the research behind it is `docs/research-retrieval-accuracy-2026-08-29.md`. The work is broken into ten sub-issues of #22 with native blocking links: #23 → (#24, #25) → #26 → #27 → #28 → (#29, #30, #31) → #32. Work the frontier: start any ticket whose blockers are closed; close a ticket only when every acceptance box is ticked and the evidence (results JSON, tables, probe output) is committed.

**Read first, in this order:** `AGENTS.md`, `CONTEXT.md`, `docs/agents/domain.md`, `docs/adr/*`, the spec, then the ticket you are about to start. Use the glossary's vocabulary (Claim, Span, Slot, Anchor/Token, Convergence, Supersession, As-of, Verdict, Receipt) — not synonyms.

**Decisions already made — do not reopen them:**
- TypeScript + Effect only. No Go, no second runtime. HydraDB is the only candidate index; no vector/BM25 sidecar in the product read path (F-36 deferred).
- Population is **200 questions** (`--slice 200`, all 30 `_abs` + 170 stratified), not 500. Dev = the 60 questions already cached from the `g2` run; test = the other 140, read **once**, after the gate.
- One HydraDB deployment: the Compose benchmark project under `ops/hydradb/` with the MinIO sidecar (the local object store is documented *not* crash-safe). Delete the legacy `hydradb` container, `hydradb-data` volume and `palimpsest-p0-*` containers. Raise WSL memory to 12 GB first.
- Ingest through the legacy, query-visible path (`pnpm ingest-slice`) under prefix `g3`; the transactional/generation ingest is not on the read path and is out of scope. Record the runtime extraction generation id as provenance.
- Reader model frozen at `gpt-5.6-luna` for the whole v1-vs-v2 comparison. Selector and sufficiency models are separate env vars, defaulting to the reader model; validate ids against the provider at startup.
- Latency: `graphMs` (HydraDB stages) ≤ 1.5 s p50 warm; `askMs` ≤ 8 s full / ≤ 5 s `fast` profile. Read-path concurrency applies to v1 as well; v1 evidence and `hash` must stay byte-identical.
- Spend is not a constraint (ingest ≈ $65, evals ≈ $20–40 each); high concurrency is fine. Stop for non-LLM failures and for a tripped capacity gate, not for cost.

**How to work:**
- Every LLM call on the read path is cached by content hash under `.cache/llm` in its own family; never bypass the cache; store the rendered prompt beside the cached value.
- Tests at the highest seam that needs no live node: pure stage modules with fixtures (`vitest run --project unit`), then the live probe suite (`pnpm probe`) on the new graph, then `pnpm eval --split dev`. Run `pnpm typecheck` and the unit project before closing any ticket.
- Run Docker commands from PowerShell, not Git Bash (MSYS rewrites paths inside `-e`/`-v`).
- Keep results reproducible: every results envelope carries split, profile, model ids and the generation id; `pnpm table` must rebuild every table from JSON alone.
- Report numbers as measured, including the ones that go against v2. Do not tune on the test split. Do not read the test split before the gate record exists.
- Commit per ticket with a message naming the ticket; comment on the ticket with the measured numbers when closing it. If a ticket cannot be finished as specified, say what was left out and why on the ticket and in #22 — do not scale the work down silently.

Start with #23. Its ingest is wall-clock bound, so once it is running in the background, begin the node-independent parts of #24 and #25 (stage modules, harness flags, unit tests) and return to #23's step-load recordings as each step completes.
