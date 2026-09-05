/**
 * Additive remote-exec tools: remote_bash / remote_read / remote_write.
 * Each call carries its own host (and optional cwd), so concurrent stages
 * may target different machines with no shared per-process state.
 */

import { Type } from "typebox";
import { capOutput } from "./ssh.ts";
import {
  clampTimeoutSeconds,
  clampMaxBytes,
  bashCommand,
  readCommand,
  writeCommand,
} from "./commands.ts";

const mid = (text) => ({ content: [{ type: "text", text }] });

export function registerAdditiveTools(pi, deps) {
  const exec = deps.sshExec.exec;

  pi.registerTool({
    name: "remote_bash",
    description:
      "Run a shell command on a remote host over SSH (ControlMaster-multiplexed). " +
      "Returns combined output and the exit code. Use `cwd` for the remote working directory. " +
      "host is user@hostname, e.g. user@example.host.",
    parameters: Type.Object({
      host: Type.String({ description: "SSH target, user@host" }),
      command: Type.String({ description: "Command line, executed by the remote bash" }),
      cwd: Type.Optional(Type.String({ description: "Remote working directory (cd'ed into before the command)" })),
      timeout_seconds: Type.Optional(Type.Number({ description: "Kill after N seconds (default 120, max 1800)" })),
    }),
    async execute(_id, params, signal) {
      const to = clampTimeoutSeconds(params.timeout_seconds) * 1000;
      const cmd = bashCommand(params.command, params.cwd);
      try {
        const r = await exec(params.host, cmd, { signal, timeoutMs: to });
        const out = [capOutput(r.stdout), r.stderr ? `[stderr]\n${capOutput(r.stderr)}` : ""].filter(Boolean).join("\n");
        return mid(`exit=${r.exitCode}\n${out || "(no output)"}`);
      } catch (e) {
        return mid(`remote_bash FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "remote_read",
    description: "Read a file from a remote host over SSH (cat). Caps very large files.",
    parameters: Type.Object({
      host: Type.String({ description: "SSH target, user@host" }),
      path: Type.String({ description: "Absolute remote path" }),
      max_bytes: Type.Optional(Type.Number({ description: "Max bytes to return (default 200000)" })),
    }),
    async execute(_id, params, signal) {
      const max = clampMaxBytes(params.max_bytes);
      try {
        const r = await exec(params.host, readCommand(params.path, max), { signal, timeoutMs: 60_000 });
        if (r.exitCode !== 0) return mid(`remote_read FAILED: ${r.stderr || `exit=${r.exitCode}`}`);
        return mid(capOutput(r.stdout));
      } catch (e) {
        return mid(`remote_read FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "remote_write",
    description:
      "Write a file on a remote host over SSH (base64 over stdin, mkdir -p of parent dir). Overwrites.",
    parameters: Type.Object({
      host: Type.String({ description: "SSH target, user@host" }),
      path: Type.String({ description: "Absolute remote path" }),
      content: Type.String({ description: "Full file content" }),
    }),
    async execute(_id, params, signal) {
      const b64 = Buffer.from(params.content, "utf8").toString("base64");
      const cmd = writeCommand(params.path);
      try {
        const r = await exec(params.host, cmd, { signal, timeoutMs: 60_000, stdinText: b64 });
        return r.exitCode === 0
          ? mid(`wrote ${Buffer.byteLength(params.content)} bytes -> ${params.host}:${params.path}`)
          : mid(`remote_write FAILED (exit=${r.exitCode}): ${r.stderr}`);
      } catch (e) {
        return mid(`remote_write FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });
}
