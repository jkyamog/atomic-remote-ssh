/**
 * OpenSandbox command construction + pure stream/endpoint parsing.
 * The lifecycle manager is loopback-only (127.0.0.1:8090) on the target
 * host, so every request is a curl executed on that host over the shared
 * ssh transport. All quoting goes through POSIX single-quote escaping (q).
 * This module imports neither typebox nor @bastani/atomic, so it unit-tests
 * under plain `node --test`.
 */

/** Shell-quote for POSIX sh: `'` -> `'\''`. No command substitution inside. */
export const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

/** OpenSandbox lifecycle manager base URL (loopback-only by design). */
export const MANAGER_BASE = "http://127.0.0.1:8090";

/** POC default API key, sent as the OPEN-SANDBOX-API-KEY header. */
export const DEFAULT_API_KEY = "poc-t13-nyx";

/** execd port inside the sandbox (the service that serves /command). */
export const EXECD_PORT = 44772;

/**
 * sandbox_exec retry policy: the gVisor execd proxy returns 502 (or an empty
 * stream) until it is warm — never fail fast on the first attempt.
 */
export const EXEC_MAX_ATTEMPTS = 5;
export const EXEC_RETRY_DELAY_MS = 5_000;

/** `-H 'OPEN-SANDBOX-API-KEY: <key>'` fragment (header value quoted). */
const apiKeyHeader = (apiKey) => `-H ${q(`OPEN-SANDBOX-API-KEY: ${apiKey}`)}`;

/** `-H 'Content-Type: application/json'` fragment. */
const jsonHeader = () => `-H ${q("Content-Type: application/json")}`;

/** GET /v1/sandboxes — list sandboxes (raw JSON to stdout). */
export function listCommand(apiKey) {
  return `curl -fsS ${apiKeyHeader(apiKey)} ${q(`${MANAGER_BASE}/v1/sandboxes`)}`;
}

/**
 * The exact create payload (JSON.stringify preserves this key order):
 * {"image":{"uri":image},"timeout":timeout??900,
 *  "resourceLimits":{"cpu":cpu??"500m","memory":memory??"512Mi"},
 *  "entrypoint":["sh","-c","while :; do sleep 3600; done"],
 *  "metadata":{"name":name??"atomic-sandbox"}}
 */
export function buildCreatePayload(image, cpu, memory, timeout, name) {
  return JSON.stringify({
    image: { uri: image },
    timeout: timeout ?? 900,
    resourceLimits: { cpu: cpu ?? "500m", memory: memory ?? "512Mi" },
    entrypoint: ["sh", "-c", "while :; do sleep 3600; done"],
    metadata: { name: name ?? "atomic-sandbox" },
  });
}

/** POST /v1/sandboxes — create a sandbox. */
export function createCommand(apiKey, image, cpu, memory, timeout, name) {
  const payload = buildCreatePayload(image, cpu, memory, timeout, name);
  return `curl -fsS -X POST ${apiKeyHeader(apiKey)} ${jsonHeader()} -d ${q(payload)} ${q(`${MANAGER_BASE}/v1/sandboxes`)}`;
}

/** GET /v1/sandboxes/{id}/endpoints/{port}?use_server_proxy=true — execd endpoint. */
export function endpointCommand(apiKey, sandboxId) {
  const url = `${MANAGER_BASE}/v1/sandboxes/${sandboxId}/endpoints/${EXECD_PORT}?use_server_proxy=true`;
  return `curl -fsS ${apiKeyHeader(apiKey)} ${q(url)}`;
}

/**
 * -w write-out suffix that appends the HTTP status on its own line
 * (`\n` is interpreted by curl as a newline). Lets the caller read the
 * status code of a streaming response.
 */
const W_HTTP_CODE = "\\n__HTTP_CODE__:%{http_code}";

/**
 * POST {endpoint}/command — run a command, stream SSE, tag the status code.
 * Deliberately NOT `-f`: a 502 (execd warmup) still completes the transfer,
 * so the status code is observable in the write-out for the retry decision.
 */
