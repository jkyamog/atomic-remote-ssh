import test from "node:test";
import assert from "node:assert/strict";
import { SSH_OPTS, buildSshArgs, capOutput, createSshRunner } from "../extensions/atomic-remote-ssh/ssh.ts";
import { createFakeSpawn } from "./fixtures/fake-spawn.ts";

test("buildSshArgs emits the frozen option pairs in order, then --, host, command", () => {
  assert.deepEqual(buildSshArgs("user@host", "pwd"), [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-o", "ControlMaster=auto",
    "-o", "ControlPath=~/.cache/atomic-ssh/%C",
    "-o", "ControlPersist=120",
    "--",
    "user@host",
    "pwd",
  ]);
  assert.equal(SSH_OPTS.length, 14);
});

test("buildSshArgs throws on malformed hosts (option injection, charset, empty)", () => {
  for (const bad of [
    "-oProxyCommand=echo PWNED",
    "",
    "a b",
    "h;h",
    "h$x",
    "`h`",
    "h*g",
    "h|rm",
    "user@host name",
    "user@ho\nst",
    "user@host:2222",
  ]) {
    assert.throws(() => buildSshArgs(bad, "pwd"), /invalid ssh host/, JSON.stringify(bad));
  }
});

test("buildSshArgs accepts valid user@host, bare host, dotted FQDN", () => {
  assert.doesNotThrow(() => buildSshArgs("user@example.host", "pwd"));
  assert.doesNotThrow(() => buildSshArgs("bare-host.example", "pwd"));
  assert.doesNotThrow(() => buildSshArgs("user@host.example.host", "pwd"));
});

test("SSH_OPTS: no predictable /tmp ControlPath; private hashed path instead", () => {
  assert.ok(SSH_OPTS.includes("ControlPath=~/.cache/atomic-ssh/%C"));
  assert.ok(!SSH_OPTS.some((x) => String(x).includes("/tmp/.atomic-ssh")));
});

test("capOutput leaves strings at or below 40_000 chars untouched", () => {
  assert.equal(capOutput("short"), "short");
  assert.equal(capOutput("x".repeat(40_000)), "x".repeat(40_000));
});

test("capOutput trims >40_000 to head 12_000 + marker + tail 12_000", () => {
  const s = "a".repeat(12_000) + "b".repeat(20_000) + "c".repeat(12_000); // 44_000
  assert.equal(
    capOutput(s),
    "a".repeat(12_000) + "\n...[truncated]...\n" + "c".repeat(12_000),
  );
});

test("exec resolves { stdout, stderr, exitCode }; null exit code -> -1", async () => {
  const fake = createFakeSpawn();
  const runner = createSshRunner({ spawn: fake.fn });
  const p = runner.exec("user@host", "echo hi", {});
  const child = fake.calls[0].child;
  child.stdout.emit("data", "hi\n");
  child.stderr.emit("data", "warn\n");
  child.emit("close", null);
  assert.deepEqual(await p, { stdout: "hi\n", stderr: "warn\n", exitCode: -1 });
});

test("exec rejects on spawn error event and clears its timer", async () => {
  const fake = createFakeSpawn();
  const runner = createSshRunner({ spawn: fake.fn });
  const p = runner.exec("user@host", "cmd", { timeoutMs: 50 }).then(
    () => assert.fail("should reject"),
    (e) => e,
  );
  const child = fake.calls[0].child;
  child.emit("error", new Error("spawn ssh ENOENT"));
  const err = await p;
  assert.equal(err.message, "spawn ssh ENOENT");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(child.killed, undefined); // timer was cleared on error: no SIGKILL
});

test("exec throws synchronously-visible error for malformed host before spawn", async () => {
  const fake = createFakeSpawn();
  const runner = createSshRunner({ spawn: fake.fn });
  const p = runner.exec("-oProxyCommand=echo PWNED", "pwd", {}).then(
    () => assert.fail("should reject"),
    (e) => e,
  );
  const err = await p;
  assert.match(err.message, /invalid ssh host/);
  assert.equal(fake.calls.length, 0); // nothing spawned
});

test("timeoutMs kills the child with SIGKILL and resolves when the child closes", async () => {
  const fake = createFakeSpawn();
  const runner = createSshRunner({ spawn: fake.fn });
  const p = runner.exec("user@host", "sleep 30", { timeoutMs: 30 });
  const child = fake.calls[0].child;
  child.stdout.emit("data", "partial");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(child.killed, true);
  assert.equal(child.killSignal, "SIGKILL");
  const r = await p;
  assert.equal(r.stdout, "partial");
  assert.equal(r.exitCode, -1); // null close code after SIGKILL
});

test("exec passes the signal through, ends stdin, swallows post-end stdin errors", async () => {
  const fake = createFakeSpawn();
  const runner = createSshRunner({ spawn: fake.fn });
  const ac = new AbortController();
  const p = runner.exec("user@host", "cmd", { signal: ac.signal, stdinText: "payload\n" });
  const call = fake.calls[0];
  assert.equal(call.opts.signal, ac.signal);
  assert.deepEqual(call.opts.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(call.child.stdin.ended, true);
  assert.equal(call.child.stdin.data, "payload\n");
  call.child.stdin.emit("error", new Error("EPIPE")); // must not crash
  call.child.emit("close", 0);
  assert.equal((await p).exitCode, 0);
});

test("execStrict resolves the stdout text on exit 0", async () => {
  const fake = createFakeSpawn();
  const runner = createSshRunner({ spawn: fake.fn });
  const p = runner.execStrict("user@host", "hostname");
  const child = fake.calls[0].child;
  child.stdout.emit("data", "example-host\n");
  child.emit("close", 0);
  assert.equal(await p, "example-host\n");
});

test("execStrict rejects with `ssh <host> failed (<code>): <stderr capped to 2000>`", async () => {
  const fake = createFakeSpawn();
  const runner = createSshRunner({ spawn: fake.fn });
  const p = runner.execStrict("user@host", "nope").then(
    () => assert.fail("should reject"),
    (e) => e,
  );
  const child = fake.calls[0].child;
  child.stderr.emit("data", "E".repeat(5_000));
  child.emit("close", 2);
  const err = await p;
  assert.equal(err.message, `ssh user@host failed (2): ${"E".repeat(2_000)}`);
});
