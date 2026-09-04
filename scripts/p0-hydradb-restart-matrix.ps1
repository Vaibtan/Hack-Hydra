[CmdletBinding()]
param(
  [ValidateRange(1, 100)]
  [int] $CleanRestartCycles = 20,

  [ValidateRange(1, 100)]
  [int] $ForcedRestartCycles = 10,

  [string] $HydraImage = "palimpsest/hydradb:6a2fbb1",

  [string] $ExpectedSourceRevision = "6a2fbb192f37f51a93690a2ae2d2f5e27e6e4219",

  [string] $ExpectedSourcePatchSha256 = "6c711ec5c63b42b99620600f8bd09c146e6b9e83d670562e331a6610ebac6638",

  [switch] $KeepArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "lib/hydra.psm1") -Force

# This matrix never connects to, mounts, copies, or modifies the benchmark
# HydraDB volume. Its MinIO data is an in-memory filesystem and both containers
# are uniquely named and removed by default.
$MinioImage = "minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e"
$McImage = "minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727"
$WriterLeaseMilliseconds = 3000
$runId = [guid]::NewGuid().ToString("N")
$networkName = "palimpsest-p0-$runId"
$minioName = "palimpsest-p0-minio-$runId"
$hydraName = "palimpsest-p0-hydradb-$runId"
$bucketName = "palimpsest-p0-$runId"
$provenanceContainerNames = @(
  "palimpsest-p0-provenance-a-$runId",
  "palimpsest-p0-provenance-b-$runId"
)

function New-TestToken {
  param([ValidateRange(8, 128)][int] $ByteCount = 32)

  $bytes = [byte[]]::new($ByteCount)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

# The harness makes a unique credential set for every disposable environment.
# It deliberately never reads project, Docker, or user credentials.
$TestAccessKey = "p0$(New-TestToken -ByteCount 12)"
$TestSecretKey = New-TestToken -ByteCount 32
$TestAuthToken = New-TestToken -ByteCount 32

function Assert-Docker {
  param([Parameter(Mandatory)][string] $Operation)

  if ($LASTEXITCODE -ne 0) {
    throw "docker $Operation failed with exit code $LASTEXITCODE"
  }
}

function Get-PublishedUri {
  param(
    [Parameter(Mandatory)][string] $Container,
    [Parameter(Mandatory)][int] $ContainerPort
  )

  # Docker reports a randomly assigned host port as a line such as
  # "127.0.0.1:63147". Materialize that native-command output before calling
  # string members: a parenthesized pipeline can otherwise yield $null under
  # StrictMode even though `docker port` succeeded.
  $bindings = @(& docker port $Container "$($ContainerPort)/tcp")
  $binding = if ($bindings.Count -gt 0) { ([string] $bindings[0]).Trim() } else { $null }
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($binding)) {
    throw "No host binding found for $Container port $ContainerPort"
  }
  return "http://$binding"
}

function Wait-ForHttp {
  param(
    [Parameter(Mandatory)][string] $Uri,
    [int] $TimeoutSeconds = 60
  )

  if (-not (Wait-HydraReady -Uri $Uri -TimeoutSeconds $TimeoutSeconds -ProbeTimeoutSeconds 2 -IntervalMilliseconds 250)) {
    throw "Timed out waiting for $Uri"
  }
}

function Assert-DisabledCacheMetrics {
  param([Parameter(Mandatory)][string] $AdminUri)

  $metrics = (Invoke-WebRequest -UseBasicParsing -Uri "$AdminUri/metrics" -TimeoutSec 5).Content
  foreach ($expected in @(
    "graph_object_store_cache_enabled 0",
    "graph_object_store_cache_event_queue_depth 0",
    "graph_object_store_cache_events_dropped_total 0",
    "# TYPE graph_storage_l0_sst_backlog gauge",
    "# TYPE graph_storage_compaction_in_progress_bytes gauge",
    "# TYPE graph_storage_compaction_last_success_timestamp_seconds gauge",
    "# TYPE graph_storage_gc_cycles_total counter",
    "# TYPE graph_storage_gc_deleted_objects_total counter",
    "# TYPE graph_storage_maintenance_object_store_failures_total counter"
  )) {
    if (-not $metrics.Contains($expected)) {
      throw "Disabled-cache metric '$expected' was absent from $AdminUri/metrics"
    }
  }
}

