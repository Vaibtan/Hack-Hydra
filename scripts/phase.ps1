# Switches the benchmark node between the ingest phase and the eval phase.
#
# Two settings are chosen per phase, not once (ops/hydradb/step-load-2026-08.md):
#
#   | setting                          | ingest | eval  |
#   |----------------------------------|--------|-------|
#   | GRAPH_OBJECT_STORE_CACHE_ENABLED | false  | true  |
#   | GRAPH_MAX_QUERY_RUNTIME_MS       | 120000 | 30000 |
#
# Off, a cold convergence walk does not finish in 25 s, because every block it
# reads is an HTTP GET; on during an ingest, the node reaches the cycling
# driver's ceiling in four minutes. The 30 s cap exists to stop a runaway plan,
# which an ingest does not have and an eval does — and the eval is the only
# phase that makes a latency or accuracy claim, so it runs on the shipped value.
#
# Both change how a read is *served*, never what is stored, and
# `runtime_config_sha256` records which of the two produced a given result.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/phase.ps1 -Phase eval

[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet("ingest", "eval")]
  [string] $Phase
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$opsDirectory = Join-Path $repositoryRoot "ops/hydradb"
$composePath = Join-Path $opsDirectory "compose.benchmark.yaml"
$envFile = Join-Path $opsDirectory ".env.benchmark"

if ($Phase -eq "ingest") {
  $env:PALIMPSEST_HYDRADB_READ_CACHE = "false"
  $env:PALIMPSEST_HYDRADB_QUERY_RUNTIME_MS = "120000"
} else {
  # Unset, so the Compose defaults apply. Setting them to the eval values by
  # hand would work and would also mean two places to change if a default moves.
  Remove-Item Env:PALIMPSEST_HYDRADB_READ_CACHE -ErrorAction SilentlyContinue
  Remove-Item Env:PALIMPSEST_HYDRADB_QUERY_RUNTIME_MS -ErrorAction SilentlyContinue
}

& docker compose --project-directory $opsDirectory --env-file $envFile -f $composePath up -d hydradb | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed with exit code $LASTEXITCODE" }

for ($i = 0; $i -lt 90; $i++) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:29090/readyz" -TimeoutSec 5 -UseBasicParsing
    if ($response.StatusCode -eq 200) { break }
  } catch {
    Start-Sleep -Seconds 2
  }
}

# `@(...)` wraps the *whole* pipeline: a one-container result would otherwise
# come back as a bare string, and `$container[0]` would then be its first
# character rather than the id.
$container = @(
  @(
    & docker ps --filter "label=com.docker.compose.project=palimpsest-hydradb-benchmark" `
      --filter "label=com.docker.compose.service=hydradb" --format "{{.ID}}"
  ) | ForEach-Object { ([string] $_).Trim() } | Where-Object { $_.Length -gt 0 }
)
if ($container.Count -ne 1) {
  throw "expected exactly one running benchmark HydraDB container, found $($container.Count)"
}

# Read back rather than reported: `compose up -d` is a no-op when nothing
# changed, and a phase switch that silently did not happen is the failure this
# script exists to make impossible.
$environment = & docker inspect $container[0] --format '{{range .Config.Env}}{{println .}}{{end}}'
$cache = ($environment | Select-String -Pattern "^GRAPH_OBJECT_STORE_CACHE_ENABLED=(.*)$").Matches.Groups[1].Value
$runtime = ($environment | Select-String -Pattern "^GRAPH_MAX_QUERY_RUNTIME_MS=(.*)$").Matches.Groups[1].Value

$expectedCache = if ($Phase -eq "ingest") { "false" } else { "true" }
$expectedRuntime = if ($Phase -eq "ingest") { "120000" } else { "30000" }
if ($cache -ne $expectedCache -or $runtime -ne $expectedRuntime) {
  throw "phase switch to $Phase did not take: read cache $cache (want $expectedCache), query cap $runtime (want $expectedRuntime)"
}

[pscustomobject]@{
  phase = $Phase
  container_id = $container[0]
  read_cache_enabled = $cache
  max_query_runtime_ms = $runtime
} | ConvertTo-Json -Compress
