[CmdletBinding()]
param(
  # Zero is reserved for deterministic fault-injection tests; the benchmark
  # profile itself supplies the operational 90% threshold.
  [ValidateRange(0, 100)]
  [int] $StopAtPercent,

  [ValidateRange(1, 3600)]
  [int] $SampleIntervalSeconds,

  [ValidateRange(1, 86400)]
  [int] $Samples = 1,

  [ValidateRange(0, 300)]
  [int] $ShutdownTimeoutSeconds = 30,

  [string] $ContainerId,

  [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "lib/hydra.psm1") -Force

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$profilePath = Join-Path $repositoryRoot "ops/hydradb/benchmark-profile.v1.json"
$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
$gate = $profile.capacity_gate

if (-not $PSBoundParameters.ContainsKey("StopAtPercent")) {
  $StopAtPercent = [int] $gate.maximum_memory_utilization_percent
}
if (-not $PSBoundParameters.ContainsKey("SampleIntervalSeconds")) {
  $SampleIntervalSeconds = [int] $gate.sample_interval_seconds
}

function Assert-LastDockerCommand {
  param([Parameter(Mandatory)][string] $Operation)
  if ($LASTEXITCODE -ne 0) {
    throw "docker $Operation failed with exit code $LASTEXITCODE"
  }
}

function Convert-DockerMemoryToBytes {
  param([Parameter(Mandatory)][string] $Value)

  if ($Value -notmatch "^\s*(?<number>[0-9]+(?:\.[0-9]+)?)\s*(?<unit>[KMGTPE]?i?B)\s*$") {
    throw "Could not parse Docker memory value '$Value'"
  }
  $factor = switch ($Matches.unit) {
    "B" { 1L }
    "KiB" { 1KB }
    "MiB" { 1MB }
    "GiB" { 1GB }
    "TiB" { 1TB }
    "PiB" { 1PB }
    "KB" { 1000L }
    "MB" { 1000L * 1000L }
    "GB" { 1000L * 1000L * 1000L }
    "TB" { 1000L * 1000L * 1000L * 1000L }
    default { throw "Unsupported Docker memory unit '$($Matches.unit)'" }
  }
  return [Int64] ([decimal] $Matches.number * $factor)
}

if ([string]::IsNullOrWhiteSpace($ContainerId)) {
  $ContainerId = Get-HydraContainerId
  if ($null -eq $ContainerId) {
    throw "Expected exactly one running benchmark HydraDB container"
  }
}

$container = (& docker inspect $ContainerId | ConvertFrom-Json)[0]
Assert-LastDockerCommand -Operation "inspect capacity-gate container"
if ($null -eq $container) {
  throw "No container found for capacity gate"
}
$configuredLimit = [Int64] $container.HostConfig.Memory
$profileLimit = [Int64] $profile.containers.hydradb.memory_bytes
if ($configuredLimit -ne $profileLimit) {
  throw "Container memory limit $configuredLimit does not match benchmark profile limit $profileLimit"
}

for ($sample = 1; $sample -le $Samples; $sample++) {
  $memoryUsage = @(& docker stats --no-stream --format "{{.MemUsage}}" $ContainerId)
  Assert-LastDockerCommand -Operation "sample container memory"
  $usageText = ([string] $memoryUsage[0]).Split("/")[0].Trim()
  $usedBytes = Convert-DockerMemoryToBytes -Value $usageText
  $utilizationPercent = [Math]::Round(($usedBytes / $configuredLimit) * 100, 2)

  $result = [ordered]@{
    container_id = $container.Id
    sample = $sample
    used_bytes = $usedBytes
    limit_bytes = $configuredLimit
    utilization_percent = $utilizationPercent
    threshold_percent = $StopAtPercent
    action = "continue"
    committed_source_preservation = "delegated_to-durable-s3-runtime"
  }

  if ($utilizationPercent -ge $StopAtPercent) {
    if ($DryRun) {
      $result.action = "would_stop_new_ingestion"
    } else {
      # `stop` sends SIGTERM and waits, allowing the S3-backed runtime to
      # finish its durable shutdown path. It never removes the object-store
      # volume or claims an uncommitted source as committed.
      & docker stop --time $ShutdownTimeoutSeconds $ContainerId | Out-Null
      Assert-LastDockerCommand -Operation "gracefully stop capacity-breached HydraDB container"
      $result.action = "stopped_new_ingestion"
    }
    [pscustomobject] $result | ConvertTo-Json -Compress
    exit 2
  }

  [pscustomobject] $result | ConvertTo-Json -Compress
  if ($sample -lt $Samples) {
    Start-Sleep -Seconds $SampleIntervalSeconds
  }
}
