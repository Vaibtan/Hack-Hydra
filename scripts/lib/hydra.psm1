# Shared runtime for the benchmark HydraDB node: ops/hydradb/step-load-2026-08.md, "Driver scripts".

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
  [CmdletBinding()]
  param([switch] $IncludeStopped)

  $psArgs = @("ps")
  if ($IncludeStopped) { $psArgs += "-a" }
  $psArgs += $script:ContainerFilters + @("--format", "{{.ID}}")
  $found = @(
    @(& docker @psArgs) | ForEach-Object { ([string] $_).Trim() } | Where-Object { $_.Length -gt 0 }
  )
  if ($found.Count -ne 1) { return $null }
  return $found[0]
}

function Wait-HydraReady {
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

function Get-EnvValue([string[]] $Lines, [string] $Name) {
  $line = @($Lines | Where-Object { $_ -like "$Name=*" })
  if ($line.Count -eq 0) { throw "container env has no $Name" }
  return $line[0].Substring($Name.Length + 1)
}

function Set-HydraPhase {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [ValidateSet("ingest", "eval")]
    [string] $Phase,
    [ValidateSet("", "true", "false")]
    [string] $ReadCache = "",
    [ValidateRange(30000, 3600000)]
    [int] $QueryRuntimeMs = 120000,
    [switch] $Restart,
    [ValidateRange(1, 3600)]
    [int] $TimeoutSeconds = 300
  )

  $expectedCache = if ($ReadCache -ne "") { $ReadCache } elseif ($Phase -eq "ingest") { "false" } else { "true" }
  $expectedRuntime = "$QueryRuntimeMs"
  $env:PALIMPSEST_HYDRADB_READ_CACHE = $expectedCache
  $env:PALIMPSEST_HYDRADB_QUERY_RUNTIME_MS = $expectedRuntime

  & docker compose --project-directory $script:OpsDirectory --env-file $script:EnvFile -f $script:ComposePath up -d hydradb | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "docker compose up failed with exit code $LASTEXITCODE" }

  $container = Get-HydraContainerId -IncludeStopped
  if ($null -eq $container) { throw "expected exactly one benchmark HydraDB container" }

  if ($Restart) {
    & docker restart --time 30 $container | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker restart failed with exit code $LASTEXITCODE" }
  }

  $environment = & docker inspect $container --format '{{range .Config.Env}}{{println .}}{{end}}'
  $cache = Get-EnvValue $environment "GRAPH_OBJECT_STORE_CACHE_ENABLED"
  $runtime = Get-EnvValue $environment "GRAPH_MAX_QUERY_RUNTIME_MS"
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
