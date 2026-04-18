# NemoClaw on Kubernetes

> **⚠️ Experimental**: This deployment method is intended for **trying out NemoClaw on Kubernetes**, not for production use. It uses rootless Docker-in-Docker (DinD) to create isolated sandbox environments. Operational requirements (storage, runtime, security policies) vary by cluster configuration.

The sample manifest now uses a few safer defaults out of the box:

- uses rootless DinD (`docker:24-dind-rootless`) — no privileged containers
- interposes a Docker socket proxy between workspace and the daemon, blocking exec, build, and other dangerous API endpoints
- workspace has no direct access to the Docker socket
- disables Kubernetes service account token automounting
- disables service-link environment injection
- runs the workspace container with `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, and `RuntimeDefault` seccomp
- applies NemoClaw's suggested policy presets instead of skipping policy setup
- downloads the installer to a local file with HTTPS-only curl flags before execution

Run [NemoClaw](https://github.com/NVIDIA/NemoClaw) on Kubernetes with GPU inference powered by [Dynamo](https://github.com/ai-dynamo/dynamo) or any OpenAI-compatible endpoint.

---

## Quick Start

### Prerequisites

- Kubernetes cluster with `kubectl` access
- An OpenAI-compatible inference endpoint (Dynamo vLLM, vLLM, etc.)
- Kernel 5.11+ on nodes (required for rootless DinD with overlay2)
- Sufficient node resources (~8GB memory, 2 CPUs for DinD container)

### 1. Deploy NemoClaw

If your compatible endpoint requires an API key, create the optional
`nemoclaw-compatible-api-key` Secret after creating the namespace and before
running `kubectl apply`. The same Secret-backed flow is described again in the
configuration section below.

```bash
kubectl create namespace nemoclaw
kubectl create secret generic nemoclaw-compatible-api-key \
  -n nemoclaw \
  --from-literal=api-key='<your-api-key>'
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/k8s/nemoclaw-k8s.yaml
```

### 2. Check Logs

```bash
kubectl logs -f nemoclaw -n nemoclaw -c workspace
```

Wait for "Onboard complete" message.

### 3. Connect to Your Sandbox

```bash
kubectl exec -it nemoclaw -n nemoclaw -c workspace -- nemoclaw my-assistant connect
```

You're now inside a secure sandbox with an AI agent ready to help.

---

## Configuration

Edit the environment variables in `nemoclaw-k8s.yaml` before deploying:

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNAMO_HOST` | Yes | Inference endpoint for socat proxy (e.g., `vllm-frontend.dynamo.svc:8000`) |
| `NEMOCLAW_ENDPOINT_URL` | Yes | URL the sandbox uses (usually `http://host.openshell.internal:8000/v1`) |
| `COMPATIBLE_API_KEY` | No | Loaded from the optional `nemoclaw-compatible-api-key` Secret; defaults to `dummy` for Dynamo/vLLM when the Secret is absent |
| `NEMOCLAW_MODEL` | Yes | Model name (e.g., `meta-llama/Llama-3.1-8B-Instruct`) |
| `NEMOCLAW_SANDBOX_NAME` | No | Sandbox name (default: `my-assistant`) |
| `NEMOCLAW_POLICY_MODE` | No | Policy preset mode for non-interactive onboarding (default: `suggested`) |

### Optional: Store a Real API Key in a Secret

If your compatible endpoint requires authentication, create the Secret before
you apply the manifest in Step 1:

```bash
kubectl create secret generic nemoclaw-compatible-api-key \
  -n nemoclaw \
  --from-literal=api-key='<your-api-key>'
```

### Example: Custom Endpoint

```yaml
env:
  - name: DYNAMO_HOST
    value: "my-vllm.my-namespace.svc.cluster.local:8000"
  - name: NEMOCLAW_ENDPOINT_URL
    value: "http://host.openshell.internal:8000/v1"
  - name: NEMOCLAW_MODEL
    value: "mistralai/Mistral-7B-Instruct-v0.3"
```

---

## Using NemoClaw

### Access the Workspace Shell

```bash
kubectl exec -it nemoclaw -n nemoclaw -c workspace -- bash
```

### Check Sandbox Status

```bash
kubectl exec nemoclaw -n nemoclaw -c workspace -- nemoclaw list
kubectl exec nemoclaw -n nemoclaw -c workspace -- nemoclaw my-assistant status
```

### Connect to Sandbox

```bash
kubectl exec -it nemoclaw -n nemoclaw -c workspace -- nemoclaw my-assistant connect
```

### Test Inference