export function postCommandCommand(apiKey, endpointUrl, command) {
  const payload = JSON.stringify({ command, background: false, timeout: 30_000 });
  return `curl -sS -X POST ${apiKeyHeader(apiKey)} ${jsonHeader()} -d ${q(payload)} -w '${W_HTTP_CODE}' ${q(endpointUrl + "/command")}`;
}

/** DELETE /v1/sandboxes/{id} — destroy a sandbox. */
export function destroyCommand(apiKey, sandboxId) {
  return `curl -fsS -X DELETE ${apiKeyHeader(apiKey)} ${q(`${MANAGER_BASE}/v1/sandboxes/${sandboxId}`)}`;
}

/**
 * Split a `-w`-tagged curl body into { body, code }. code is the trailing
 * HTTP status string, or null when no tag is present.
 */
export function splitHttpCode(text) {
  const s = String(text);
  const m = s.match(/\r?\n__HTTP_CODE__:(\d+)\s*$/);
  if (!m) return { body: s, code: null };
  return { body: s.slice(0, m.index), code: m[1] };
}

/**
 * Parse an SSE command stream into aggregate output. Each `data:` line is
 * one ServerStreamEvent JSON object:
 *   { type: init|status|error|stdout|stderr|result|execution_complete|...,
 *     text?: string, results?: object, error?: object }
 * stdout/stderr concatenate the `text` of the matching events;
 * executionComplete is set by the `execution_complete` event.
 */
export function parseSse(text) {
  const out = { stdout: "", stderr: "", executionComplete: false, results: null, error: null };
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.startsWith("data:")) continue;
    const data = raw.slice(5).trim();
    if (!data) continue;
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "stdout" && typeof ev.text === "string") out.stdout += ev.text;
    else if (ev.type === "stderr" && typeof ev.text === "string") out.stderr += ev.text;
    else if (ev.type === "execution_complete") out.executionComplete = true;
    else if (ev.type === "result") out.results = ev.results ?? null;
    else if (ev.type === "error") out.error = ev.error ?? ev;
  }
  return out;
}

/**
 * Classify one sandbox_exec attempt:
 *  - "ok"      2xx with output or an execution_complete event
 *  - "warmup"  5xx / no status (proxy not ready) or an empty 2xx stream
 *  - "error"   4xx (a definitive client error — fail fast, do not retry)
 */
export function classifyAttempt(code, parsed) {
  const c = code ? parseInt(code, 10) : 0;
  if (c >= 200 && c < 300) {
    return parsed.stdout !== "" || parsed.stderr !== "" || parsed.executionComplete ? "ok" : "warmup";
  }
  if (c === 0 || c >= 500) return "warmup";
  return "error";
}

/** Pull the endpoint URL out of GET /endpoints/{port} JSON (defensive). */
export function extractEndpoint(text) {
  try {
    const obj = JSON.parse(String(text));
    const s = obj && (obj.endpoint ?? obj.url ?? obj.uri);
    if (typeof s === "string" && s) return s;
  } catch {}
  return null;
}

/** Ensure an absolute URL (execd endpoints may omit the scheme). */
export function normalizeEndpointUrl(s) {
  if (typeof s !== "string" || !s) return null;
  return /^https?:\/\//i.test(s) ? s : "http://" + s;
}

/** Sleep ms, resolving early if the abort signal fires. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * The exact upload metadata part (JSON.stringify preserves this key order
 * and drops undefined owner/group): {"path":remotePath,"mode":mode,
 * "owner":owner,"group":group}.
 * mode is the octal permission digits as a decimal int (644 / 755) —
 * never a raw stat.mode.
 */
export function buildFileMetadata(remotePath, mode, owner, group) {
  return JSON.stringify({ path: remotePath, mode, owner, group });
}

/** stat.mode -> octal permission digits as a decimal int (0o755 -> 755). */
export function modeToOctalInt(statMode) {
  return Number((statMode & 0o777).toString(8));
}

/** Default upload mode from the source file: 755 if any execute bit, else 644. */
export function defaultMode(statMode) {
  return (statMode & 0o111) !== 0 ? 755 : 644;
}

