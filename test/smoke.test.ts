import test from "node:test";
import assert from "node:assert/strict";

test("all five core modules are erasable and importable under node --test", async () => {
  const ssh = await import("../extensions/atomic-remote-ssh/ssh.ts");
  assert.equal(typeof ssh.createSshRunner, "function");
  assert.equal(typeof ssh.buildSshArgs, "function");
  assert.equal(typeof ssh.capOutput, "function");
  assert.equal(typeof ssh.SSH_OPTS, "object");

  const targets = await import("../extensions/atomic-remote-ssh/targets.ts");
  assert.equal(typeof targets.createTargetRegistry, "function");
  assert.equal(typeof targets.sidOf, "function");

  const paths = await import("../extensions/atomic-remote-ssh/paths.ts");
  assert.equal(typeof paths.toRemotePath, "function");

  const commands = await import("../extensions/atomic-remote-ssh/commands.ts");
  assert.equal(typeof commands.bashCommand, "function");
  assert.equal(typeof commands.clampTimeoutSeconds, "function");
  assert.equal(typeof commands.readCommand, "function");
  assert.equal(typeof commands.connectPrepareCommand, "function");

  const ops = await import("../extensions/atomic-remote-ssh/ops.ts");
  assert.equal(typeof ops.buildOps, "function");
});
