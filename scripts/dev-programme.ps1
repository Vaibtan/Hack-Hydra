# The whole dev programme in ticket order. Graph-touching runs go through
# scripts/eval-batched.ps1; bm25, fullctx and oracle-session read the dataset
# and run unbatched. palimpsest and palimpsest-v2 come first because the
# adoption gate is read from exactly those two.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev-programme.ps1
#   ... -From 4        # resume at the fourth run
#   ... -List          # print the plan and exit

[CmdletBinding()]
param(
  [ValidateRange(1, 99)]
  [int] $From = 1,
  # 15 x 4 users: v2 peaked at 5.19 GiB of 5.5 at five users a batch.
  [ValidateRange(1, 99)]
  [int] $Batches = 15,
  [ValidateRange(1, 16)]
  [int] $Concurrency = 2,
  [switch] $List
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Import-Module (Join-Path $PSScriptRoot "lib/hydra.psm1") -Force

$repositoryRoot = Get-HydraRepositoryRoot
$batched = Join-Path $PSScriptRoot "eval-batched.ps1"
$logDirectory = Join-Path $repositoryRoot ".eval-logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

# `variant` must match the suffix `eval` derives from the flags (`noTimeScope`
# -> `no-timescope`), or the merge finds no files.
$runs = @(
  @{ name = "palimpsest";            system = "palimpsest";    graph = $true;  args = @();                              variant = "" }
  @{ name = "palimpsest-v2 full";    system = "palimpsest-v2"; graph = $true;  args = @();                              variant = "" }
  @{ name = "baselines";             system = "bm25,fullctx,oracle-session"; graph = $false; args = @();                variant = "" }
  @{ name = "palimpsest-premise";    system = "palimpsest-premise"; graph = $true; args = @();                          variant = "" }
  @{ name = "v2 fast profile";       system = "palimpsest-v2"; graph = $true;  args = @("--profile", "fast");           variant = "" }
  @{ name = "ablation no-select";    system = "palimpsest-v2"; graph = $true;  args = @("--no-select");                 variant = "no-select" }
  @{ name = "ablation no-sufficiency"; system = "palimpsest-v2"; graph = $true; args = @("--no-sufficiency");           variant = "no-sufficiency" }
  @{ name = "ablation no-timescope"; system = "palimpsest-v2"; graph = $true;  args = @("--no-time-scope");             variant = "no-timescope" }
  @{ name = "ablation no-decompose"; system = "palimpsest-v2"; graph = $true;  args = @("--no-decompose");              variant = "no-decompose" }
  @{ name = "ablation no-discovery"; system = "palimpsest-v2"; graph = $true;  args = @("--no-discovery");              variant = "no-discovery" }
  @{ name = "ablation reader-route off"; system = "palimpsest-v2"; graph = $true; args = @("--reader-route", "off");    variant = "no-readerroute" }
  @{ name = "ablation granularity span"; system = "palimpsest-v2"; graph = $true; args = @("--granularity", "span");    variant = "granularity-span" }
  @{ name = "ablation granularity turn"; system = "palimpsest-v2"; graph = $true; args = @("--granularity", "turn");    variant = "granularity-turn" }
)

if ($List) {
  for ($i = 0; $i -lt $runs.Count; $i++) {
    $run = $runs[$i]
    Write-Output ("{0,2}. {1,-26} {2,-14} {3}" -f ($i + 1), $run.name, $(if ($run.graph) { "batched x$Batches" } else { "one pass" }), ($run.args -join " "))
  }
  exit 0
}

$startedAt = Get-Date
for ($i = $From - 1; $i -lt $runs.Count; $i++) {
  $run = $runs[$i]
  $number = $i + 1
  Write-Output ""
  Write-Output ("=== run {0}/{1}: {2} ===" -f $number, $runs.Count, $run.name)

  if ($run.graph) {
    $arguments = @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $batched,
      "-System", $run.system, "-Split", "dev",
      "-Batches", "$Batches", "-Concurrency", "$Concurrency"
    )
    if ($run.args.Count -gt 0) { $arguments += @("-ExtraArgs") + $run.args }
    if ($run.variant -ne "") { $arguments += @("-Variant", $run.variant) }
    & powershell @arguments
    if ($LASTEXITCODE -ne 0) {
      Write-Output ("run {0} failed with exit code {1}; stopping" -f $number, $LASTEXITCODE)
      exit 1
    }
  } else {
    # Unbatched, but still twice: the warm run replays every LLM call from
    # cache and is where the latency column comes from.
    $log = Join-Path $logDirectory ("{0:d2}-{1}.log" -f $number, ($run.name -replace "[^a-z0-9]+", "-"))
    foreach ($pass in @("cold", "warm")) {
      $evalArguments = @(
        "tsx", "packages/eval/bin/eval.ts",
        "--system", $run.system, "--split", "dev", "--concurrency", "$Concurrency"
      ) + $run.args
      $exitCode = Invoke-EvalProcess -ArgumentList $evalArguments -Log "$log.$pass"
      if ($exitCode -ne 0) {
        Write-Output ("run {0} {1} pass failed with exit code {2}; see {3}.{1}" -f $number, $pass, $exitCode, $log)
        exit 1
      }
    }
  }

  Write-Output ("run {0}/{1} done, {2:n1} min elapsed" -f $number, $runs.Count, ((Get-Date) - $startedAt).TotalMinutes)
}

Write-Output ""
Write-Output ("dev programme complete in {0:n1} min" -f ((Get-Date) - $startedAt).TotalMinutes)
