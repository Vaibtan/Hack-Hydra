# The reader A/B, in batches, restarting the node between them.
#
# Same constraint as the eval: the A/B reads the graph, a read costs ~750 MiB of
# resident memory per distinct user and does not bound, and the node holds about
# seven users (ops/hydradb/step-load-2026-08.md). The A/B's population is the 11
# preference and 14 knowledge-update dev questions, which is 25 users.
#
# Unlike the eval there is **no warm pass**. The A/B compares two answers on
# identical evidence and reports no latency, so a batch is read once and there
# is nothing a second pass would measure. That also means the cold ceiling
# applies throughout.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reader-ab-batched.ps1

[CmdletBinding()]
param(
  [ValidateSet("dev", "test")]
  [string] $Split = "dev",
  [ValidateRange(1, 50)]
  [int] $Batches = 5,
  [ValidateRange(1, 16)]
  [int] $Concurrency = 2,
  [ValidateRange(1, 50)]
  [int] $FromBatch = 1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$opsDirectory = Join-Path $repositoryRoot "ops/hydradb"
$composePath = Join-Path $opsDirectory "compose.benchmark.yaml"
$envFile = Join-Path $opsDirectory ".env.benchmark"
$logDirectory = Join-Path $repositoryRoot ".eval-logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

function Get-HydraContainerId {
  $found = @(
    @(
      & docker ps -a --filter "label=com.docker.compose.project=palimpsest-hydradb-benchmark" `
        --filter "label=com.docker.compose.service=hydradb" --format "{{.ID}}"
    ) | ForEach-Object { ([string] $_).Trim() } | Where-Object { $_.Length -gt 0 }
  )
  if ($found.Count -ne 1) { return $null }
  return $found[0]
}

function Restart-NodeForEval {
  $env:PALIMPSEST_HYDRADB_READ_CACHE = "true"
  $env:PALIMPSEST_HYDRADB_QUERY_RUNTIME_MS = "120000"
  & docker compose --project-directory $opsDirectory --env-file $envFile -f $composePath up -d hydradb | Out-Null
  $id = Get-HydraContainerId
  if ($null -ne $id) { & docker restart --time 30 $id | Out-Null }
  for ($i = 0; $i -lt 90; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:29090/readyz" -TimeoutSec 5 -UseBasicParsing
      if ($response.StatusCode -eq 200) { return $true }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  return $false
}

$startedAt = Get-Date
$env:PALIMPSEST_READ_TIMEOUT_MS = "115000"

for ($batch = $FromBatch; $batch -le $Batches; $batch++) {
  if (-not (Restart-NodeForEval)) {
    Write-Output "batch $batch : node did not become ready; stopping"
    exit 1
  }
  $log = Join-Path $logDirectory ("reader-ab-{0}-b{1:d2}.log" -f $Split, $batch)
  Write-Output ("batch {0}/{1}" -f $batch, $Batches)
  # Start-Process with explicit redirects: node's SQLite ExperimentalWarning on
  # stderr becomes a terminating NativeCommandError under ErrorActionPreference
  # Stop, which once killed this driver after the work had already succeeded.
  $process = Start-Process -FilePath "npx.cmd" -ArgumentList @(
    "tsx", "packages/eval/bin/reader-ab.ts",
    "--split", $Split, "--batch", "$batch/$Batches", "--concurrency", "$Concurrency"
  ) -WorkingDirectory $repositoryRoot -RedirectStandardOutput $log `
    -RedirectStandardError "$log.err" -WindowStyle Hidden -PassThru -Wait
  if ($process.ExitCode -ne 0) {
    Write-Output ("  batch {0} exited {1}; see {2}" -f $batch, $process.ExitCode, $log)
    Get-Content $log -Tail 6 | ForEach-Object { Write-Output "  | $_" }
    exit 1
  }
  Write-Output ("batch {0}/{1} done, {2:n1} min elapsed" -f $batch, $Batches, ((Get-Date) - $startedAt).TotalMinutes)
}

$mergeLog = Join-Path $logDirectory ("reader-ab-{0}-merge.log" -f $Split)
$process = Start-Process -FilePath "npx.cmd" -ArgumentList @(
  "tsx", "packages/eval/bin/reader-ab.ts", "--split", $Split, "--merge"
) -WorkingDirectory $repositoryRoot -RedirectStandardOutput $mergeLog `
  -RedirectStandardError "$mergeLog.err" -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0) {
  Write-Output "merge refused; see $mergeLog"
  Get-Content $mergeLog -Tail 10 | ForEach-Object { Write-Output "  | $_" }
  exit 1
}
Get-Content $mergeLog | ForEach-Object { Write-Output $_ }
Write-Output ("reader A/B done in {0:n1} min" -f ((Get-Date) - $startedAt).TotalMinutes)
