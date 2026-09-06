#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ingest-cycling.ps1 `
#     -Slice 200 -Prefix g3 -Users 3 -RestartAtPercent 70 [-Split dev]

[CmdletBinding()]
param(
  [int] $Slice = 200,
  [string] $Prefix = "g3",
  [int] $Users = 3,
  [ValidateRange(10, 89)]
  [int] $RestartAtPercent = 70,
  [ValidateRange(5, 600)]
  [int] $SampleIntervalSeconds = 15,
  [ValidateRange(1, 100)]
  [int] $MaxCycles = 40,
  [ValidateRange(1, 60)]
  [int] $DrainMinutes = 15,
  [ValidateSet("on", "off")]
  [string] $ReadCache = "off",
  [ValidateSet("", "dev", "test")]
  [string] $Split = "",
  [string] $LogDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "lib/hydra.psm1") -Force

$repositoryRoot = Get-HydraRepositoryRoot
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

$readCacheSetting = if ($ReadCache -eq "on") { "true" } else { "false" }

$startedAt = Get-Date
for ($cycle = 1; $cycle -le $MaxCycles; $cycle++) {
  $node = Set-HydraPhase -Phase ingest -ReadCache $readCacheSetting -Restart:($cycle -gt 1) -TimeoutSeconds 420
  if (-not $node.ready) {
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
  $stopFile = Join-Path $LogDirectory ("cycle-{0:d2}.stop" -f $cycle)
  Remove-Item $stopFile -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath "pnpm.cmd" `
    -ArgumentList (@(
      "ingest-slice", "--slice", "$Slice", "--prefix", "$Prefix", "--users", "$Users", "--skip-existing",
      "--stop-file", $stopFile
    ) + $(if ($Split -ne "") { @("--split", $Split) } else { @() })) `
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
      Write-Output ("cycle {0} : {1:n0} bytes >= ceiling, asking the ingest to finish its in-flight users" -f $cycle, $used)
      Set-Content -Path $stopFile -Value "stop"
      $hardCeiling = [Int64] ($limitBytes * 0.9)
      $deadline = (Get-Date).AddMinutes($DrainMinutes)
      while (-not $process.HasExited -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds $SampleIntervalSeconds
        $sample = @(& docker stats --no-stream --format "{{.MemUsage}}" $containerId)
        if ($LASTEXITCODE -eq 0 -and $sample.Count -gt 0) {
          $used = Convert-DockerMemoryToBytes -Value (([string] $sample[0]).Split("/")[0].Trim())
          if ($used -ge $hardCeiling) { Write-Output ("cycle {0} : {1:n0} bytes >= 90 %, not waiting" -f $cycle, $used); break }
        }
      }
      if ($process.HasExited) {
        Write-Output ("cycle {0} : drained; cycling the node" -f $cycle)
      } else {
        Write-Output ("cycle {0} : still running after the drain window; killing the ingest tree" -f $cycle)
        & taskkill /PID $process.Id /T /F 2>&1 | Out-Null
      }
      $cycledForMemory = $true
      break
    }
  }

  Start-Sleep -Seconds 2
  $tail = if (Test-Path $log) { Get-Content $log -Tail 12 } else { @() }
  foreach ($line in $tail) { Write-Output "  | $line" }

  if (-not $cycledForMemory) {
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
