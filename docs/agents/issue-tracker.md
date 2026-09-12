# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `Vaibtan/Hack-Hydra`. Use `gh` from the checkout or pass `--repo Vaibtan/Hack-Hydra` when repository discovery is unavailable. Confirm the remote if it changes.

Read the relevant issue body, comments and labels. A bare number can identify an issue or PR; resolve its type before acting. **PRs as a request surface: no.** An explicitly requested PR review remains in scope.

Create, comment, label or close issues when the user authorizes those operations. Reuse existing authorization and avoid duplicate issues. Use the state labels in [triage-labels.md](triage-labels.md); category labels such as bug/enhancement are separate.

For multiline issue or PR bodies, write the exact Markdown to a UTF-8 temporary file and pass `--body-file`. Preserve real newlines and literal code; do not build shell commands from document contents. Remove temporary body files after use.

When splitting a spec into tickets, record concrete acceptance criteria and actual blockers. Use native sub-issue/dependency relationships when supported; otherwise include linked parent and blocker references in the body. A blocker reference uses the platform's required identifier, which may differ from the displayed issue number. Fetch current API documentation before wiring unfamiliar relationships.

Publishing a spec means creating or updating its GitHub issue, only when publication is included in the request. Reading a spec or making a local draft does not itself authorize publication.
