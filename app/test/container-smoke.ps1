param(
    [string]$Image = "podinfo:local"
)

$ErrorActionPreference = "Stop"
$container = "podinfo-test-" + [Guid]::NewGuid().ToString("N").Substring(0, 12)

function Invoke-Docker {
    param([string[]]$DockerArgs)
    $output = & docker @DockerArgs
    if ($LASTEXITCODE -ne 0) { throw "docker $($DockerArgs -join ' ') failed." }
    return $output
}

try {
    Invoke-Docker -DockerArgs @(
        "run", "-d", "--name", $container,
        "-p", "127.0.0.1::8080", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "-e", "POD_NAME=smoke-pod", "-e", "POD_UID=smoke-uid",
        "-e", "POD_NAMESPACE=smoke", "-e", "POD_IP=10.244.0.7",
        "-e", "POD_SERVICE_ACCOUNT=default", "-e", "NODE_NAME=smoke-node",
        "-e", "NODE_IP=10.240.0.5", "-e", "CPU_REQUEST_MILLICORES=100",
        "-e", "CPU_LIMIT_MILLICORES=500", "-e", "MEMORY_REQUEST_BYTES=33554432",
        "-e", "MEMORY_LIMIT_BYTES=134217728", $Image
    ) | Out-Null

    $state = $null
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        $state = (Invoke-Docker -DockerArgs @("inspect", $container) | ConvertFrom-Json)[0]
        if (-not $state.State.Running) {
            Invoke-Docker -DockerArgs @("logs", $container)
            throw "Container exited before becoming healthy."
        }
        if ($state.State.Health.Status -eq "healthy") { break }
        Start-Sleep -Seconds 1
    }
    if ($state.State.Health.Status -ne "healthy") { throw "Container did not become healthy." }
    if (-not $state.HostConfig.ReadonlyRootfs) { throw "Container filesystem is not read-only." }
    $uid = Invoke-Docker -DockerArgs @("exec", $container, "id", "-u")
    if ($uid -ne "1000") { throw "Expected non-root UID 1000; got $uid." }

    $port = $state.NetworkSettings.Ports.'8080/tcp'[0].HostPort
    $base = "http://127.0.0.1:$port"
    $first = Invoke-RestMethod "$base/api/info"
    $second = Invoke-RestMethod "$base/api/info"
    $expected = @{
        podName = "smoke-pod"; podUID = "smoke-uid"; namespace = "smoke";
        podIP = "10.244.0.7"; serviceAccount = "default"; nodeName = "smoke-node";
        nodeIP = "10.240.0.5"; cpuRequestMillicores = "100"; cpuLimitMillicores = "500";
        memoryRequestBytes = "33554432"; memoryLimitBytes = "134217728"; containerPort = 8080
    }
    foreach ($field in $expected.Keys) {
        if ($first.$field -ne $expected[$field]) { throw "Incorrect API value for $field." }
    }
    if ($first.requestID -eq $second.requestID) { throw "Request IDs were reused." }
    if ((Invoke-RestMethod "$base/healthz").status -ne "ok") { throw "Health check failed." }
    $page = Invoke-WebRequest -UseBasicParsing $base
    if (-not $page.Content.Contains("Inside this Pod")) { throw "HTML page was not served." }
    if ($page.Headers["Cache-Control"] -ne "no-store") { throw "Page can be cached." }

    Invoke-Docker -DockerArgs @("stop", "--time", "12", $container) | Out-Null
    $state = (Invoke-Docker -DockerArgs @("inspect", $container) | ConvertFrom-Json)[0]
    if ($state.State.ExitCode -ne 0) { throw "Container did not stop gracefully." }
    $logs = Invoke-Docker -DockerArgs @("logs", $container)
    if (($logs -join "`n") -notmatch "Shutting down HTTP server") {
        throw "SIGTERM shutdown handler was not executed."
    }
    Write-Output "PASS: real container metadata, UI, health, non-root UID, read-only filesystem and graceful shutdown."
} finally {
    & docker rm -f $container | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to remove owned test container $container." }
}
