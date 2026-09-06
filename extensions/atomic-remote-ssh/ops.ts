/**
 * Transparent-mode operations bundles, handed to the builtin factories
 * (createReadTool / createWriteTool / createEditTool / createBashTool)
 * as { operations }. No tool schema knowledge lives here.
 */

import { buildSshArgs } from "./ssh.ts";
import { toRemotePath } from "./paths.ts";
import {
  bashCommand,
  catCommand,
  writeCommand,
  mkdirCommand,
  accessCommand,
} from "./commands.ts";

/**
 * @param t target entry { remote, remoteCwd }
 * @param localCwd local cwd captured at load time
 * @param deps { sshExec } the runner (execStrict + injectable spawn)
 */
export function buildOps(t, localCwd, deps) {
  const execStrict = deps.sshExec.execStrict;
  const spawnFn = deps.sshExec.spawn;
  const rp = (p) => toRemotePath(localCwd, t.remoteCwd, p);

  const read = {
    readFile: async (p) => Buffer.from(await execStrict(t.remote, catCommand(rp(p)), { timeoutMs: 60_000 })),
    access: (p) => execStrict(t.remote, accessCommand(rp(p)), { timeoutMs: 30_000 }).then(() => {}),
    detectImageMimeType: async () => null,
  };

  const write = {
    writeFile: async (p, content) => {
      const b64 = Buffer.from(content).toString("base64");
      await execStrict(t.remote, writeCommand(rp(p)), { timeoutMs: 60_000, stdinText: b64 });
    },
    mkdir: (dir) => execStrict(t.remote, mkdirCommand(rp(dir)), { timeoutMs: 30_000 }).then(() => {}),
  };

  const edit = { readFile: read.readFile, access: read.access, writeFile: write.writeFile };

  const bash = {
    exec: (command, cwd, h) =>
      new Promise((resolve, reject) => {
        const cmd = bashCommand(command, rp(cwd));
        const child = spawnFn("ssh", buildSshArgs(t.remote, cmd), {
          stdio: ["ignore", "pipe", "pipe"],
          signal: h.signal,
        });
        let timedOut = false;
        const timer = h.timeout
          ? setTimeout(() => {
              timedOut = true;
              try { child.kill("SIGKILL"); } catch {}
            }, h.timeout * 1000)
          : undefined;
        child.stdout.on("data", h.onData);
        child.stderr.on("data", h.onData);
        child.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          if (h.signal && h.signal.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${h.timeout}`));
          else resolve({ exitCode: code === null || code === undefined ? -1 : code });
        });
      }),
  };

  return { read, write, edit, bash };
}
