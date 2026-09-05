/**
 * Transparent remote routing: ssh_connect / ssh_disconnect + read/write/edit/bash overrides.
 *
 * Sessions that never call ssh_connect keep plain local tools.
 * registerTool from execute registers into the CALLER'S session, so the
 * overrides are re-registered on EVERY connect (no "registered once" flag).
 */

import { Type } from "typebox";
import { sidOf } from "./targets.ts";
import { connectPrepareCommand } from "./commands.ts";
import { buildOps } from "./ops.ts";

let mod = null; // lazily cached @bastani/atomic import

export function registerTransparentTools(pi, deps) {
  const targets = deps.targets;
  const localCwd = deps.localCwd;
  const execStrict = deps.sshExec.execStrict;
  const mid = (text) => ({ content: [{ type: "text", text }] });

  async function registerOverrides() {
    if (!mod) mod = await import("@bastani/atomic");
    const mk = [
      [mod.createReadTool, (t) => buildOps(t, localCwd, deps).read],
      [mod.createWriteTool, (t) => buildOps(t, localCwd, deps).write],
      [mod.createEditTool, (t) => buildOps(t, localCwd, deps).edit],
      [mod.createBashTool, (t) => buildOps(t, localCwd, deps).bash],
    ];
    for (const pair of mk) {
      const factory = pair[0];
      const opsFor = pair[1];
      const fallback = factory(localCwd);
      const wrapped = {
        ...fallback,
        execute: (id, params, signal, onUpdate, ctx) => {
          const t = targets.get(sidOf(ctx));
          if (!t) return fallback.execute(id, params, signal, onUpdate, ctx);
          return factory(localCwd, { operations: opsFor(t) }).execute(id, params, signal, onUpdate, ctx);
        },
      };
      try {
        pi.registerTool(wrapped);
      } catch (e) {
        // name may already be owned by this session's runner; non-fatal — routing
        // falls back to local for this session and the error is reported via ssh_connect.
        return `register(${fallback.name}) REJECTED: ${String(e && e.message).slice(0, 120)}`;
      }
    }
    return "overrides=registered";
  }

  pi.registerTool({
    name: "ssh_connect",
    description:
      "Route THIS session's built-in read/write/edit/bash tools to a remote host over SSH (transparent remote mode). " +
      "Until called, built-ins act locally. Optional cwd = remote work dir (defaults to remote home; created if missing).",
    parameters: Type.Object({
      host: Type.String({ description: "SSH target, user@host, e.g. user@example.host" }),
      cwd: Type.Optional(Type.String({ description: "Remote working directory" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const dir = (await execStrict(params.host, connectPrepareCommand(params.cwd), { timeoutMs: 30_000 })).trim();
        const host = (await execStrict(params.host, "hostname", { timeoutMs: 30_000 })).trim();
        const sid = sidOf(ctx);
        targets.set(sid, { remote: params.host, remoteCwd: dir });
        const ov = await registerOverrides();
        return mid(`CONNECTED ${params.host}:${dir} hostname=${host} ${ov} session=${sid.slice(0, 13)}`);
      } catch (e) {
        return mid(`ssh_connect FAILED: ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "ssh_disconnect",
    description: "Stop routing this session's built-in tools to the remote host; built-ins act local again.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const had = targets.del(sidOf(ctx));
      return mid(had ? "DISCONNECTED (built-ins local again)" : "no active ssh connection");
    },
  });
}
