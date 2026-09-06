/**
 * OpenSandbox file-transfer tools: sandbox_push (controller -> sandbox) and
 * sandbox_pull (sandbox -> controller). The OpenSandbox execd files API does
 * the file semantics (POST /files/upload multipart, GET /files/download,
 * GET /files/info); this module only adapts transport — every request is a
 * curl on the target host over the shared ssh leg, against the
 * server-proxied execd endpoint (the lifecycle manager is loopback-only).
 * Warmup retry (502 / no status) covers the /files endpoints the same way
 * it covers /command (see ./execd.ts).
 *
 * Push: the local bytes ride the ssh leg's stdin into `curl -F 'file=@-...'`
 * (binary-safe). Pull: the ssh leg returns utf8 text, so the host-side
 * bytes are base64-armored (single read when short, 32 000-char chunks
 * otherwise — the runner caps output at 40 000 chars), then sha256-checked
 * and written locally as tmp + rename (never partial).
 */

import { Type } from "typebox";
import { statSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { capOutput } from "../atomic-remote-ssh/ssh.ts";
import {
  DEFAULT_API_KEY,
  uploadCommand,
  fileInfoCommand,
  downloadCommand,
  hostTempPath,
  wcCommand,
  sha256Command,
  base64Command,
  base64ChunkCommand,
  cleanupCommand,
  chunkRanges,
  buildFileMetadata,
  defaultMode,
  classifySimple,
} from "./commands.ts";
import { resolveEndpoint, withRetry } from "./execd.ts";

const mid = (text) => ({ content: [{ type: "text", text }] });
const apiKeyOf = (params) => params.api_key ?? DEFAULT_API_KEY;
const HOST_DESC = "SSH target, user@host (OpenSandbox manager at 127.0.0.1:8090)";
const KEY_DESC = `OPEN-SANDBOX-API-KEY (default ${DEFAULT_API_KEY})`;

// execd's 30 s timeout applies to /command payloads only; /files endpoints
// have no payload timeout — rely on the ssh exec timeout instead.
const UPLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const AUX_TIMEOUT_MS = 60_000; // host-side wc / sha256 / base64 reads
const SHORT_TIMEOUT_MS = 30_000; // endpoint / files-info / temp cleanup

/**
 * The /files endpoints carry no SSE, so a warmup verdict is the status tag
 * alone: 2xx ok, 5xx / no status retry, 3xx/4xx fail fast.
 */
const classify = (code) => classifySimple(code);

export function registerFileTools(pi, deps) {
  const exec = deps.sshExec.exec;
  const maxAttempts = deps.maxAttempts ?? 5;
  const retryDelayMs = deps.retryDelayMs ?? 5_000;

  pi.registerTool({
    name: "sandbox_push",
    description:
      "Push a controller-side file into an OpenSandbox via its server-proxied " +
      "execd files API: POST {endpoint}/files/upload (metadata part + file part " +
      "from ssh stdin), then verify via GET /files/info that the remote size " +
      "matches. Retries up to 5 attempts, 5 s apart, on 502/no-status " +
      "(gVisor execd warmup).",
    parameters: Type.Object({
      host: Type.String({ description: HOST_DESC }),
      sandbox_id: Type.String({ description: "Sandbox id" }),
      local_path: Type.String({ description: "Controller-side file to push" }),
      remote_path: Type.String({ description: "Absolute destination file path inside the sandbox" }),
      mode: Type.Optional(Type.Number({ description: "Octal permission digits as a decimal int, e.g. 644 or 755 (default: 755 if the source has any execute bit, else 644)" })),
      owner: Type.Optional(Type.String({ description: "Sandbox-side owner (optional)" })),
      group: Type.Optional(Type.String({ description: "Sandbox-side group (optional)" })),
      api_key: Type.Optional(Type.String({ description: KEY_DESC })),
    }),
    async execute(_id, params, signal) {
      try {
        const apiKey = apiKeyOf(params);
        // 1. Local source: size, mode, bytes.
        const stat = statSync(params.local_path);
        const size = stat.size;
        const mode = params.mode ?? defaultMode(stat.mode);
        const buf = readFileSync(params.local_path);

        // 2. Resolve the server-proxied execd endpoint.
        const ep = await resolveEndpoint(exec, {
          host: params.host,
          apiKey,
          sandboxId: params.sandbox_id,
          signal,
          tool: "sandbox_push",
        });
        if (!ep.ok) return mid(ep.message);

        // 3. Upload (metadata part + file part from ssh stdin); retry on warmup.
        const metadata = buildFileMetadata(params.remote_path, mode, params.owner, params.group);
        const r = await withRetry(exec, {
          host: params.host,
          cmd: uploadCommand(apiKey, ep.endpointUrl, metadata, basename(params.remote_path)),
          signal,
          timeoutMs: UPLOAD_TIMEOUT_MS,
          maxAttempts,
          retryDelayMs,
          classify,
          stdinText: buf,
        });
        if (!r.ok) {
          if (r.kind === "ssh") return mid(`sandbox_push FAILED: ${r.message}`);
          if (r.kind === "error") {
            return mid(`sandbox_push FAILED (http=${r.code}): ${capOutput(r.body || r.stderr).slice(0, 2_000)}`);
          }
          return mid(`sandbox_push FAILED after ${maxAttempts} attempts (last http=${r.code})`);
        }

        // 4. Verify: GET /files/info, remote size must equal the local byte length.
        const info = await exec(params.host, fileInfoCommand(apiKey, ep.endpointUrl, params.remote_path), { signal, timeoutMs: SHORT_TIMEOUT_MS });
        if (info.exitCode !== 0) {
          return mid(`sandbox_push FAILED (info): ${info.stderr || `exit=${info.exitCode}`}`);
        }
        let remoteSize = null;
        try {
          const j = JSON.parse(info.stdout);
          remoteSize = j && typeof j.size === "number" ? j.size : null;
        } catch {}
        if (remoteSize === null) {
          const m = info.stdout.match(/"size"\s*:\s*(\d+)/);
          remoteSize = m ? parseInt(m[1], 10) : null;
        }
        if (remoteSize === null) {
          return mid(`sandbox_push FAILED: cannot read size from /files/info: ${capOutput(info.stdout).slice(0, 400)}`);
        }
        if (remoteSize !== size) {
          return mid(`sandbox_push FAILED: size mismatch local=${size} remote=${remoteSize}`);
        }

        return mid(`pushed ${params.local_path} -> ${params.remote_path} bytes=${size} mode=${mode}\nlocal=${size} remote=${remoteSize}`);
      } catch (e) {
        return mid(`sandbox_push FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "sandbox_pull",
    description:
      "Pull a sandbox file to the controller via its server-proxied execd files " +
      "API: GET {endpoint}/files/download into a host-side temp file, then the " +
      "bytes ride the ssh leg base64-armored (32 000-char chunks when long) and " +
      "are sha256-verified before an atomic local write (tmp + rename). Retries " +
      "up to 5 attempts, 5 s apart, on 502/no-status (gVisor execd warmup).",
    parameters: Type.Object({
      host: Type.String({ description: HOST_DESC }),
      sandbox_id: Type.String({ description: "Sandbox id" }),
      remote_path: Type.String({ description: "Absolute file path inside the sandbox" }),
      local_path: Type.String({ description: "Controller-side destination file path" }),
      api_key: Type.Optional(Type.String({ description: KEY_DESC })),
    }),
    async execute(_id, params, signal) {
      const apiKey = apiKeyOf(params);
      const rand = randomBytes(6).toString("hex");
      const tmp = hostTempPath(rand);
      try {
        // 1. Resolve the server-proxied execd endpoint.
        const ep = await resolveEndpoint(exec, {
          host: params.host,
          apiKey,
          sandboxId: params.sandbox_id,
          signal,
          tool: "sandbox_pull",
        });
        if (!ep.ok) return mid(ep.message);

        // 2. Download to the host-side temp file; retry on warmup.
        const r = await withRetry(exec, {
          host: params.host,
          cmd: downloadCommand(apiKey, ep.endpointUrl, params.remote_path, tmp),
          signal,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          maxAttempts,
          retryDelayMs,
          classify,
        });
        if (!r.ok) {
          if (r.kind === "ssh") return mid(`sandbox_pull FAILED: ${r.message}`);
          if (r.kind === "error") {
            return mid(`sandbox_pull FAILED (http=${r.code}): ${capOutput(r.body || r.stderr).slice(0, 2_000)}`);
          }
          return mid(`sandbox_pull FAILED after ${maxAttempts} attempts (last http=${r.code})`);
        }

        // 3. Byte count + host-side sha256 of the temp file.
        const wc = await exec(params.host, wcCommand(tmp), { signal, timeoutMs: AUX_TIMEOUT_MS });
        if (wc.exitCode !== 0) return mid(`sandbox_pull FAILED (wc): ${wc.stderr || `exit=${wc.exitCode}`}`);
        const bytes = parseInt(wc.stdout.trim(), 10);
        if (!Number.isInteger(bytes) || bytes < 0) {
          return mid(`sandbox_pull FAILED: cannot read byte count: ${wc.stdout.trim()}`);
        }
        const sh = await exec(params.host, sha256Command(tmp), { signal, timeoutMs: AUX_TIMEOUT_MS });
        if (sh.exitCode !== 0) return mid(`sandbox_pull FAILED (sha256sum): ${sh.stderr || `exit=${sh.exitCode}`}`);
        const sha256_remote = sh.stdout.trim().split(/\s+/)[0];

        // 4. Base64 armor: one read when short, otherwise 32 000-char chunks
        //    (the ssh runner caps stdout at 40 000 chars — never exceed it).
        const b64Len = Math.ceil(bytes / 3) * 4;
        let b64 = "";
        let chunks = 1;
        if (b64Len <= 24_000) {
          const b = await exec(params.host, base64Command(tmp), { signal, timeoutMs: AUX_TIMEOUT_MS });
          if (b.exitCode !== 0) return mid(`sandbox_pull FAILED (base64): ${b.stderr || `exit=${b.exitCode}`}`);
          b64 = b.stdout.replace(/\s+/g, "");
        } else {
          const ranges = chunkRanges(b64Len, 32_000);
          chunks = ranges.length;
          for (const range of ranges) {
            const c = await exec(params.host, base64ChunkCommand(tmp, range.start, range.end), { signal, timeoutMs: AUX_TIMEOUT_MS });
            if (c.exitCode !== 0) {
              return mid(`sandbox_pull FAILED (base64 chunk ${range.start}-${range.end}): ${c.stderr || `exit=${c.exitCode}`}`);
            }
            b64 += c.stdout.replace(/\s+/g, "");
          }
        }

        // 5. Verify locally before touching the destination (never partial).
        const buf = Buffer.from(b64, "base64");
        const sha256_local = createHash("sha256").update(buf).digest("hex");
        if (sha256_local !== sha256_remote) {
          return mid(`sandbox_pull FAILED: sha256 mismatch\nsha256_local=${sha256_local} sha256_remote=${sha256_remote}`);
        }

        // 6. Atomic local write: tmp file + rename.
        const dir = dirname(params.local_path);
        if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
        const localTmp = join(dir || ".", `${basename(params.local_path)}.tmp-${rand}`);
        writeFileSync(localTmp, buf);
        renameSync(localTmp, params.local_path);

        return mid(`pulled ${params.remote_path} -> ${params.local_path} bytes=${bytes} chunks=${chunks}\nsha256_local=${sha256_local} sha256_remote=${sha256_remote} match=true`);
      } catch (e) {
        return mid(`sandbox_pull FAILED: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        // Host-side temp cleanup on every path (success, mismatch, error).
        try {
          await exec(params.host, cleanupCommand(tmp), { signal, timeoutMs: SHORT_TIMEOUT_MS });
        } catch {}
      }
    },
  });
}
