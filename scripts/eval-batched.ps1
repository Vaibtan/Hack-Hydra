# Runs one eval across the population in batches, restarting the node between
# them, and taking the reported numbers from a warm pass.
#
# Why batches. A read costs ~750 MiB of resident memory per distinct user and
# does not bound, so the node holds about seven of the 60 dev users before the
# capacity gate stops it (ops/hydradb/step-load-2026-08.md). A 60-question run
# cannot happen in one node lifetime.
#
# Why two passes per batch. A cold ask on this graph is 65-86 s and the second
# ask of the same user in the same node lifetime is 0.1 s -- the whole cost is
# pulling a user's working set out of the object store once. Nothing survives a
# restart (the disk cache does not fill; its evictor drops the writes), so the
# warm pass has to happen inside the same lifetime as the cold one that primed
# it. Pass 1 is discarded; pass 2 is the results file.
#
# Both passes replay every LLM call from .cache/llm, so pass 2 costs $0.00 and
# produces the same answers -- only the timings differ, which is the point.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/eval-batched.ps1 `
#     -System palimpsest -Split dev -Batches 12
#
#   ... -ExtraArgs "--no-select"        # an ablation
#   ... -ExtraArgs "--profile","fast"   # the fast profile

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
  # Passed through to `eval` verbatim: ablation flags, --profile, --granularity.
  [string[]] $ExtraArgs = @(),
  # Names the merged file when an ablation run writes its own. Must match the
  # suffix `eval` builds from the flags, or the merge finds nothing.
  [string] $Variant = "",
  [ValidateRange(1, 200)]
  [int] $FromBatch = 1,
  # Stops early. For validating the flow on one batch before committing hours
  # to twelve of them, and for resuming a run that died half way.
  [ValidateRange(0, 200)]
  [int] $ToBatch = 0
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
  # The eval phase: read cache on, 120 s cap. `docker restart` and not a
  # recreate -- a recreate would also be correct but is slower and changes the
  # container id the capacity gate resolved at startup.
  $env:PALIMPSEST_HYDRADB_READ_CACHE = "true"
  $env:PALIMPSEST_HYDRADB_QUERY_RUNTIME_MS = "120000"
  & docker compose --project-directory $opsDirectory --env-file $envFile -f $composePath up -d hydradb | Out-Null
  $id = Get-HydraContainerId
  if ($null -ne $id) {
    # SIGTERM and wait: the writer lease is only released cleanly on a graceful
    # stop, and a node killed mid-statement comes back read-only on this object
    # store (CONTEXT.md, writer lease).
    & docker restart --time 30 $id | Out-Null
  }
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
  # The cold pass needs a ceiling above the engine's, or it fails every ask on
  # the read it is there to prime. The warm pass runs at the default 25 s, which
  # is the ceiling the product ships -- so if a warm ask ever needed more, this
  # would fail rather than quietly report it.
  if ($Pass -eq "cold") {
    $env:PALIMPSEST_READ_TIMEOUT_MS = "115000"
  } else {
    Remove-Item Env:PALIMPSEST_READ_TIMEOUT_MS -ErrorAction SilentlyContinue
  }

  # `Start-Process` with explicit redirects rather than `& npx ... *>&1`.
  # Node writes an `ExperimentalWarning` about SQLite to stderr on every start,
  # and under `$ErrorActionPreference = "Stop"` PowerShell turns a native
  # command's stderr into a terminating `NativeCommandError` -- so the first run
  # of this script killed itself on a warning, *after* the eval had succeeded
  # and written its results file. Redirecting to files keeps stderr as text.
  $process = Start-Process -FilePath "npx.cmd" -ArgumentList $arguments `
    -WorkingDirectory $repositoryRoot -RedirectStandardOutput $Log `
    -RedirectStandardError "$Log.err" -WindowStyle Hidden -PassThru -Wait
  return $process.ExitCode
}

$lastBatch = if ($ToBatch -eq 0) { $Batches } else { [Math]::Min($ToBatch, $Batches) }

$startedAt = Get-Date
for ($batch = $FromBatch; $batch -le $lastBatch; $batch++) {
  if (-not (Restart-NodeForEval)) {
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
    Write-Output "  warm pass exited $warm; see $warmLog"
    Get-Content $warmLog -Tail 6 | ForEach-Object { Write-Output "  | $_" }
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
& npx @mergeArgs
if ($LASTEXITCODE -ne 0) {
  Write-Output "merge refused; the batch files are in results/ and say why"
  exit 1
}

Write-Output ("all {0} batches done in {1:n1} min" -f $Batches, ((Get-Date) - $startedAt).TotalMinutes)