From inside the sandbox:

```bash
curl -s https://inference.local/v1/models

curl -s https://inference.local/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"meta-llama/Llama-3.1-8B-Instruct","messages":[{"role":"user","content":"Hello!"}],"max_tokens":50}'
```

### Verify Local Inference

Confirm NemoClaw is using your Dynamo/vLLM endpoint:

```bash
# Check model from sandbox
kubectl exec -it nemoclaw -n nemoclaw -c workspace -- nemoclaw my-assistant connect
sandbox@my-assistant:~$ curl -s https://inference.local/v1/models
# Should show your model (e.g., meta-llama/Llama-3.1-8B-Instruct)

# Compare with Dynamo directly (from workspace)
kubectl exec nemoclaw -n nemoclaw -c workspace -- curl -s http://localhost:8000/v1/models
# Should show the same model

# Check provider configuration
kubectl exec nemoclaw -n nemoclaw -c workspace -- openshell inference get
# Shows: Provider: compatible-endpoint, Model: <your-model>

# Test the agent
sandbox@my-assistant:~$ openclaw agent --agent main -m "What is 7 times 8?"
# Should respond with 56
```

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│                       Kubernetes Cluster                             │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                       NemoClaw Pod                             │  │
│  │                                                                │  │
│  │  ┌──────────────────┐  ┌──────────┐  ┌─────────────────────┐  │  │
│  │  │ Rootless DinD    │  │  Docker   │  │  Workspace          │  │  │
│  │  │                  │  │  Socket   │  │                     │  │  │
│  │  │  ┌────────────┐  │  │  Proxy    │  │  nemoclaw CLI       │  │  │
│  │  │  │    k3s     │  │◄─│          │◄─│  openshell CLI      │  │  │
│  │  │  │   cluster  │  │  │ TCP 2375 │  │                     │  │  │
│  │  │  │            │  │  │          │  │  socat ─────────────│──┼──► Dynamo/vLLM
│  │  │  │  ┌───────┐ │  │  │ Filters: │  │  localhost:8000     │  │  │
│  │  │  │  │Sandbox│ │  │  │  EXEC=0  │  │                     │  │  │
│  │  │  │  └───────┘ │  │  │  BUILD=0 │  │  host.openshell     │  │  │
│  │  │  └────────────┘  │  │          │  │  .internal → socat  │  │  │
│  │  └──────────────────┘  └──────────┘  └─────────────────────┘  │  │
│  │         ▲ unix socket       ▲ tcp://localhost:2375             │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

**How it works:**

1. Rootless DinD runs without privileges — host escape via `nsenter` is blocked
2. A Docker socket proxy filters API access: workspace cannot exec into inner containers or run builds
3. Workspace talks to the proxy over TCP; it has no direct socket access
4. OpenShell creates a nested k3s cluster for sandbox isolation
5. A socat proxy bridges K8s DNS to the nested environment
6. Inside the sandbox, `host.openshell.internal:8000` routes to the inference endpoint

---

## Troubleshooting

### Pod won't start

```bash
kubectl describe pod nemoclaw -n nemoclaw
```

Common issues:

- Insufficient memory (needs ~8GB for DinD)
- Kernel too old for rootless DinD (need 5.11+ for overlay2)

### Docker daemon not starting

```bash
kubectl logs nemoclaw -n nemoclaw -c dind
```

Usually resolves after 30-60 seconds. Rootless DinD may take slightly longer than privileged DinD due to user namespace setup.

### Docker socket proxy issues

```bash
kubectl logs nemoclaw -n nemoclaw -c docker-proxy
```

If workspace reports "Docker not ready" but dind logs look healthy, the proxy may be failing. Check for permission errors (socket access) or port conflicts.

If the NemoClaw installer fails with HTTP 403 errors from Docker, the proxy is blocking an API endpoint the installer needs. Check the proxy logs to see which endpoint was denied, then enable it by setting the corresponding env var to `"1"` in the docker-proxy container.

### Inference not working

Check socat is running:

```bash
kubectl exec nemoclaw -n nemoclaw -c workspace -- pgrep -a socat
```

Test endpoint directly:

```bash
kubectl exec nemoclaw -n nemoclaw -c workspace -- curl -s http://localhost:8000/v1/models
```

---

## Learn More

- [NemoClaw Documentation](https://docs.nvidia.com/nemoclaw)
- [OpenShell](https://github.com/NVIDIA/OpenShell)
- [Dynamo](https://github.com/ai-dynamo/dynamo)
- [OpenClaw](https://openclaw.ai)
