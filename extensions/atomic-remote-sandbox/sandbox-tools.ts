/**
 * OpenSandbox tools: sandbox_list / sandbox_create / sandbox_exec /
 * sandbox_destroy. Every call rides the shared ssh transport (deps.sshExec)
 * and hits the loopback lifecycle manager (127.0.0.1:8090) on the target
 * host. Style mirrors remote-tools.ts: typebox params, mid() result wrapper,
 * capOutput on big bodies.
 */

import { Type } from "typebox";
import { capOutput } from "../atomic-remote-ssh/ssh.ts";
import {
  DEFAULT_API_KEY,
  EXEC_MAX_ATTEMPTS,
  EXEC_RETRY_DELAY_MS,
  listCommand,
  createCommand,
  endpointCommand,
  postCommandCommand,
  destroyCommand,
  splitHttpCode,
  parseSse,
  classifyAttempt,
  extractEndpoint,
  normalizeEndpointUrl,
  sleep,
} from "./commands.ts";

const mid = (text) => ({ content: [{ type: "text", text }] });
const apiKeyOf = (params) => params.api_key ?? DEFAULT_API_KEY;
const HOST_DESC = "SSH target, user@host (OpenSandbox manager at 127.0.0.1:8090)";
const KEY_DESC = `OPEN-SANDBOX-API-KEY (default ${DEFAULT_API_KEY})`;

