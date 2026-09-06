/**
 * Shared execd helpers for the OpenSandbox tools: server-proxied endpoint
 * resolution + the warmup retry loop. The gVisor execd proxy answers 502
 * BACKEND_CONNECTION_FAILED (or no status) while cold on every proxied
 * endpoint — /command and /files alike — so the retry policy is shared.
 * sandbox_exec classifies attempts over the execd event stream
 * (classifyAttempt + parseSse; every executed command ends in an
 * execution_complete event, even a no-output one); the file tools classify
 * on the status tag alone (classifySimple). This module
 * imports only ./commands.ts and the ssh transport's capOutput — no cycles.
 */

import { capOutput } from "../atomic-remote-ssh/ssh.ts";
import {
  EXEC_MAX_ATTEMPTS,
  EXEC_RETRY_DELAY_MS,
  endpointCommand,
  splitHttpCode,
  extractEndpoint,
  normalizeEndpointUrl,
  sleep,
} from "./commands.ts";

/**
 * GET /v1/sandboxes/{id}/endpoints/44772?use_server_proxy=true and
 * normalize the URL. Returns { ok: true, endpointUrl } or
 * { ok: false, message } — the message carries the tool name so callers
 * can relay it verbatim (byte-identical to the pre-extraction strings).
 */
export async function resolveEndpoint(exec, o) {
  const { host, apiKey, sandboxId, signal, tool } = o;
  let r;
  try {
    r = await exec(host, endpointCommand(apiKey, sandboxId), { signal, timeoutMs: 30_000 });
  } catch (e) {
    return { ok: false, message: `${tool} FAILED (endpoint): ${e instanceof Error ? e.message : String(e)}` };
  }
  if (r.exitCode !== 0) {
    return { ok: false, message: `${tool} FAILED (endpoint): ${r.stderr || `exit=${r.exitCode}`}` };
  }
  const url = normalizeEndpointUrl(extractEndpoint(r.stdout));
  if (!url) {
    return { ok: false, message: `${tool} FAILED: no endpoint in response: ${capOutput(r.stdout).slice(0, 400)}` };
  }
  return { ok: true, endpointUrl: url };
}

/**
 * Run one host-side curl per attempt until the classifier verdicts.
 * classify(code, body) -> "ok" | "warmup" | "error".
 *  - "ok"      -> { ok: true, result, code, body } (result = raw exec result)
 *  - "error"   -> { ok: false, kind: "error", code, body, stderr } (fail fast)
 *  - "warmup"  -> sleep(retryDelayMs) and retry, if attempts remain
 * An exec throw (ssh-layer failure) -> { ok: false, kind: "ssh", message },
 * no retry — matches sandbox_exec's current behavior.
 * Exhausted -> { ok: false, kind: "exhausted", attempts, code, body, stderr }.
 */
export async function withRetry(exec, o) {
  const maxAttempts = o.maxAttempts ?? EXEC_MAX_ATTEMPTS;
  const retryDelayMs = o.retryDelayMs ?? EXEC_RETRY_DELAY_MS;
  const timeoutMs = o.timeoutMs ?? 60_000;
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let r;
    try {
      r = await exec(o.host, o.cmd, { signal: o.signal, timeoutMs, stdinText: o.stdinText });
    } catch (e) {
      return { ok: false, kind: "ssh", message: e instanceof Error ? e.message : String(e) };
    }
    const { body, code } = splitHttpCode(r.stdout);
    const verdict = o.classify(code, body);
    if (verdict === "ok") {
      return { ok: true, result: r, code, body };
    }
    if (verdict === "error") {
      return { ok: false, kind: "error", code, body, stderr: r.stderr };
    }
    // warmup: remember and retry (if attempts remain)
    last = { code, body, stderr: r.stderr };
    if (attempt < maxAttempts) await sleep(retryDelayMs, o.signal);
  }
  return { ok: false, kind: "exhausted", attempts: maxAttempts, code: last.code, body: last.body, stderr: last.stderr };
}
