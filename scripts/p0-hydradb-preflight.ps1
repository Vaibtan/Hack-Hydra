[CmdletBinding()]
param(
  [switch] $SkipReadiness
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$opsDirectory = Join-Path $repositoryRoot "ops/hydradb"
$manifestPath = Join-Path $opsDirectory "runtime-manifest.v1.json"
$profilePath = Join-Path $opsDirectory "benchmark-profile.v1.json"
$composePath = Join-Path $opsDirectory "compose.benchmark.yaml"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json

function Assert-LastDockerCommand {
  param([Parameter(Mandatory)][string] $Operation)
  if ($LASTEXITCODE -ne 0) {
    throw "docker $Operation failed with exit code $LASTEXITCODE"
  }
}

if ($manifest.hydradb.image_reference -match "(?i)(^|[:/])latest($|@)") {
  throw "The benchmark HydraDB image must not use latest"
}
if ($manifest.object_store.durability_profile -ne "s3-compatible" -or -not $manifest.object_store.required_conditional_update) {
  throw "The benchmark runtime manifest does not require a conditional-update object store"
}

$image = (& docker image inspect $manifest.hydradb.image_reference | ConvertFrom-Json)[0]
Assert-LastDockerCommand -Operation "inspect HydraDB image"
if ($image.Id -ne $manifest.hydradb.verified_local_image_id) {
  throw "HydraDB image id $($image.Id) does not match the verified manifest image id $($manifest.hydradb.verified_local_image_id)"
}
foreach ($label in $manifest.hydradb.required_oci_labels.PSObject.Properties) {
  if ($image.Config.Labels.($label.Name) -ne $label.Value) {
    throw "HydraDB image is missing required OCI label $($label.Name)=$($label.Value)"
  }
}

$dockerMemory = [Int64] (& docker info --format "{{.MemTotal}}")
Assert-LastDockerCommand -Operation "inspect host memory"
$requiredMemory = [Int64] $profile.containers.hydradb.memory_bytes +
  [Int64] $profile.containers.object_store.memory_bytes +
  [Int64] $profile.containers.hydradb.minimum_host_headroom_bytes
if ($dockerMemory -lt $requiredMemory) {
  throw "Docker has $dockerMemory bytes but the benchmark profile requires $requiredMemory bytes including headroom"
}

$previousEnvFile = $env:PALIMPSEST_HYDRADB_ENV_FILE
$previousAuthTokenFile = $env:PALIMPSEST_HYDRADB_AUTH_TOKEN_FILE
try {
  $env:PALIMPSEST_HYDRADB_ENV_FILE = ".env.benchmark.example"
  $env:PALIMPSEST_HYDRADB_AUTH_TOKEN_FILE = "./secrets/hydradb-auth-token.example"
  & docker compose --project-directory $opsDirectory -f $composePath config --quiet
  Assert-LastDockerCommand -Operation "validate benchmark compose profile"
} finally {
  $env:PALIMPSEST_HYDRADB_ENV_FILE = $previousEnvFile
  $env:PALIMPSEST_HYDRADB_AUTH_TOKEN_FILE = $previousAuthTokenFile
}

$result = [ordered]@{
  status = "passed"
  hydradb_image_id = $image.Id
  hydradb_source_revision = $manifest.hydradb.source_revision
  object_store_profile = $manifest.object_store.durability_profile
  docker_memory_bytes = $dockerMemory
  required_memory_bytes = $requiredMemory
}

if (-not $SkipReadiness) {
  $uri = [Uri] $profile.readiness.hydradb_endpoint
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec $profile.readiness.timeout_seconds
  } catch {
    throw "HydraDB readiness probe failed at $($uri): $($_.Exception.Message)"
  }
  if ($response.StatusCode -ne 200) {
    throw "HydraDB readiness probe returned HTTP $($response.StatusCode)"
  }
  $result.hydradb_readyz = "passed"
}

[pscustomobject] $result | ConvertTo-Json -Compress