/**
 * POST {endpoint}/files/upload — multipart/form-data, metadata part FIRST
 * (application/json), then the file part read from stdin (`file=@-`; the
 * local bytes ride the ssh leg's stdin). BOTH parts carry a filename:
 * execd reads the parts via FormFile, which ignores bare form fields, so a
 * filename-less metadata part fails with 400 INVALID_FILE_METADATA
 * ("metadata file is missing"). Mirrors the JS SDK wire format exactly
 * (filesystemAdapter.ts: name="metadata", filename="metadata"; name="file",
 * filename=basename(remote_path)). Deliberately NOT `-f`: a 502 (execd
 * warmup) still completes the transfer, so the status code is observable
 * in the write-out for the retry decision.
 */
export function uploadCommand(apiKey, endpointUrl, metadataJson, fileName = "file") {
  const meta = q(`metadata=${metadataJson};type=application/json;filename=metadata`);
  const file = q(`file=@-;type=application/octet-stream;filename=${fileName}`);
  return `curl -sS -X POST ${apiKeyHeader(apiKey)} -F ${meta} -F ${file} -w '${W_HTTP_CODE}' ${q(endpointUrl + "/files/upload")}`;
}

/** GET {endpoint}/files/info?path=... — file metadata after upload. */
export function fileInfoCommand(apiKey, endpointUrl, remotePath) {
  const url = endpointUrl + "/files/info?path=" + encodeURIComponent(remotePath);
  return `curl -fsS ${apiKeyHeader(apiKey)} ${q(url)}`;
}

/**
 * GET {endpoint}/files/download?path=... -> host-side temp file. Tagged with
 * -w so a 502 (warmup) is still observable for the retry decision; on an
 * HTTP error curl -f exits non-zero and leaves no (partial) temp content.
 */
export function downloadCommand(apiKey, endpointUrl, remotePath, tmpPath) {
  const url = endpointUrl + "/files/download?path=" + encodeURIComponent(remotePath);
  return `curl -fsS ${apiKeyHeader(apiKey)} ${q(url)} -o ${q(tmpPath)} -w '${W_HTTP_CODE}'`;
}

/** Host-side temp file name for a pull: /tmp/.atomic-pull-<rand> (rand alphanumeric). */
export function hostTempPath(rand) {
  return `/tmp/.atomic-pull-${rand}`;
}

/** Byte count of a host-side file (redirect form keeps the name out of stdout). */
export function wcCommand(tmpPath) {
  return `wc -c < ${q(tmpPath)}`;
}

/** Host-side sha256 of the temp file (hex digest only). */
export function sha256Command(tmpPath) {
  return `sha256sum ${q(tmpPath)} | cut -d' ' -f1`;
}

/** Full base64 of the host-side file, one line (no wrap, no newline). */
export function base64Command(tmpPath) {
  return `base64 -w0 ${q(tmpPath)}`;
}

/**
 * One base64 chunk, chars [start..end] 1-based inclusive (cut -c semantics).
 * Kept well under the ssh runner's 40 000-char output cap.
 */
export function base64ChunkCommand(tmpPath, start, end) {
  return `base64 -w0 ${q(tmpPath)} | cut -c${start}-${end}`;
}

/** Remove the host-side temp file (idempotent; issued on every path). */
export function cleanupCommand(tmpPath) {
  return `rm -f ${q(tmpPath)}`;
}

/**
 * 1-based inclusive [start, end] ranges covering totalLen chars in steps of
 * size. totalLen 0 -> []; exact multiples end on the boundary; ragged last
 * chunk clamps to totalLen.
 */
export function chunkRanges(totalLen, size = 32_000) {
  const ranges = [];
  for (let start = 1; start <= totalLen; start += size) {
    ranges.push({ start, end: Math.min(start + size - 1, totalLen) });
  }
  return ranges;
}

/**
 * Classify a non-SSE execd attempt from the HTTP status tag alone:
 *  - "ok"      2xx
 *  - "warmup"  5xx / no status (proxy not ready)
 *  - "error"   3xx/4xx (definitive — fail fast, do not retry)
 */
export function classifySimple(code) {
  const c = code ? parseInt(code, 10) : 0;
  if (c >= 200 && c < 300) return "ok";
  if (c === 0 || c >= 500) return "warmup";
  return "error";
}
