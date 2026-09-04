[CmdletBinding()]
param(
  [string] $ImageTag = "palimpsest/hydradb:6a2fbb1",

  [string] $ExpectedSourceRevision = "6a2fbb192f37f51a93690a2ae2d2f5e27e6e4219"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceDirectory = Join-Path $repositoryRoot "vendor/hydradb"
if (-not (Test-Path -LiteralPath $sourceDirectory)) {
  throw "The vendored HydraDB source was not found at $sourceDirectory"
}

$actualRevision = (& git -C $sourceDirectory rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Could not read the vendored HydraDB revision"
}
if ($actualRevision -ne $ExpectedSourceRevision) {
  throw "Vendored HydraDB revision $actualRevision does not match required $ExpectedSourceRevision"
}

# The runtime carries an uncommitted patch, so the image identity is commit + diff hash.
$patchLines = @(& git -c core.autocrlf=false -C $sourceDirectory diff --binary --no-ext-diff)
if ($LASTEXITCODE -ne 0) {
  throw "Could not calculate the vendored HydraDB remediation patch fingerprint"
}
$patchText = $patchLines -join "`n"
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $hashBytes = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($patchText))
} finally {
  $sha256.Dispose()
}
$sourcePatchSha256 = (-join ($hashBytes | ForEach-Object { $_.ToString("x2") }))

& docker build --target runtime `
  --label "org.opencontainers.image.source=https://github.com/hydra-db/hydradb" `
  --label "org.opencontainers.image.revision=$ExpectedSourceRevision" `
  --label "io.palimpsest.hydradb.source-patch-sha256=$sourcePatchSha256" `
  --tag $ImageTag `
  $sourceDirectory
if ($LASTEXITCODE -ne 0) {
  throw "HydraDB runtime image build failed with exit code $LASTEXITCODE"
}

$image = (& docker image inspect $ImageTag | ConvertFrom-Json)[0]
if ($null -eq $image -or
  $image.Config.Labels."org.opencontainers.image.revision" -ne $ExpectedSourceRevision -or
  $image.Config.Labels."io.palimpsest.hydradb.source-patch-sha256" -ne $sourcePatchSha256) {
  throw "Built image is missing the required reviewed-source provenance labels"
}

[pscustomobject]@{
  image_reference = $ImageTag
  image_id = $image.Id
  source_revision = $ExpectedSourceRevision
  source_patch_sha256 = $sourcePatchSha256
  source_describe = (& git -C $sourceDirectory describe --tags --always).Trim()
  build_target = "runtime"
} | ConvertTo-Json -Compress
