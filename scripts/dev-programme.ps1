# The whole dev programme, in the order the tickets need it.
#
# Every graph-touching run goes through scripts/eval-batched.ps1: twelve batches
# of five questions, the node restarted between them, each batch read cold and
# then warm inside one node lifetime, and the warm pass is what lands in the
# results file. The reason is in ops/hydradb/step-load-2026-08.md -- a read
# costs ~750 MiB of resident memory per distinct user and does not bound, so the
# node holds about seven of the 60 dev users.
#
# `bm25`, `fullctx` and `oracle-session` read the dataset rather than the graph,
# so they run unbatched in one pass and take minutes.
#
# Order is not arbitrary. `palimpsest` and `palimpsest-v2` come first because
# the adoption gate is read from exactly those two, and if the gate is going to
# fail it should fail before eight ablations have been run against it.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev-programme.ps1
#   ... -From 4        # resume at the fourth run
#   ... -List          # print the plan and exit

[CmdletBinding()]
param(
  [ValidateRange(1, 99)]
  [int] $From = 1,
  # Fifteen, not twelve: measured. `palimpsest` peaked at 3.7 GiB per five-user
  # batch and `palimpsest-v2` at **5.19 GiB of 5.5**, because v2 reads more per
  # user — convergence, sub-question walks, Slot probes, a discovery hop and the
  # slot expansion, where v1 reads one walk. Four users a batch keeps a v2 batch
  # near 4 GiB, and the extra three restarts cost about ninety seconds across a
  # run. The cold time is per question and does not change with the batch size;
  # only the restart count does.
  [ValidateRange(1, 99)]
  [int] $Batches = 15,
  [ValidateRange(1, 16)]
  [int] $Concurrency = 2,
  [switch] $List
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$batched = Join-Path $PSScriptRoot "eval-batched.ps1"
$logDirectory = Join-Path $repositoryRoot ".eval-logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

# `variant` must match the suffix `eval` builds from the flags, or the merge
# finds no files. `eval` lower-cases `ablationNames` after inserting a hyphen
# after the leading "no", so `noTimeScope` becomes `no-timescope`.
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
    # No graph reads, so no batching and no priming pass. Still run twice: the
    # second run replays every LLM call from cache, which is where the latency
    # column comes from for these systems too.
    $log = Join-Path $logDirectory ("{0:d2}-{1}.log" -f $number, ($run.name -replace "[^a-z0-9]+", "-"))
    foreach ($pass in @("cold", "warm")) {
      $evalArguments = @(
        "tsx", "packages/eval/bin/eval.ts",
        "--system", $run.system, "--split", "dev", "--concurrency", "$Concurrency"
      ) + $run.args
      $process = Start-Process -FilePath "npx.cmd" -ArgumentList $evalArguments `
        -WorkingDirectory $repositoryRoot -RedirectStandardOutput "$log.$pass" `
        -RedirectStandardError "$log.$pass.err" -WindowStyle Hidden -PassThru -Wait
      if ($process.ExitCode -ne 0) {
        Write-Output ("run {0} {1} pass failed with exit code {2}; see {3}.{1}" -f $number, $pass, $process.ExitCode, $log)
        exit 1
      }
    }
  }

  Write-Output ("run {0}/{1} done, {2:n1} min elapsed" -f $number, $runs.Count, ((Get-Date) - $startedAt).TotalMinutes)
}

Write-Output ""
Write-Output ("dev programme complete in {0:n1} min" -f ((Get-Date) - $startedAt).TotalMinutes)
