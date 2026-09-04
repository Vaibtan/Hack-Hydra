#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/eval-batched.ps1 `
#     -System palimpsest-v2 -Split dev -Batches 15
#   ... -ExtraArgs "--no-select" -Variant no-select
#   ... -ExtraArgs "--profile","fast" -Variant profile-fast
#   ... -WorkingDirectory ..\palimpsest-v1 -ResultsDir <repo>\results   # a v1 checkout

[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string] $System,
  [ValidateSet("dev", "test")]
  [string] $Split = "dev",
  [ValidateRange(1, 200)]
  [int] $Batches = 12,
  [ValidateRange(1, 16)]
  [int] $Concurrency = 2,
  [string[]] $ExtraArgs = @(),
  [string] $Variant = "",
  [string] $WorkingDirectory = "",
  [string] $ResultsDir = "",
  [ValidateRange(1, 200)]
  [int] $FromBatch = 1,
  [ValidateRange(0, 200)]
  [int] $ToBatch = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "lib/hydra.psm1") -Force

$logDirectory = Join-Path (Get-HydraRepositoryRoot) ".eval-logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
if ($WorkingDirectory -eq "") { $WorkingDirectory = Get-HydraRepositoryRoot }
if (-not (Test-Path (Join-Path $WorkingDirectory "packages/eval/bin/eval.ts"))) {
  Write-Output "no eval harness at $WorkingDirectory"
  exit 1
}
if ($ResultsDir -ne "") { $ExtraArgs += @("--out", $ResultsDir) }

function Invoke-EvalPass {
  param(
    [Parameter(Mandatory)][int] $Batch,
    [Parameter(Mandatory)][string] $Pass,
    [Parameter(Mandatory)][string] $Log
  )
  $arguments = @(
    "tsx", "packages/eval/bin/eval.ts",
    "--system", $System,
    "--split", $Split,
    "--batch", "$Batch/$Batches",
    "--concurrency", "$Concurrency"
  ) + $ExtraArgs
  if ($Pass -eq "cold") {
    $env:PALIMPSEST_READ_TIMEOUT_MS = "115000"
  } else {
    Remove-Item Env:PALIMPSEST_READ_TIMEOUT_MS -ErrorAction SilentlyContinue
  }
  return Invoke-EvalProcess -ArgumentList $arguments -Log $Log -WorkingDirectory $WorkingDirectory
}

$lastBatch = if ($ToBatch -eq 0) { $Batches } else { [Math]::Min($ToBatch, $Batches) }

$startedAt = Get-Date
for ($batch = $FromBatch; $batch -le $lastBatch; $batch++) {
  if (-not (Set-HydraPhase -Phase eval -Restart -TimeoutSeconds 180).ready) {
    Write-Output "batch $batch : node did not become ready; stopping"
    exit 1
  }

  $tag = "{0}-{1}{2}-b{3:d2}" -f $System, $Split, $(if ($Variant -eq "") { "" } else { "-$Variant" }), $batch
  $coldLog = Join-Path $logDirectory "$tag-cold.log"
  $warmLog = Join-Path $logDirectory "$tag-warm.log"

  Write-Output ("batch {0}/{1} : cold pass" -f $batch, $Batches)
  $cold = Invoke-EvalPass -Batch $batch -Pass "cold" -Log $coldLog
  if ($cold -ne 0) {
    Write-Output "  cold pass exited $cold; see $coldLog"
    Get-Content $coldLog -Tail 6 | ForEach-Object { Write-Output "  | $_" }
    exit 1
  }

  Write-Output ("batch {0}/{1} : warm pass" -f $batch, $Batches)
  $warm = Invoke-EvalPass -Batch $batch -Pass "warm" -Log $warmLog
  if ($warm -ne 0) {
    Write-Output "  warm pass exited $warm; retrying once"
    $warm = Invoke-EvalPass -Batch $batch -Pass "warm" -Log $warmLog
  }
  if ($warm -ne 0) {
    Write-Output "  warm pass exited $warm twice; see $warmLog"
    Get-Content "$warmLog.err" -Tail 4 | ForEach-Object { Write-Output "  | $_" }
    exit 1
  }

  $elapsed = ((Get-Date) - $startedAt).TotalMinutes
  Write-Output ("batch {0}/{1} : done, {2:n1} min elapsed" -f $batch, $Batches, $elapsed)
  Get-Content $warmLog -Tail 3 | Where-Object { $_ -match "wrote|accuracy" } | ForEach-Object { Write-Output "  | $_" }
}

if ($lastBatch -ne $Batches -or $FromBatch -ne 1) {
  Write-Output ("batches {0}-{1} of {2} done; run the rest, then merge" -f $FromBatch, $lastBatch, $Batches)
  exit 0
}

$mergeArgs = @("tsx", "packages/eval/bin/merge-batches.ts", "--system", $System, "--split", $Split)
if ($Variant -ne "") { $mergeArgs += @("--variant", $Variant) }
if ($ResultsDir -ne "") { $mergeArgs += @("--results", $ResultsDir) }
Push-Location $WorkingDirectory
try {
  & npx @mergeArgs
} finally {
  Pop-Location
}
if ($LASTEXITCODE -ne 0) {
  Write-Output "merge refused; the batch files are in results/ and say why"
  exit 1
}

Write-Output ("all {0} batches done in {1:n1} min" -f $Batches, ((Get-Date) - $startedAt).TotalMinutes)
