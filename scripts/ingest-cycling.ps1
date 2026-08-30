# Runs the population ingest in cycles, restarting the node between them.
#
# Why this exists, measured on 2026-08-31: HydraDB's RSS grows with the write
# *work a process has done*, not with the graph. A resumed ingest took it from
# 5 MiB to 5.06 GiB in half an hour, and a restart took it straight back to
# 4.3 MiB with the same graph underneath -- every engine cache on /metrics
# totalled 430 KB at the peak, so the memory was allocator growth under a
# write-heavy workload and not anything the engine was holding on purpose.
#
# That makes the 200-user population reachable on a 15 GiB host, but only if the
# node is cycled. `--skip-existing` is what makes cycling cheap and safe: every
# write is a content-addressed MERGE, so a user interrupted mid-write completes
# on the next pass, and a user already complete costs one ~100 ms read by id.
#
# The node is restarted with the *ingest* phase settings every cycle (read cache
# off, 120 s query cap) -- see ops/hydradb/step-load-2026-08.md. Switch back to
# eval settings when the population is in.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ingest-cycling.ps1 `
#     -Slice 200 -Prefix g3 -Users 4 -RestartAtPercent 70

[CmdletBinding()]
param(
  [int] $Slice = 200,
  [string] $Prefix = "g3",
  [int] $Users = 3,
  # Well below the capacity gate's 90 %: the point is to cycle the node before
  # the gate has to stop it, so a restart is a scheduled cost rather than an
  # incident.
  [ValidateRange(10, 89)]
  [int] $RestartAtPercent = 70,
  [ValidateRange(5, 600)]
  [int] $SampleIntervalSeconds = 15,
  [ValidateRange(1, 100)]
  [int] $MaxCycles = 40,
  # The object-store read cache during the ingest phase.
  #
  # The ops note turned it off for a reason that no longer holds: with it on,
  # RSS grew ~2 GiB/min and the capacity gate stopped the node in three minutes.
  # Cycling is what handles that now, and with the cache *off* every block
  # compaction reads is an HTTP GET -- MinIO measured 450 % of its six CPUs and
  # 251 GB of network out during an ingest, while HydraDB sat at 164 % of four.
  # Whether trading more frequent restarts for fewer round trips is a net win is
  # a measurement, which is why this is a switch.
  [ValidateSet("on", "off")]
  [string] $ReadCache = "off",
  [string] $LogDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$opsDirectory = Join-Path $repositoryRoot "ops/hydradb"
$composePath = Join-Path $opsDirectory "compose.benchmark.yaml"
$envFile = Join-Path $opsDirectory ".env.benchmark"
if ([string]::IsNullOrWhiteSpace($LogDirectory)) {
  $LogDirectory = Join-Path $repositoryRoot ".ingest-logs"
}
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null

function Convert-DockerMemoryToBytes {
  param([Parameter(Mandatory)][string] $Value)
  if ($Value -notmatch "^\s*(?<number>[0-9]+(?:\.[0-9]+)?)\s*(?<unit>[KMGTPE]?i?B)\s*$") {
    throw "Could not parse Docker memory value '$Value'"
  }
  $factor = switch ($Matches.unit) {
    "B" { 1L } "KiB" { 1KB } "MiB" { 1MB } "GiB" { 1GB } "TiB" { 1TB }
    "KB" { 1000L } "MB" { 1000L * 1000L } "GB" { 1000L * 1000L * 1000L }
    default { throw "Unsupported Docker memory unit '$($Matches.unit)'" }
  }
  return [Int64] ([decimal] $Matches.number * $factor)
}

function Get-HydraContainerId {
  $found = @(
    @(& docker ps --filter "label=com.docker.compose.project=palimpsest-hydradb-benchmark" `
        --filter "label=com.docker.compose.service=hydradb" --format "{{.ID}}") |
      ForEach-Object { ([string] $_).Trim() } | Where-Object { $_.Length -gt 0 }
  )
  if ($found.Count -ne 1) { return $null }
  return $found[0]
}

function Restart-HydraForIngest {
  param([switch] $Force)

  # The two phase-selected settings, every cycle. A node brought up without them
  # would ingest with the read cache on, which is the configuration that took
  # RSS up ~2 GiB a minute during writes.
  $env:PALIMPSEST_HYDRADB_READ_CACHE = if ($ReadCache -eq "on") { "true" } else { "false" }
  $env:PALIMPSEST_HYDRADB_QUERY_RUNTIME_MS = "120000"
  & docker compose --project-directory $opsDirectory --env-file $envFile -f $composePath up -d hydradb | Out-Null

  # `compose up -d` on a service whose configuration has not changed is a no-op,
  # which would make every cycle after the first restart nothing at all -- the
  # one thing this script exists to do. So the process is restarted explicitly.
  # `docker restart` and not `--force-recreate`: recreating would give the
  # container a new id, which the capacity gate watching alongside resolved once
  # at startup, and would reapply the Compose `mem_limit` over any live
  # `docker update`.
  if ($Force) {
    $existing = Get-HydraContainerId
    if ($null -ne $existing) {
      # SIGTERM and wait: the writer lease is only released cleanly on a
      # graceful stop, and a node killed mid-write comes back permanently
      # read-only on this object store (CONTEXT.md, writer lease).
      & docker restart --time 30 $existing | Out-Null
    }
  }

  for ($i = 0; $i -lt 60; $i++) {
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
for ($cycle = 1; $cycle -le $MaxCycles; $cycle++) {
  # The first cycle takes the node as it finds it; every later one is a cycle
  # *because* the previous one hit the memory ceiling, so it must restart.
  $ready = if ($cycle -eq 1) { Restart-HydraForIngest } else { Restart-HydraForIngest -Force }
  if (-not $ready) {
    Write-Output "cycle $cycle : node did not become ready; stopping"
    exit 1
  }
  $containerId = Get-HydraContainerId
  if ($null -eq $containerId) {
    Write-Output "cycle $cycle : no single benchmark HydraDB container; stopping"
    exit 1
  }
  $limitBytes = [Int64] ((& docker inspect $containerId | ConvertFrom-Json)[0].HostConfig.Memory)
  $ceiling = [Int64] ($limitBytes * $RestartAtPercent / 100)

  $log = Join-Path $LogDirectory ("cycle-{0:d2}.log" -f $cycle)
  $errLog = Join-Path $LogDirectory ("cycle-{0:d2}.err.log" -f $cycle)
  $process = Start-Process -FilePath "pnpm.cmd" `
    -ArgumentList "ingest-slice", "--slice", "$Slice", "--prefix", "$Prefix", "--users", "$Users", "--skip-existing" `
    -WorkingDirectory $repositoryRoot -RedirectStandardOutput $log -RedirectStandardError $errLog `
    -WindowStyle Hidden -PassThru
  Write-Output ("cycle {0} started, pid {1}, ceiling {2:n0} bytes of {3:n0}" -f $cycle, $process.Id, $ceiling, $limitBytes)

  $cycledForMemory = $false
  while (-not $process.HasExited) {
    Start-Sleep -Seconds $SampleIntervalSeconds
    if ($process.HasExited) { break }
    $usage = @(& docker stats --no-stream --format "{{.MemUsage}}" $containerId)
    if ($LASTEXITCODE -ne 0 -or $usage.Count -eq 0) { continue }
    $used = Convert-DockerMemoryToBytes -Value (([string] $usage[0]).Split("/")[0].Trim())
    if ($used -ge $ceiling) {
      Write-Output ("cycle {0} : {1:n0} bytes >= ceiling, stopping the ingest and cycling the node" -f $cycle, $used)
      # The ingest is killed, not the node: a user interrupted mid-write
      # completes on the next pass because every write is a content-addressed
      # MERGE, and stopping the *writer* first means the node shuts down with no
      # statement in flight and releases its writer lease cleanly.
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      $cycledForMemory = $true
      break
    }
  }

  Start-Sleep -Seconds 2
  $tail = if (Test-Path $log) { Get-Content $log -Tail 12 } else { @() }
  foreach ($line in $tail) { Write-Output "  | $line" }

  if (-not $cycledForMemory) {
    # The ingest ran to completion. `wall clock` is the last line it prints.
    if (($tail -join "`n") -match "wall clock") {
      $elapsed = ((Get-Date) - $startedAt).TotalMinutes
      Write-Output ("done after {0} cycle(s), {1:n1} min" -f $cycle, $elapsed)
      exit 0
    }
    Write-Output "cycle $cycle : the ingest exited without a summary; see $errLog"
    exit 1
  }
}

Write-Output "stopped after $MaxCycles cycles without completing"
exit 1
