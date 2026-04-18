// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const K8S_MANIFEST = path.join(ROOT, "k8s", "nemoclaw-k8s.yaml");

describe("security configuration hardening", () => {
  it("hardens the Kubernetes sample manifest with safer defaults", () => {
    const manifest = fs.readFileSync(K8S_MANIFEST, "utf8");
    const workspaceMatch = manifest.match(
      /- name: workspace[\s\S]*?(?=\n\s*-\s*name: |\n\s*initContainers:|\n\s*volumes:|$)/,
    );
    expect(workspaceMatch).not.toBeNull();
    const workspaceSection = workspaceMatch![0];
    expect(manifest).toMatch(/automountServiceAccountToken:\s*false/);
    expect(manifest).toMatch(/enableServiceLinks:\s*false/);
    expect(workspaceSection).toMatch(/allowPrivilegeEscalation:\s*false/);
    expect(workspaceSection).toMatch(/capabilities:\s*[\r\n]+\s*drop:\s*[\r\n]+\s*-\s*ALL/);
    expect(workspaceSection).toMatch(/seccompProfile:\s*[\r\n]+\s*type:\s*RuntimeDefault/);
    expect(manifest).toMatch(/- name: NEMOCLAW_POLICY_MODE[\s\S]*value:\s*"suggested"/);
    expect(manifest).toContain('export COMPATIBLE_API_KEY="${COMPATIBLE_API_KEY:-dummy}"');
    const compatibleApiKeySection = manifest.match(
      /- name: COMPATIBLE_API_KEY[\s\S]*?(?=\n\s*-\s*name: |\n\s*volumeMounts:|\n\s*command:|$)/,
    )?.[0];
    expect(compatibleApiKeySection).toBeTruthy();
    expect(compatibleApiKeySection).toMatch(
      /secretKeyRef:[\s\S]*name:\s*nemoclaw-compatible-api-key/,
    );
    expect(compatibleApiKeySection).toMatch(/optional:\s*true/);
    expect(manifest).toContain("curl --proto '=https' --tlsv1.2 --fail --show-error --silent");
    expect(manifest).toContain("--output /tmp/nemoclaw-install.sh");
    expect(manifest).toContain("chmod 700 /tmp/nemoclaw-install.sh");
    expect(manifest).toContain("bash /tmp/nemoclaw-install.sh");
    expect(manifest).not.toMatch(/curl\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/i);
  });

  it("interposes a docker socket proxy between workspace and the daemon", () => {
    const manifest = fs.readFileSync(K8S_MANIFEST, "utf8");

    // Extract docker-proxy section
    const proxyMatch = manifest.match(
      /- name: docker-proxy[\s\S]*?(?=\n\s{4}-\s*name: |\n\s*initContainers:|\n\s*volumes:|$)/,
    );
    expect(proxyMatch).not.toBeNull();
    const proxySection = proxyMatch![0];

    // Proxy is hardened
    expect(proxySection).toMatch(/allowPrivilegeEscalation:\s*false/);
    expect(proxySection).toMatch(/capabilities:\s*[\r\n]+\s*drop:\s*[\r\n]+\s*-\s*ALL/);
    expect(proxySection).toMatch(/seccompProfile:\s*[\r\n]+\s*type:\s*RuntimeDefault/);
    expect(proxySection).toMatch(/runAsNonRoot:\s*true/);

    // Proxy mounts socket read-only
    expect(proxySection).toMatch(/readOnly:\s*true/);

    // Dangerous Docker API endpoints are denied
    expect(proxySection).toMatch(/name:\s*EXEC[\s\S]*?value:\s*"0"/);
    expect(proxySection).toMatch(/name:\s*BUILD[\s\S]*?value:\s*"0"/);

    // Workspace does NOT mount the docker-socket volume
    const workspaceMatch = manifest.match(
      /- name: workspace[\s\S]*?(?=\n\s{4}-\s*name: |\n\s*initContainers:|\n\s*volumes:|$)/,
    );
    expect(workspaceMatch).not.toBeNull();
    const workspaceSection = workspaceMatch![0];
    expect(workspaceSection).not.toMatch(/name:\s*docker-socket/);

    // Workspace talks to the proxy over TCP, not to the raw socket
    expect(workspaceSection).toMatch(/DOCKER_HOST[\s\S]*?value:\s*tcp:\/\//);
    expect(workspaceSection).not.toMatch(/DOCKER_HOST[\s\S]*?value:\s*unix:\/\//);
  });
});