function Assert-ImageProvenance {
  param([Parameter(Mandatory)] $Image)

  $reportedImageIds = @()
  foreach ($container in $provenanceContainerNames) {
    # `docker create` keeps the test read-only with respect to the image and
    # object store while proving each fresh container inherits the expected
    # image id and OCI source labels.
    & docker create --name $container --label "palimpsest.scope=p0-restart-matrix" $HydraImage | Out-Null
    Assert-Docker -Operation "create provenance container $container"
    $record = (& docker container inspect $container | ConvertFrom-Json)[0]
    if ($record.Image -ne $Image.Id) {
      throw "Fresh container $container did not inherit expected image id $($Image.Id)"
    }
    if ($record.Config.Labels."org.opencontainers.image.revision" -ne $ExpectedSourceRevision) {
      throw "Fresh container $container did not inherit reviewed source revision $ExpectedSourceRevision"
    }
    if ($record.Config.Labels."io.palimpsest.hydradb.source-patch-sha256" -ne $ExpectedSourcePatchSha256) {
      throw "Fresh container $container did not inherit the reviewed remediation patch fingerprint"
    }
    $reportedImageIds += $record.Image
  }

  if (@($reportedImageIds | Select-Object -Unique).Count -ne 1) {
    throw "Fresh provenance containers reported divergent image metadata"
  }
  return $reportedImageIds
}

function Start-Hydra {
  & docker run -d --name $hydraName --network $networkName --memory 2g --memory-swap 2g --restart on-failure:3 `
    --label "palimpsest.scope=p0-restart-matrix" `
    -p "127.0.0.1::8443" -p "127.0.0.1::9090" `
    -e "CLOUD_PROVIDER=aws" `
    -e "AWS_BUCKET_NAME=$bucketName" `
    -e "AWS_DEFAULT_REGION=us-east-1" `
    -e "AWS_ENDPOINT=http://$($minioName):9000" `
    -e "AWS_ALLOW_HTTP=true" `
    -e "AWS_ACCESS_KEY_ID=$TestAccessKey" `
    -e "AWS_SECRET_ACCESS_KEY=$TestSecretKey" `
    -e "GRAPH_NAMESPACE=default" `
    -e "GRAPH_ID=default" `
    -e "GRAPH_CELL_ID=cell-0" `
    -e "GRAPH_CELLS=cell-0" `
    -e "GRAPH_NODE_ID=node-p0" `
    -e "GRAPH_BOLT_NODE_ADDRESSES=node-p0=$($hydraName):7687" `
    -e "GRAPH_ADVERTISED_BOLT_ADDR=$($hydraName):7687" `
    -e "GRAPH_DATA_CACHE_DIR=/tmp/palimpsest-cache" `
    -e "GRAPH_DATA_CACHE_BYTES=67108864" `
    -e "GRAPH_OBJECT_STORE_CACHE_ENABLED=false" `
    -e "GRAPH_AUTH_TOKEN_FILE=/tmp/palimpsest-auth-token" `
    -e "GRAPH_ALLOW_PLAINTEXT=true" `
    -e "GRAPH_WRITER_LEASE_MS=$WriterLeaseMilliseconds" `
    -e "RUST_MIN_STACK=33554432" `
    --entrypoint /bin/sh $HydraImage `
    -c "printf %s $TestAuthToken >/tmp/palimpsest-auth-token; exec /usr/local/bin/graph-node" | Out-Null
  Assert-Docker -Operation "run HydraDB"

  $running = (& docker container inspect --format "{{.State.Running}}" $hydraName).Trim()
  if ($running -ne "true") {
    $logs = & docker logs $hydraName --tail 50
    throw "HydraDB exited during launch: $($logs -join [Environment]::NewLine)"
  }

  $adminUri = Get-PublishedUri -Container $hydraName -ContainerPort 9090
  Wait-ForHttp -Uri "$adminUri/readyz"
  Assert-DisabledCacheMetrics -AdminUri $adminUri
  return Get-PublishedUri -Container $hydraName -ContainerPort 8443
}

function Write-Probe {
  param(
    [Parameter(Mandatory)][string] $QueryUri,
    [Parameter(Mandatory)][int] $Ordinal
  )

  $request = @{
    cell_id = "cell-0"
    query_id = "p0-restart-matrix-$runId-$Ordinal-$([guid]::NewGuid())"
    query = "UNWIND `$rows AS row MERGE (n {id: row.id}) SET n:P0RestartProbe, n.pkey = row.pkey"
    parameters = @{ rows = @(@{ id = 900000000 + $Ordinal; pkey = "p0|restart|$runId|$Ordinal" }) }
  } | ConvertTo-Json -Depth 8 -Compress
  $headers = @{
    Authorization = "Bearer $TestAuthToken"
    "X-Graph-Namespace" = "default"
    "Content-Type" = "application/json"
  }
  $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$QueryUri/v1/graphs/default/query" -Headers $headers -Body $request
  if ($response.StatusCode -ne 200) {
    throw "Probe write $Ordinal returned HTTP $($response.StatusCode)"
  }
}

