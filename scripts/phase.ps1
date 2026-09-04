# Switches the benchmark node between the ingest phase (read cache off) and the
# eval phase (read cache on); the query cap is 120 s in both. Settings and the
# reasons: ops/hydradb/step-load-2026-08.md.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/phase.ps1 -Phase eval

[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet("ingest", "eval")]
  [string] $Phase
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "lib/hydra.psm1") -Force

$result = Set-HydraPhase -Phase $Phase -TimeoutSeconds 180
if (-not $result.ready) { throw "node did not become ready after the switch to $Phase" }

[pscustomobject]@{
  phase = $result.phase
  container_id = $result.container_id
  read_cache_enabled = $result.read_cache_enabled
  max_query_runtime_ms = $result.max_query_runtime_ms
} | ConvertTo-Json -Compress
