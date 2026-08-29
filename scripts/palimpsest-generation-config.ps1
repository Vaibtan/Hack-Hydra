[CmdletBinding()]
param(
  [string] $Repository
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Repository)) {
  $Repository = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$gitRepository = $Repository -replace "\\", "/"
$relevantPaths = @(
  "packages/palimpsest/src/Extract.ts",
  "packages/palimpsest/src/GenerationConfig.ts",
  "packages/palimpsest/src/IndexGeneration.ts",
  "packages/palimpsest/src/SourceIdentity.ts",
  "packages/palimpsest/src/SourceIndexing.ts",
  "packages/palimpsest/src/Tokenize.ts",
  "packages/palimpsest/src/IndexGraph.ts"
)

$dirty = & git -c "safe.directory=$gitRepository" -C $gitRepository status --porcelain -- @relevantPaths
if ($LASTEXITCODE -ne 0) {
  throw "Unable to inspect Palimpsest generation provenance."
}
if ($dirty.Count -gt 0) {
  throw "Refusing to emit generation revisions from an uncommitted implementation. Commit or otherwise release the listed paths first."
}

$commit = (& git -c "safe.directory=$gitRepository" -C $gitRepository rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch "^[0-9a-f]{40}$") {
  throw "Unable to resolve an immutable repository commit."
}

@"
# Palimpsest transactional source/index generation — release $commit
PALIMPSEST_MODEL=gpt-5.6-luna
PALIMPSEST_EXTRACTION_MODEL_REVISION=gpt-5.6-luna
PALIMPSEST_EXTRACTION_EXTRACTOR_REVISION=git:$commit:packages/palimpsest/src/Extract.ts
PALIMPSEST_EXTRACTION_TOKENIZER_REVISION=git:$commit:packages/palimpsest/src/Tokenize.ts
PALIMPSEST_INDEX_WRITER_REVISION=git:$commit:packages/palimpsest/src/IndexGraph.ts
PALIMPSEST_INDEX_SCHEMA_REVISION=git:$commit:packages/palimpsest/src/IndexGraph.ts
"@.Trim()
