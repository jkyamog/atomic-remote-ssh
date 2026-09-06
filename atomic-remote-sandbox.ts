/**
 * atomic-remote-sandbox — OpenSandbox lifecycle + command execution as a
 * plain atomic extension.
 *
 * Four additive tools, each call carrying its own host (the OpenSandbox
 * lifecycle manager is loopback-only at 127.0.0.1:8090 on that host):
 *   - sandbox_list    GET  /v1/sandboxes
 *   - sandbox_create  POST /v1/sandboxes
 *   - sandbox_exec    GET  /v1/sandboxes/{id}/endpoints/44772 (server proxy)
 *                     then POST {endpoint}/command (SSE stdout stream,
 *                     retried through gVisor execd warmup)
 *   - sandbox_destroy DELETE /v1/sandboxes/{id} + list-confirm
 *
 * Shares the atomic-remote-ssh transport (createSshRunner) — no duplicate
 * ssh layer. Auth is the OPEN-SANDBOX-API-KEY header (default poc key).
 */

import { createSshRunner } from "./extensions/atomic-remote-ssh/ssh.ts";
import { registerSandboxTools } from "./extensions/atomic-remote-sandbox/sandbox-tools.ts";

export default function registerRemoteSandbox(pi) {
  const deps = {
    sshExec: createSshRunner(),
  };
  registerSandboxTools(pi, deps);
}
