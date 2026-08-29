# Transactional source/index configuration

The bounded source/index paths deliberately fail closed unless every mutable
dependency is bound to an immutable value. This applies to:

- `pnpm index-source --uid <question_id>`; and
- `POST /users/:uid/source-index`.

They durably write only through `INDEXED`. Their response has
`queryVisible: false`; the active retrieval generation, projections, and
terminal `COMMITTED` workflow are separate unfinished remediation work.

The server parses this configuration while it constructs its route group. A
missing value therefore prevents startup rather than allowing an HTTP request
to use an unpinned generation. Until the legacy route is migrated, this
fail-closed startup gate applies to the whole local server process.

## Release procedure

After the implementation files have been reviewed and committed, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/palimpsest-generation-config.ps1
```

The script refuses a dirty relevant worktree and prints copyable non-secret
values for `.env`. It uses the immutable release commit for the extractor,
tokenizer, graph writer, and graph schema. It does not write `.env` itself.

The approved model snapshot is `gpt-5.6-luna`, so the generated values bind
both `PALIMPSEST_MODEL` and `PALIMPSEST_EXTRACTION_MODEL_REVISION` to that
same snapshot. Keep `OPENAI_API_KEY` separate and secret; never add it to a
commit or a report.

Changing any emitted local revision, the model snapshot, the static extraction
prompt, or the extraction schema creates a new ExtractionGeneration and/or
IndexGeneration. Existing generations are immutable and must not be rewritten
in place.

## Example bounded HTTP response

```json
{
  "uid": "user-a",
  "sid": "session-a",
  "commitId": "…",
  "sourceDigest": "…",
  "extractionGeneration": "extract-v1-…",
  "indexGeneration": "index-v1-…",
  "state": "INDEXED",
  "alreadyAtTarget": false,
  "queryVisible": false
}
```

Do not treat this as successful end-to-end ingest or as evidence that `ask`
can read the session. The legacy `POST /users/:uid/sessions` route retains its
older graph protocol while F-08 through F-14 are being completed.
