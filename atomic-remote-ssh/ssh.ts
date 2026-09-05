/**
 * SSH transport layer: spawn, streams, kill-on-timeout, abort, output cap.
 * The spawner is injectable so this module is unit-testable without a network.
 * This module never imports typebox or @bastani/atomic.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Frozen ssh argv (order matters). */
export const SSH_OPTS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=8",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=4",
  "-o", "ControlMaster=auto",
  "-o", "ControlPath=~/.cache/atomic-ssh/%C",
  "-o", "ControlPersist=120",
];

/**
 * Multiplexing socket lives at ~/.cache/atomic-ssh/%C — %C is OpenSSH's hash
 * of the connection tuple, so target pairs are not enumerable from socket
 * names. Create the directory 0700 at module load (best effort).
 */
try {
  mkdirSync(join(process.env.HOME ?? "", ".cache", "atomic-ssh"), { recursive: true, mode: 0o700 });
} catch {}

/** Strict ssh host: charset-only user@host (or bare host), optional :port. */
const HOST_RE = /^(?:[A-Za-z0-9._%-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]+)?$/;

/** Pure: validate host, frozen options, `--` terminator, host, command. */
export function buildSshArgs(host, command) {
  if (!HOST_RE.test(String(host))) throw new Error(`invalid ssh host: ${host}`);
  return [...SSH_OPTS, "--", host, command];
}

/** Output cap: >40_000 chars -> head 12_000 + marker + tail 12_000. */
export function capOutput(s) {
  return s.length > 40_000
    ? s.slice(0, 12_000) + "\n...[truncated]...\n" + s.slice(-12_000)
    : s;
}

/**
 * Create an ssh runner.
 * @param opts { spawn?: (file, args, options) => child } injectable spawner
 *   (tests); defaults to node:child_process spawn.
 *
 * Returns { exec, execStrict, spawn }:
 *  - exec(host, command, { signal?, timeoutMs?, stdinText? })
 *      -> Promise<{ stdout: string, stderr: string, exitCode: number }>
 *      (no output cap applied here; callers cap via capOutput)
 *  - execStrict(host, command, opts) -> Promise<string> (stdout text);
 *      rejects `ssh ${host} failed (${code}): ${stderr.slice(0, 2000)}` on non-zero.
 */
export function createSshRunner(opts) {
  const o = opts || {};
  const spawnFn = o.spawn || spawn;

  function exec(host, command, eo) {
    const e = eo || {};
    return new Promise((resolve, reject) => {
      const child = spawnFn("ssh", buildSshArgs(host, command), {
        stdio: ["pipe", "pipe", "pipe"],
        signal: e.signal,
      });
      let stdout = "";
      let stderr = "";
      const timer = e.timeoutMs
        ? setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, e.timeoutMs)
        : undefined;
      child.stdout.on("data", (d) => { stdout += String(d); });
      child.stderr.on("data", (d) => { stderr += String(d); });
      child.on("error", (err) => { if (timer) clearTimeout(timer); reject(err); });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? -1 });
      });
      if (e.stdinText !== undefined) {
        child.stdin.on("error", () => {}); // EPIPE if the remote command exits early
        child.stdin.end(e.stdinText);
      }
    });
  }

  async function execStrict(host, command, eo) {
    const r = await exec(host, command, eo);
    if (r.exitCode !== 0) {
      throw new Error(`ssh ${host} failed (${r.exitCode}): ${r.stderr.slice(0, 2_000)}`);
    }
    return r.stdout;
  }

  return { exec, execStrict, spawn: spawnFn };
}
