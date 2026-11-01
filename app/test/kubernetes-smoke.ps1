param(
    [Parameter(Mandatory = $true)]
    [string]$Kubeconfig,
    [string]$Image = "podinfo:local"
)

$ErrorActionPreference = "Stop"
$namespace = "podinfo-test-" + [Guid]::NewGuid().ToString("N").Substring(0, 12)
$app = Split-Path $PSScriptRoot -Parent

function Invoke-Kubectl {
    param([string[]]$KubectlArgs)
    $output = & kubectl --kubeconfig $Kubeconfig @KubectlArgs
    if ($LASTEXITCODE -ne 0) { throw "kubectl $($KubectlArgs -join ' ') failed." }
    return $output
}

try {
    Invoke-Kubectl -KubectlArgs @("create", "namespace", $namespace) | Out-Null
    $manifest = Invoke-Kubectl -KubectlArgs @(
        "set", "image", "--local", "-f", (Join-Path $app "deployment.yaml"),
        "sample=$Image", "-o", "yaml"
    )
    $manifest | & kubectl --kubeconfig $Kubeconfig apply -n $namespace -f -
    if ($LASTEXITCODE -ne 0) { throw "Could not apply the test deployment." }
    Invoke-Kubectl -KubectlArgs @("apply", "-n", $namespace, "-f", (Join-Path $app "service.yaml"))
    Invoke-Kubectl -KubectlArgs @(
        "rollout", "status", "deployment/sample-dep", "-n", $namespace, "--timeout=180s"
    )
    $pods = (Invoke-Kubectl -KubectlArgs @(
        "get", "pods", "-n", $namespace, "-l", "app=sample-dep", "-o", "json"
    ) | ConvertFrom-Json).items
    if ($pods.Count -ne 3) { throw "Expected three demo replicas." }

    foreach ($pod in $pods) {
        $name = $pod.metadata.name
        $info = Invoke-Kubectl -KubectlArgs @(
            "exec", "-n", $namespace, $name, "--", "node", "-e",
            "fetch('http://127.0.0.1:8080/api/info').then(r=>r.text()).then(console.log).catch(e=>{console.error(e);process.exit(1)})"
        ) | ConvertFrom-Json
        $expected = @{
            podName = $name; podUID = $pod.metadata.uid; namespace = $namespace;
            podIP = $pod.status.podIP; nodeName = $pod.spec.nodeName;
            nodeIP = $pod.status.hostIP; serviceAccount = $pod.spec.serviceAccountName;
            cpuRequestMillicores = "100"; cpuLimitMillicores = "500";
            memoryRequestBytes = "33554432"; memoryLimitBytes = "134217728"; containerPort = 8080
        }
        foreach ($field in $expected.Keys) {
            if ($info.$field -ne $expected[$field]) { throw "$name has incorrect Downward API value for $field." }
        }
        if ($pod.spec.automountServiceAccountToken -ne $false) { throw "Service-account token is mounted." }
        if ($pod.spec.containers[0].securityContext.readOnlyRootFilesystem -ne $true) {
            throw "Container root filesystem is writable."
        }
    }

    $serviceInfo = Invoke-Kubectl -KubectlArgs @(
        "exec", "-n", $namespace, $pods[0].metadata.name, "--", "node", "-e",
        "fetch('http://sample-svc/api/info').then(r=>{if(!r.ok)throw new Error(r.status);return r.text()}).then(console.log).catch(e=>{console.error(e);process.exit(1)})"
    ) | ConvertFrom-Json
    if ($serviceInfo.podName -notin $pods.metadata.name) { throw "Service did not route to a demo Pod." }
    if ($serviceInfo.namespace -ne $namespace) { throw "Service routed to the wrong namespace." }
    Write-Output "PASS: three healthy Pods, exact Downward API values, resource units, hardened settings and Service routing."
} finally {
    Invoke-Kubectl -KubectlArgs @("delete", "namespace", $namespace, "--ignore-not-found", "--wait=true") |
        Out-Null
}
