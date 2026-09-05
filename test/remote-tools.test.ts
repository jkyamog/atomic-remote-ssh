import test from "node:test";
import assert from "node:assert/strict";
import { createSshRunner } from "../atomic-remote-ssh/ssh.ts";
import { createFakeSpawn } from "./fixtures/fake-spawn.ts";

/**
 * Fake-pi smoke test for the additive registrar.
 * Skips itself when typebox (imported by remote-tools.ts) is not resolvable
 * in the test environment.
 *
 * Pattern: kick the tool execute (spawn happens synchronously inside it),
 * drive the fake child, then await the result.
 */
test("remote-tools: registered names, clamps, and frozen result strings", async (t) => {
  let registerAdditiveTools;
  try {
    ({ registerAdditiveTools } = await import("../atomic-remote-ssh/remote-tools.ts"));
  } catch (e) {
    t.skip(`typebox not resolvable in this environment: ${e && e.message}`);
    return;
  }

  const fake = createFakeSpawn();
  const deps = {
    sshExec: createSshRunner({ spawn: fake.fn }),
    targets: { get: () => undefined, set: () => {}, del: () => false },
    localCwd: "/local",
  };
  const registered = [];
  const pi = { registerTool: (tool) => registered.push(tool) };
  registerAdditiveTools(pi, deps);

  assert.deepEqual(registered.map((tool) => tool.name), ["remote_bash", "remote_read", "remote_write"]);
  const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]));
  const last = () => fake.calls[fake.calls.length - 1];
  const textOf = (r) => r.content[0].text;

  // remote_bash: cwd prefixing + success shape
  let p = byName.remote_bash.execute("id", { host: "user@h", command: "echo out", cwd: "/w" }, undefined);
  let call = last();
  assert.equal(call.args[call.args.length - 1], "cd '/w' && echo out");
  call.child.stdout.emit("data", "out\n");
  call.child.emit("close", 0);
  assert.equal(textOf(await p), "exit=0\nout\n");

  // remote_bash: stderr section
  p = byName.remote_bash.execute("id", { host: "user@h", command: "false" }, undefined);
  call = last();
  call.child.stderr.emit("data", "boom\n");
  call.child.emit("close", 1);
  assert.equal(textOf(await p), "exit=1\n[stderr]\nboom\n");

  // remote_read: success and failure
  p = byName.remote_read.execute("id", { host: "user@h", path: "/a/b" }, undefined);
  call = last();
  assert.equal(call.args[call.args.length - 1], "cat '/a/b' | head -c 200000");
  call.child.stdout.emit("data", "data");
  call.child.emit("close", 0);
  assert.equal(textOf(await p), "data");

  p = byName.remote_read.execute("id", { host: "user@h", path: "/missing", max_bytes: 1_000_000 }, undefined);
  call = last();
  assert.equal(call.args[call.args.length - 1], "cat '/missing' | head -c 1000000");
  call.child.stderr.emit("data", "no such file\n");
  call.child.emit("close", 2);
  assert.equal(textOf(await p), "remote_read FAILED: no such file\n");

  // remote_write: success and failure
  p = byName.remote_write.execute("id", { host: "user@h", path: "/a/b.txt", content: "héllo" }, undefined);
  call = last();
  assert.equal(call.args[call.args.length - 1], "mkdir -p $(dirname '/a/b.txt') && base64 -d > '/a/b.txt'");
  assert.equal(Buffer.from(call.child.stdin.data, "base64").toString("utf8"), "héllo");
  call.child.emit("close", 0);
  assert.equal(textOf(await p), "wrote 6 bytes -> user@h:/a/b.txt");

  p = byName.remote_write.execute("id", { host: "user@h", path: "/x", content: "c" }, undefined);
  call = last();
  call.child.stderr.emit("data", "read-only\n");
  call.child.emit("close", 3);
  assert.equal(textOf(await p), "remote_write FAILED (exit=3): read-only\n");
});
