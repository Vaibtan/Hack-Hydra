# Palimpsest

Use the package manager pinned in `package.json`. For code changes, run affected unit tests and `pnpm typecheck` when types or contracts change. `pnpm test:unit` selects unit tests; `pnpm test` also selects live tests, and test setup loads `.env`. Select live checks deliberately for the requested behavior and configured environment.

Preserve unrelated changes, `data/`, `.cache/llm`, `.palimpsest/`, and the HydraDB volume. Resetting a persistent store or spending on ingestion/evaluation must be part of the authorized task. Run Docker commands from PowerShell; Git Bash rewrites container paths.

For ingestion or evaluation work, consult the relevant runtime procedures in `ops/hydradb/step-load-2026-08.md` and the adoption gate in `docs/spec-retrieval-v2.md`. Report the evaluated population, cache/runtime conditions and acceptance evidence; unit tests alone do not establish runtime readiness. Historical dossiers under `docs/archive/` are evidence of earlier work, not current gate status.

For domain or architecture changes, follow the conditional pointers in [domain.md](docs/agents/domain.md). For GitHub issue work, use [issue-tracker.md](docs/agents/issue-tracker.md) and the five state labels in [triage-labels.md](docs/agents/triage-labels.md).

Keep these instructions authoritative for this Codex-only project. Instructions under `vendor/hydradb/` apply to that subtree.

Whenever committing changes, use the `commit-work` skill to review, stage, verify, and commit only the intended scope.
