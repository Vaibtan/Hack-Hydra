# Switches the benchmark node between the ingest phase and the eval phase.
#
# The phases differ in one setting (ops/hydradb/step-load-2026-08.md):
#
#   | setting                          | ingest | eval   |
#   |----------------------------------|--------|--------|
#   | GRAPH_OBJECT_STORE_CACHE_ENABLED | false  | true   |
#   | GRAPH_MAX_QUERY_RUNTIME_MS       | 120000 | 120000 |
#
# The read cache: off during an ingest, because on, the node reaches the cycling
# driver's memory ceiling in four minutes; on during an eval, because off, every
# block a read touches is an HTTP GET to the object store.
#
# **The query cap is 120 s in both phases, decided 2026-08-31 and not the
# spec's 30 s for the eval.** The reason is measured: on the 60-user graph a
# cold ask is 86.2 s and the second ask on the same user is 0.1 s, so the whole
# cost is pulling a user's working set out of the object store once. At a 30 s
# cap the *priming* pass cannot complete a single ask, and without a priming
# pass there is no warm pass to measure. Chunking the priming into small queries
# was tried — `warmUser` batches at 200 source keys — and works for every level
# except `HITS`, which is the convergence walk's own edge set and the one that
# matters.
#
# What this does **not** do is relax anything a reported number is measured
# against. Every latency figure in the tables is a warm one, on the order of
# 0.1 s, which is two orders of magnitude below even the shipped 30 s cap; no
# measured ask comes near either value. The cap decides whether the first pass
# finishes, not what the second pass reports. `runtime_config_sha256` records it
# in every envelope and the writeup says both passes ran at 120 s.
#
# Both settings change how a read is *served*, never what is stored.
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
  $env:PALIMPSEST_HYDRADB_READ_CACHE = "true"
  $env:PALIMPSEST_HYDRADB_QUERY_RUNTIME_MS = "120000"
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
$expectedRuntime = "120000"
if ($cache -ne $expectedCache -or $runtime -ne $expectedRuntime) {
  throw "phase switch to $Phase did not take: read cache $cache (want $expectedCache), query cap $runtime (want $expectedRuntime)"
}

[pscustomobject]@{
  phase = $Phase
  container_id = $container[0]
  read_cache_enabled = $cache
  max_query_runtime_ms = $runtime
} | ConvertTo-Json -Compress