function Wait-ForWriterRecovery {
  param(
    [Parameter(Mandatory)][string] $QueryUri,
    [Parameter(Mandatory)][int] $Ordinal
  )

  # A killed process leaves a valid writer lease for its short TTL. A correct
  # restart must fail closed during that interval, then take over through S3's
  # conditional update rather than requiring lease-file surgery.
  $deadline = [DateTime]::UtcNow.AddMilliseconds($WriterLeaseMilliseconds * 4)
  do {
    try {
      Write-Probe -QueryUri $QueryUri -Ordinal $Ordinal
      return
    } catch {
      Start-Sleep -Milliseconds 250
    }
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "Writer did not recover within $($WriterLeaseMilliseconds * 4)ms after forced restart"
}

function Remove-IsolatedArtifacts {
  foreach ($container in @($hydraName, $minioName) + $provenanceContainerNames) {
    $exists = & docker container ls -a --format "{{.Names}}" | Where-Object { $_ -eq $container }
    if ($null -ne $exists) {
      & docker rm -f $container | Out-Null
    }
  }
  $network = & docker network ls --format "{{.Name}}" | Where-Object { $_ -eq $networkName }
  if ($null -ne $network) {
    & docker network rm $networkName | Out-Null
  }
}

try {
  $image = (& docker image inspect $HydraImage | ConvertFrom-Json)[0]
  if ($null -eq $image) {
    throw "Required image $HydraImage is not available. Build it from vendor/hydradb before running this matrix."
  }
  if ($image.Config.Labels."org.opencontainers.image.revision" -ne $ExpectedSourceRevision) {
    throw "Image $HydraImage is not labelled with reviewed source revision $ExpectedSourceRevision"
  }
  if ($image.Config.Labels."io.palimpsest.hydradb.source-patch-sha256" -ne $ExpectedSourcePatchSha256) {
    throw "Image $HydraImage is not labelled with the reviewed remediation patch fingerprint"
  }
  $provenanceImageIds = Assert-ImageProvenance -Image $image

  & docker network create $networkName | Out-Null
  Assert-Docker -Operation "create isolated network"
  & docker run -d --name $minioName --network $networkName --tmpfs "/data:rw,size=1g" `
    --label "palimpsest.scope=p0-restart-matrix" `
    -p "127.0.0.1::9000" `
    -e "MINIO_ROOT_USER=$TestAccessKey" `
    -e "MINIO_ROOT_PASSWORD=$TestSecretKey" `
    $MinioImage server /data | Out-Null
  Assert-Docker -Operation "run MinIO"

  $minioUri = Get-PublishedUri -Container $minioName -ContainerPort 9000
  Wait-ForHttp -Uri "$minioUri/minio/health/ready"
  & docker run --rm --entrypoint /bin/sh --network $networkName $McImage -c "mc alias set local http://$minioName`:9000 $TestAccessKey $TestSecretKey >/dev/null && mc mb --ignore-existing local/$bucketName >/dev/null" | Out-Null
  Assert-Docker -Operation "create MinIO bucket"

  $queryUri = Start-Hydra
  $ordinal = 0
  Write-Probe -QueryUri $queryUri -Ordinal (++$ordinal)

  for ($cycle = 1; $cycle -le $CleanRestartCycles; $cycle++) {
    & docker stop --timeout 30 $hydraName | Out-Null
    Assert-Docker -Operation "clean-stop cycle $cycle"
    & docker start $hydraName | Out-Null
    Assert-Docker -Operation "clean-start cycle $cycle"
    $adminUri = Get-PublishedUri -Container $hydraName -ContainerPort 9090
    Wait-ForHttp -Uri "$adminUri/readyz"
    Assert-DisabledCacheMetrics -AdminUri $adminUri
    $queryUri = Get-PublishedUri -Container $hydraName -ContainerPort 8443
    Write-Probe -QueryUri $queryUri -Ordinal (++$ordinal)
  }

  for ($cycle = 1; $cycle -le $ForcedRestartCycles; $cycle++) {
    & docker kill $hydraName | Out-Null
    Assert-Docker -Operation "forced-stop cycle $cycle"
    & docker start $hydraName | Out-Null
    Assert-Docker -Operation "forced-start cycle $cycle"
    $adminUri = Get-PublishedUri -Container $hydraName -ContainerPort 9090
    Wait-ForHttp -Uri "$adminUri/readyz"
    Assert-DisabledCacheMetrics -AdminUri $adminUri
    $queryUri = Get-PublishedUri -Container $hydraName -ContainerPort 8443
    Wait-ForWriterRecovery -QueryUri $queryUri -Ordinal (++$ordinal)
  }

  [pscustomobject]@{
    status = "passed"
    hydra_image_id = $image.Id
    fresh_container_image_ids = $provenanceImageIds
    source_revision = $ExpectedSourceRevision
    source_patch_sha256 = $ExpectedSourcePatchSha256
    minio_image = $MinioImage
    clean_restart_cycles = $CleanRestartCycles
    forced_restart_cycles = $ForcedRestartCycles
    writer_lease_ms = $WriterLeaseMilliseconds
    writes = $ordinal
  } | ConvertTo-Json -Compress
} finally {
  if (-not $KeepArtifacts) {
    Remove-IsolatedArtifacts
  }
}
