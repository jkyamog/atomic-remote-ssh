import test from "node:test";
import assert from "node:assert/strict";
import { buildOps } from "../extensions/atomic-remote-ssh/ops.ts";
import { createSshRunner } from "../extensions/atomic-remote-ssh/ssh.ts";
import { createFakeSpawn } from "./fixtures/fake-spawn.ts";

const T = { remote: "user@example-host", remoteCwd: "/home/user/remote" };
const LOCAL_CWD = "/home/atomic/work";

function makeOps() {
  const fake = createFakeSpawn();
  const real = createSshRunner({ spawn: fake.fn });
  const execCalls = [];
  const execStrict = async (host, command, o) => {
    execCalls.push({ host, command, opts: o });
    return real.execStrict(host, command, o);
  };
  const deps = {
    sshExec: { ...real, execStrict },
    targets: { get: () => undefined, set: () => {}, del: () => false },
    localCwd: LOCAL_CWD,
  };
  return {
    ops: buildOps(T, LOCAL_CWD, deps),
    fake,
    last: () => fake.calls[fake.calls.length - 1],
    lastExec: () => execCalls[execCalls.length - 1],
  };
}

/** args = [...SSH_OPTS, host, command] */
function argsOf(call) {
  return {
    host: call.args[call.args.length - 2],
    command: call.args[call.args.length - 1],
  };
}

test("readFile: mapped path, execStrict, 60s timeout, resolves a Buffer", async () => {
  const { ops, last, lastExec } = makeOps();
  const p = ops.read.readFile(`${LOCAL_CWD}/notes.md`);
  const c = argsOf(last());
  assert.equal(c.host, "user@example-host");
  assert.equal(c.command, "cat '/home/user/remote/notes.md'");
  assert.equal(lastExec().opts.timeoutMs, 60_000);
  last().child.stdout.emit("data", "hello");
  last().child.emit("close", 0);
  const data = await p;
  assert.ok(Buffer.isBuffer(data));
  assert.equal(data.toString("utf8"), "hello");
});

test("access: `test -r` on the mapped path, 30s timeout, resolves undefined", async () => {
  const { ops, last, lastExec } = makeOps();
  const p = ops.read.access(`${LOCAL_CWD}/notes.md`);
  const c = argsOf(last());
  assert.equal(c.command, "test -r '/home/user/remote/notes.md'");
  assert.equal(lastExec().opts.timeoutMs, 30_000);
  last().child.emit("close", 0);
  assert.equal(await p, undefined);
});

test("detectImageMimeType resolves null", async () => {
  const { ops } = makeOps();
  assert.equal(await ops.read.detectImageMimeType("/any"), null);
});

test("writeFile: JSON-mapped path, base64 of content over stdin, mkdir -p prefix", async () => {
  const { ops, last, lastExec } = makeOps();
  const p = ops.write.writeFile(`${LOCAL_CWD}/sub/f.txt`, "héllo\n");
  const c = argsOf(last());
  assert.equal(
    c.command,
    "mkdir -p $(dirname '/home/user/remote/sub/f.txt') && base64 -d > '/home/user/remote/sub/f.txt'",
  );
  assert.equal(lastExec().opts.timeoutMs, 60_000);
  const b64 = last().child.stdin.data;
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), "héllo\n");
  last().child.emit("close", 0);
  await p;
});

test("mkdir: mapped path, 30s timeout", async () => {
  const { ops, last, lastExec } = makeOps();
  const p = ops.write.mkdir(`${LOCAL_CWD}/d1`);
  assert.equal(argsOf(last()).command, "mkdir -p '/home/user/remote/d1'");
  assert.equal(lastExec().opts.timeoutMs, 30_000);
  last().child.emit("close", 0);
  assert.equal(await p, undefined);
});

test("edit bundle is the read+write subset", () => {
  const { ops } = makeOps();
  assert.equal(ops.edit.readFile, ops.read.readFile);
  assert.equal(ops.edit.access, ops.read.access);
  assert.equal(ops.edit.writeFile, ops.write.writeFile);
});

test("bash.exec: cd uses toRemotePath on the given cwd; exit 0 -> { exitCode: 0 }", async () => {
  const { ops, last } = makeOps();
  const h = { onData: () => {}, timeout: 30, signal: undefined };
  const p = ops.bash.exec("echo hi", `${LOCAL_CWD}/subdir`, h);
  const c = argsOf(last());
  assert.equal(c.host, "user@example-host");
  assert.equal(c.command, "cd '/home/user/remote/subdir' && echo hi");
  assert.deepEqual(last().opts.stdio, ["ignore", "pipe", "pipe"]);
  last().child.stdout.emit("data", "hi\n");
  last().child.emit("close", 0);
  assert.deepEqual(await p, { exitCode: 0 });
});

test("bash.exec: null exit code -> { exitCode: -1 }", async () => {
  const { ops, last } = makeOps();
  const h = { onData: () => {}, timeout: 30, signal: undefined };
  const p = ops.bash.exec("true", "/x", h);
  last().child.emit("close", null);
  assert.deepEqual(await p, { exitCode: -1 });
});

test("bash.exec: stdout and stderr data are routed to h.onData", async () => {
  const { ops, last } = makeOps();
  const seen = [];
  const h = { onData: (d) => seen.push(String(d)), timeout: undefined, signal: undefined };
  const p = ops.bash.exec("true", "/x", h);
  last().child.stdout.emit("data", "out");
  last().child.stderr.emit("data", "err");
  last().child.emit("close", 0);
  await p;
  assert.deepEqual(seen, ["out", "err"]);
});

test("bash.exec: aborted signal at close -> reject 'aborted'", async () => {
  const { ops, last } = makeOps();
  const ac = new AbortController();
  const h = { onData: () => {}, timeout: undefined, signal: ac.signal };
  const p = ops.bash.exec("true", "/x", h).then(() => "ok", (e) => e);
  ac.abort();
  last().child.emit("close", 0);
  const e = await p;
  assert.ok(e instanceof Error);
  assert.equal(e.message, "aborted");
});

test("bash.exec: timer fire -> SIGKILL + reject `timeout:${h.timeout}`", async () => {
  const { ops, last } = makeOps();
  const h = { onData: () => {}, timeout: 0.05, signal: undefined };
  const p = ops.bash.exec("sleep 30", "/x", h).then(() => "ok", (e) => e);
  const e = await p;
  assert.ok(e instanceof Error);
  assert.equal(e.message, "timeout:0.05");
  assert.equal(last().child.killed, true);
  assert.equal(last().child.killSignal, "SIGKILL");
});
