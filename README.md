---
description: Build, publish and deploy the Kubernetes pod information demo.
---

# Kubernetes pod information app

An original, dependency-free Node.js application showing the identity of the
Pod serving a request. It replaces the unavailable `k8slab/podip:1.0` demo
functionally; it does not copy its artwork or change existing lab screenshots.

## What the page shows

* Node name and primary IP address
* Pod name, UID, namespace, primary IP address and service account
* Container HTTP port
* Container CPU requests and limits in millicores (1,000 mCPU = 1 core)
* Container memory requests and limits in bytes
* A fresh request ID and UTC timestamp on each metadata request

The page refreshes every five seconds, with manual refresh and an automatic
refresh toggle. Missing metadata is labeled `Not supplied`, not fabricated.
Failures display an error rather than leaving apparently current values.

The [deployment](deployment.yaml) injects metadata using Kubernetes'
[Downward API](https://kubernetes.io/docs/concepts/workloads/pods/downward-api/).
No Kubernetes API access, RBAC permissions, credentials or service-account
token are needed. Resource values are configured settings at container startup,
not live usage. Always specify requests and limits: Kubernetes can substitute
node allocatable resources for omitted limits referenced by the Downward API.
Environment-based metadata does not update in place when Pod settings change.

> [!WARNING]
> This is a training app that displays internal deployment metadata without
> authentication. Publish the container image publicly, but expose a running
> instance only to your intended lab audience. Do not inject secrets as metadata.

## Files and prerequisites

* [server.js](server.js): HTTP server and environment mapping
* [public](public): original responsive page with no external fonts or scripts
* [Dockerfile](Dockerfile): Node 22 Alpine image, non-root user and health check
* [deployment.yaml](deployment.yaml): three replicas with Downward API injection
* [service.yaml](service.yaml): NodePort `30101`, Service port `80`, container port `8080`
* [test](test): server and browser-controller tests using Node's built-in runner

Use Node.js 22 or later for local execution and tests. Docker Desktop must be
running Linux containers for container builds. Kubernetes deployment requires
`kubectl` connected to the intended lab cluster.

All following workstation commands use PowerShell from this folder. In the
repository, it is `WSPlus Kubernetes Technical Briefing\LOD\Labs\assets\app`.
If uploading to the Skillable VM, copy the complete folder to `C:\k8s\labs\app`.

## Run and test without Docker

No `npm install` is needed: there are no runtime or test dependencies.

```powershell
npm test
npm start
```

For container validation after building the image:

```powershell
powershell -NoProfile -File .\test\container-smoke.ps1 -Image podinfo:local
```

This starts a uniquely named test container, verifies real HTTP responses,
health, non-root identity, read-only filesystem support and graceful shutdown,
then removes only that test container.

For an isolated test cluster where the image is already loaded or pullable:

```powershell
powershell -NoProfile -File .\test\kubernetes-smoke.ps1 -Kubeconfig C:\path\to\test-kubeconfig -Image podinfo:local
```

The Kubernetes check requires an explicit kubeconfig, creates a unique namespace,
compares all displayed values against actual Pod fields, tests Service routing,
and deletes that namespace. It needs NodePort `30101` to be free. Do not point
this test at a shared or production cluster.

Open <http://localhost:8080>. Outside Kubernetes, identity fields are intentionally
missing. Stop the server with **Ctrl+C**. For a local demonstration, set explicit
values before running `npm start`:

```powershell
$env:POD_NAME = "local-demo"
$env:POD_NAMESPACE = "training"
$env:POD_IP = "10.244.0.7"
$env:NODE_NAME = "demo-node"
$env:NODE_IP = "10.240.0.5"
$env:POD_SERVICE_ACCOUNT = "default"
$env:CPU_REQUEST_MILLICORES = "100"
$env:CPU_LIMIT_MILLICORES = "500"
$env:MEMORY_REQUEST_BYTES = "33554432"
$env:MEMORY_LIMIT_BYTES = "134217728"
npm start
```

These values are examples, not discovery of the local machine. Kubernetes
supplies real values when you deploy the provided manifest.

## Build and run the container

```powershell
docker build --pull -t podinfo:local .
docker run --rm --name podinfo-demo -p 8080:8080 --read-only --cap-drop ALL --security-opt no-new-privileges podinfo:local
```

Open <http://localhost:8080>. To supply demonstration metadata in Docker, add
`--env POD_NAME=local-demo` and the other variables before `podinfo:local`.
Plain Docker cannot discover Kubernetes node or Pod information.

The container listens on port `8080` and runs as UID/GID `1000`, not root.
`GET /healthz` is used for container health and Kubernetes readiness/liveness.
`GET /api/info` returns the displayed information as JSON. `GET /` serves the
page. `HEAD` is supported; unsupported methods return `405`.

## Publish to your public registry

Choose a registry you control, create a **public** repository there, and replace
the image reference below. Publishing an image does not automatically make its
repository public. The following Docker Hub example uses the image name `podinfo`:

```powershell
$IMAGE = "docker.io/YOUR_DOCKERHUB_USERNAME/podinfo:1.0.0"
docker login docker.io
docker tag podinfo:local $IMAGE
docker push $IMAGE
```

For another registry, use its login host and complete image reference instead.
Use versioned tags rather than overwriting a tag already used by learners.
Verify anonymous pull access from a separate unsigned-in machine or CI job;
`docker pull` while signed in does not prove a repository is public.

For both x86-64 and ARM64 Kubernetes nodes, build and publish a multi-platform
image instead of tagging the single-platform local build:

```powershell
docker buildx build --platform linux/amd64,linux/arm64 --tag $IMAGE --push .
```

Check that your selected Buildx builder supports both platforms before running.
These commands publish to your registry; they are not executed by the app.

## Deploy to the lab

> [!IMPORTANT]
> The manifests use the existing Module 1 names `sample-dep` and `sample-svc`.
> Applying them updates those lab resources. They do not edit your local
> `Module1` files or any Skillable screenshots. Select the intended namespace.

From this app folder, set `$IMAGE` to your **published public** image and run:

```powershell
$NAMESPACE = "default"
kubectl config current-context
kubectl set image --local -f .\deployment.yaml "sample=$IMAGE" -o yaml |
    kubectl apply -n $NAMESPACE -f -
kubectl apply -n $NAMESPACE -f .\service.yaml
kubectl rollout status deployment/sample-dep -n $NAMESPACE --timeout=180s
kubectl get pods -n $NAMESPACE -l app=sample-dep -o wide
kubectl port-forward -n $NAMESPACE service/sample-svc 8080:80
```

Open <http://localhost:8080> in the VM's browser. Leave port-forwarding running
and press **Ctrl+C** when finished. To inspect the JSON in a second PowerShell
window, use:

```powershell
Invoke-RestMethod http://localhost:8080/api/info
```

The template image `podinfo:local` is for local validation only; the
`kubectl set image --local` command substitutes your published reference before
applying anything. Applying an image-only change to the old Module 1 deployment
is insufficient: the new environment mappings and port must also be applied.
Do not reapply the old Service manifest afterward: its numeric target port `80`
does not match this container's port `8080`.

The Service selects all three replicas. A `kubectl port-forward service/...`
session forwards to one selected Pod, so its Pod name should remain stable.
To demonstrate requests reaching different replicas, access the NodePort
through permitted node networking, or change the Service type to LoadBalancer
and remove `nodePort` when your lab subscription permits it. Refreshes alone
do not guarantee a different replica on every request.

## Troubleshooting and cleanup

```powershell
kubectl describe pods -n $NAMESPACE -l app=sample-dep
kubectl logs -n $NAMESPACE -l app=sample-dep
kubectl get endpointslices -n $NAMESPACE -l kubernetes.io/service-name=sample-svc
```

`ImagePullBackOff` means image lookup, authorization or registry connectivity
failed; check Pod Events. `Not supplied` means the corresponding environment
mapping is absent. Invalid `PORT` or resource values produce a startup error.
Keep the CPU divisors at `1m` and memory divisors at `"1"` when using these
environment variable names.

Delete only the demo resources when finished:

```powershell
kubectl delete -n $NAMESPACE -f .\service.yaml -f .\deployment.yaml
```
