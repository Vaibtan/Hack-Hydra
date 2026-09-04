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
Import-Module (Join-Path $PSScriptRoot "lib/hydra.psm1") -Force

$logDirectory = Join-Path (Get-HydraRepositoryRoot) ".eval-logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

$startedAt = Get-Date
$env:PALIMPSEST_READ_TIMEOUT_MS = "115000"

for ($batch = $FromBatch; $batch -le $Batches; $batch++) {
  if (-not (Set-HydraPhase -Phase eval -Restart -TimeoutSeconds 180).ready) {
    Write-Output "batch $batch : node did not become ready; stopping"
    exit 1
  }
  $log = Join-Path $logDirectory ("reader-ab-{0}-b{1:d2}.log" -f $Split, $batch)
  Write-Output ("batch {0}/{1}" -f $batch, $Batches)
  $exitCode = Invoke-EvalProcess -Log $log -ArgumentList @(
    "tsx", "packages/eval/bin/reader-ab.ts",
    "--split", $Split, "--batch", "$batch/$Batches", "--concurrency", "$Concurrency"
  )
  if ($exitCode -ne 0) {
    Write-Output ("  batch {0} exited {1}; see {2}" -f $batch, $exitCode, $log)
    Get-Content $log -Tail 6 | ForEach-Object { Write-Output "  | $_" }
    exit 1
  }
  Write-Output ("batch {0}/{1} done, {2:n1} min elapsed" -f $batch, $Batches, ((Get-Date) - $startedAt).TotalMinutes)
}

$mergeLog = Join-Path $logDirectory ("reader-ab-{0}-merge.log" -f $Split)
$exitCode = Invoke-EvalProcess -Log $mergeLog -ArgumentList @(
  "tsx", "packages/eval/bin/reader-ab.ts", "--split", $Split, "--merge"
)
if ($exitCode -ne 0) {
  Write-Output "merge refused; see $mergeLog"
  Get-Content $mergeLog -Tail 10 | ForEach-Object { Write-Output "  | $_" }
  exit 1
}
Get-Content $mergeLog | ForEach-Object { Write-Output $_ }
Write-Output ("reader A/B done in {0:n1} min" -f ((Get-Date) - $startedAt).TotalMinutes)
