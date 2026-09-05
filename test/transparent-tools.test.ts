import test from "node:test";
import assert from "node:assert/strict";
import { createTargetRegistry } from "../atomic-remote-ssh/targets.ts";

/**
 * Fake-pi test for the transparent registrar.
 * Skips itself when typebox (imported by transparent-tools.ts) is not
 * resolvable in the test environment. registerOverrides itself needs
 * @bastani/atomic; when that import fails, ssh_connect takes its frozen
 * FAILED branch, which is asserted here as well.
 */
test("transparent-tools: ssh_connect / ssh_disconnect behaviour", async (t) => {
  let registerTransparentTools;
  try {
    ({ registerTransparentTools } = await import("../atomic-remote-ssh/transparent-tools.ts"));
  } catch (e) {
    t.skip(`typebox not resolvable in this environment: ${e && e.message}`);
    return;
  }

  const responses = [];
  const calls = [];
  const execStrict = async (host, command, o) => {
    calls.push({ host, command, o });
    return responses.shift();
  };
  const deps = {
    sshExec: {
      exec: async () => {
        throw new Error("unused in this test");
      },
      execStrict,
      spawn: () => {
        throw new Error("unused in this test");
      },
    },
    targets: createTargetRegistry(),
    localCwd: "/local",
  };
  const registered = [];
  const pi = { registerTool: (tool) => registered.push(tool) };
  registerTransparentTools(pi, deps);

  assert.deepEqual(registered.map((tool) => tool.name), ["ssh_connect", "ssh_disconnect"]);
  const connect = registered[0];
  const disconnect = registered[1];
  const ctx = { sessionManager: { sessionId: "0123456789abcdef" } };

  // no target yet
  let r = await disconnect.execute("id", {}, undefined, undefined, ctx);
  assert.equal(r.content[0].text, "no active ssh connection");

  // connect with cwd
  responses.push("/home/user\n", "example-host\n");
  r = await connect.execute("id", { host: "user@example-host", cwd: "/home/user/Projects/x" }, undefined, undefined, ctx);
  assert.equal(calls[0].command, "mkdir -p '/home/user/Projects/x' && cd '/home/user/Projects/x' && pwd");
  assert.equal(calls[0].o.timeoutMs, 30_000);
  assert.equal(calls[1].command, "hostname");
  const text = r.content[0].text;
  if (text.startsWith("CONNECTED")) {
    // @bastani/atomic was importable: overrides registered
    assert.equal(text, "CONNECTED user@example-host:/home/user hostname=example-host overrides=registered session=0123456789abc");
  } else {
    // @bastani/atomic unavailable: frozen FAILED branch, target still set (prototype order)
    assert.ok(text.startsWith("ssh_connect FAILED: "), `unexpected: ${text}`);
  }

  r = await disconnect.execute("id", {}, undefined, undefined, ctx);
  assert.equal(r.content[0].text, "DISCONNECTED (built-ins local again)");

  // per-session isolation: another ctx has no target
  const other = { sessionManager: { sessionId: "ffffffffffffffff" } };
  r = await disconnect.execute("id", {}, undefined, undefined, other);
  assert.equal(r.content[0].text, "no active ssh connection");
});