export function registerSandboxTools(pi, deps) {
  const exec = deps.sshExec.exec;
  // Retry knobs are injectable (tests use tiny values); defaults are the
  // required gVisor-execd-warmup policy: 5 attempts, 5 s apart.
  const maxAttempts = deps.maxAttempts ?? EXEC_MAX_ATTEMPTS;
  const retryDelayMs = deps.retryDelayMs ?? EXEC_RETRY_DELAY_MS;

  pi.registerTool({
    name: "sandbox_list",
    description:
      "List OpenSandbox sandboxes on the host (GET /v1/sandboxes). Returns the raw manager JSON.",
    parameters: Type.Object({
      host: Type.String({ description: HOST_DESC }),
      api_key: Type.Optional(Type.String({ description: KEY_DESC })),
    }),
    async execute(_id, params, signal) {
      try {
        const r = await exec(params.host, listCommand(apiKeyOf(params)), { signal, timeoutMs: 30_000 });
        if (r.exitCode !== 0) return mid(`sandbox_list FAILED: ${r.stderr || `exit=${r.exitCode}`}`);
        return mid(capOutput(r.stdout));
      } catch (e) {
        return mid(`sandbox_list FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "sandbox_create",
    description:
      "Create an OpenSandbox from a container image (POST /v1/sandboxes). " +
      "Returns the sandbox id + status.state, then the raw response JSON.",
    parameters: Type.Object({
      host: Type.String({ description: HOST_DESC }),
      image: Type.String({ description: "Container image uri" }),
      cpu: Type.Optional(Type.String({ description: 'CPU limit, e.g. "500m" (default 500m)' })),
      memory: Type.Optional(Type.String({ description: 'Memory limit, e.g. "512Mi" (default 512Mi)' })),
      timeout: Type.Optional(Type.Number({ description: "Sandbox TTL in seconds (default 900)" })),
      name: Type.Optional(Type.String({ description: "Metadata name (default atomic-sandbox)" })),
      api_key: Type.Optional(Type.String({ description: KEY_DESC })),
    }),
    async execute(_id, params, signal) {
      const cmd = createCommand(apiKeyOf(params), params.image, params.cpu, params.memory, params.timeout, params.name);
      // Image pulls can be slow (long docker pulls on slow upstreams).
      try {
        const r = await exec(params.host, cmd, { signal, timeoutMs: 1_800_000 });
        if (r.exitCode !== 0) return mid(`sandbox_create FAILED: ${r.stderr || `exit=${r.exitCode}`}`);
        let id = null;
        let state = null;
        try {
          const j = JSON.parse(r.stdout);
          id = j.id ?? null;
          state = j.status && j.status.state ? j.status.state : null;
        } catch {}
        return mid(`created id=${id} state=${state}\n${capOutput(r.stdout)}`);
      } catch (e) {
        return mid(`sandbox_create FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "sandbox_exec",
    description:
      "Run a command in an OpenSandbox via its server-proxied execd endpoint. " +
      "Concatenates the stdout SSE stream and reports execution_complete. " +
      `Retries up to ${EXEC_MAX_ATTEMPTS} attempts, ${EXEC_RETRY_DELAY_MS / 1000}s apart, on 502 or an ` +
      "empty stream (gVisor execd warmup — never fails fast on the first attempt).",
    parameters: Type.Object({
      host: Type.String({ description: HOST_DESC }),
      sandbox_id: Type.String({ description: "Sandbox id" }),
      command: Type.String({ description: "Shell command to run inside the sandbox" }),
      api_key: Type.Optional(Type.String({ description: KEY_DESC })),
    }),
    async execute(_id, params, signal) {
      const apiKey = apiKeyOf(params);

      // 1. Resolve the server-proxied execd endpoint for this sandbox.
      let endpointUrl;
      try {
        const r = await exec(params.host, endpointCommand(apiKey, params.sandbox_id), { signal, timeoutMs: 30_000 });
        if (r.exitCode !== 0) return mid(`sandbox_exec FAILED (endpoint): ${r.stderr || `exit=${r.exitCode}`}`);
        endpointUrl = normalizeEndpointUrl(extractEndpoint(r.stdout));
        if (!endpointUrl) return mid(`sandbox_exec FAILED: no endpoint in response: ${capOutput(r.stdout).slice(0, 400)}`);
      } catch (e) {
        return mid(`sandbox_exec FAILED (endpoint): ${e instanceof Error ? e.message : String(e)}`);
      }

      // 2. POST the command; retry on warmup (502 / empty stream).
      const cmd = postCommandCommand(apiKey, endpointUrl, params.command);
      let last = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let r;
        try {
          r = await exec(params.host, cmd, { signal, timeoutMs: 60_000 });
        } catch (e) {
          return mid(`sandbox_exec FAILED: ${e instanceof Error ? e.message : String(e)}`);
        }
        const { body, code } = splitHttpCode(r.stdout);
        const parsed = parseSse(body);
        const verdict = classifyAttempt(code, parsed);
        if (verdict === "ok") {
          const out = [
            parsed.stdout,
            parsed.stderr ? `[stderr]\n${parsed.stderr}` : "",
            parsed.error ? `[error] ${JSON.stringify(parsed.error)}` : "",
          ].filter(Boolean).join("\n");
          return mid(capOutput(`${out || "(no output)"}\n[execution_complete: ${parsed.executionComplete}]`));
        }
        if (verdict === "error") {
          return mid(`sandbox_exec FAILED (http=${code}): ${capOutput(body || r.stderr).slice(0, 2_000)}`);
        }
        // warmup: remember and retry (if attempts remain)
        last = { code, parsed, body, stderr: r.stderr };
        if (attempt < maxAttempts) await sleep(retryDelayMs, signal);
      }
      const detail = capOutput(`${last.parsed.stdout}${last.parsed.stderr}${last.body || ""}${last.stderr || ""}`);
      return mid(`sandbox_exec FAILED after ${maxAttempts} attempts (last http=${last.code}): ${detail.slice(0, 2_000) || "no output"}`);
    },
  });

  pi.registerTool({
    name: "sandbox_destroy",
    description:
      "Destroy an OpenSandbox (DELETE /v1/sandboxes/{id}), then re-list to confirm the id is gone.",
    parameters: Type.Object({
      host: Type.String({ description: HOST_DESC }),
      sandbox_id: Type.String({ description: "Sandbox id" }),
      api_key: Type.Optional(Type.String({ description: KEY_DESC })),
    }),
    async execute(_id, params, signal) {
      const apiKey = apiKeyOf(params);
      try {
        const r = await exec(params.host, destroyCommand(apiKey, params.sandbox_id), { signal, timeoutMs: 30_000 });
        if (r.exitCode !== 0) return mid(`sandbox_destroy FAILED: ${r.stderr || `exit=${r.exitCode}`}`);
        // Confirm the id is gone from the list.
        const l = await exec(params.host, listCommand(apiKey), { signal, timeoutMs: 30_000 });
        if (l.exitCode !== 0) return mid(`sandbox_destroy: deleted, but list confirm failed: ${l.stderr || `exit=${l.exitCode}`}`);
        let gone = false;
        try {
          const j = JSON.parse(l.stdout);
          const items = Array.isArray(j.items) ? j.items : Array.isArray(j) ? j : [];
          gone = !items.some((s) => s && s.id === params.sandbox_id);
        } catch {
          gone = !l.stdout.includes(params.sandbox_id);
        }
        return mid(gone ? `destroyed ${params.sandbox_id} (confirmed gone)` : `destroyed ${params.sandbox_id} (STILL LISTED)`);
      } catch (e) {
        return mid(`sandbox_destroy FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });
}
