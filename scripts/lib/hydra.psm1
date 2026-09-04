# Shared runtime for the benchmark HydraDB node. Behaviour and numbers:
# ops/hydradb/step-load-2026-08.md.
#
# Native processes go through Start-Process with explicit file redirects, never
# `& npx ... *>&1`. Node prints an ExperimentalWarning (SQLite) on stderr at
# every start, and under $ErrorActionPreference = "Stop" PowerShell turns a
# native command's stderr into a terminating NativeCommandError, which killed
# a driver after its eval had already succeeded. Redirecting to files keeps
# stderr as text; the exit code is the only signal.

Set-StrictMode -Version Latest

$script:RepositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:OpsDirectory = Join-Path $script:RepositoryRoot "ops/hydradb"
$script:ComposePath = Join-Path $script:OpsDirectory "compose.benchmark.yaml"
$script:EnvFile = Join-Path $script:OpsDirectory ".env.benchmark"
$script:ReadyzUri = "http://127.0.0.1:29090/readyz"
$script:ContainerFilters = @(
  "--filter", "label=com.docker.compose.project=palimpsest-hydradb-benchmark",
  "--filter", "label=com.docker.compose.service=hydradb"
)

function Get-HydraRepositoryRoot { return $script:RepositoryRoot }

function Get-HydraContainerId {
  # Returns the id of the single benchmark HydraDB container, or $null when
  # there is not exactly one. -IncludeStopped also matches exited containers
  # (for `docker restart`); without it only a running node is found.
  [CmdletBinding()]
  param([switch] $IncludeStopped)

  $psArgs = @("ps")
  if ($IncludeStopped) { $psArgs += "-a" }
  $psArgs += $script:ContainerFilters + @("--format", "{{.ID}}")
  # `@(...)` wraps the whole pipeline: one container would otherwise come back
  # as a bare string with no `.Count` under StrictMode.
  $found = @(
    @(& docker @psArgs) | ForEach-Object { ([string] $_).Trim() } | Where-Object { $_.Length -gt 0 }
  )
  if ($found.Count -ne 1) { return $null }
  return $found[0]
}

function Wait-HydraReady {
  # Polls until HTTP 200 or the deadline; returns $true / $false.
  [CmdletBinding()]
  param(
    [string] $Uri = $script:ReadyzUri,
    [ValidateRange(1, 3600)]
    [int] $TimeoutSeconds = 180,
    [ValidateRange(1, 60)]
    [int] $ProbeTimeoutSeconds = 5,
    [ValidateRange(50, 60000)]
    [int] $IntervalMilliseconds = 2000
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -Uri $Uri -TimeoutSec $ProbeTimeoutSeconds -UseBasicParsing
      if ($response.StatusCode -eq 200) { return $true }
    } catch {
      Start-Sleep -Milliseconds $IntervalMilliseconds
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Set-HydraPhase {
  # Brings the node up with the phase's settings, optionally restarts it, and
  # verifies from the container's own env that the switch took (`compose up -d`
  # is a no-op on unchanged config). Throws on a mismatch; returns an object
  # whose `ready` says whether /readyz answered within -TimeoutSeconds.
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [ValidateSet("ingest", "eval")]
    [string] $Phase,
    [ValidateSet("", "true", "false")]
    [string] $ReadCache = "",
    [switch] $Restart,
    [ValidateRange(1, 3600)]
    [int] $TimeoutSeconds = 180
  )

  $expectedCache = if ($ReadCache -ne "") { $ReadCache } elseif ($Phase -eq "ingest") { "false" } else { "true" }
  $expectedRuntime = "120000"
  $env:PALIMPSEST_HYDRADB_READ_CACHE = $expectedCache
  $env:PALIMPSEST_HYDRADB_QUERY_RUNTIME_MS = $expectedRuntime

  & docker compose --project-directory $script:OpsDirectory --env-file $script:EnvFile -f $script:ComposePath up -d hydradb | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "docker compose up failed with exit code $LASTEXITCODE" }

  $container = Get-HydraContainerId -IncludeStopped
  if ($null -eq $container) { throw "expected exactly one benchmark HydraDB container" }

  if ($Restart) {
    # --time 30 is SIGTERM and wait: the writer lease is only released on a
    # graceful stop (CONTEXT.md, writer lease). Not a recreate: that changes
    # the container id and reapplies the Compose mem_limit over a live
    # `docker update`.
    & docker restart --time 30 $container | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker restart failed with exit code $LASTEXITCODE" }
  }

  $environment = & docker inspect $container --format '{{range .Config.Env}}{{println .}}{{end}}'
  $cache = ($environment | Select-String -Pattern "^GRAPH_OBJECT_STORE_CACHE_ENABLED=(.*)$").Matches.Groups[1].Value
  $runtime = ($environment | Select-String -Pattern "^GRAPH_MAX_QUERY_RUNTIME_MS=(.*)$").Matches.Groups[1].Value
  if ($cache -ne $expectedCache -or $runtime -ne $expectedRuntime) {
    throw "phase switch to $Phase did not take: read cache $cache (want $expectedCache), query cap $runtime (want $expectedRuntime)"
  }

  return [pscustomobject]@{
    phase = $Phase
    container_id = $container
    read_cache_enabled = $cache
    max_query_runtime_ms = $runtime
    ready = (Wait-HydraReady -TimeoutSeconds $TimeoutSeconds)
  }
}

function Invoke-EvalProcess {
  # Runs a native command to completion with stdout in $Log and stderr in
  # "$Log.err" (see the header); returns the exit code.
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string[]] $ArgumentList,
    [Parameter(Mandatory)][string] $Log,
    [string] $FilePath = "npx.cmd",
    [string] $WorkingDirectory = $script:RepositoryRoot
  )

  $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList `
    -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $Log `
    -RedirectStandardError "$Log.err" -WindowStyle Hidden -PassThru -Wait
  return $process.ExitCode
}

Export-ModuleMember -Function Get-HydraRepositoryRoot, Get-HydraContainerId, Wait-HydraReady, Set-HydraPhase, Invoke-EvalProcess
