import test from "node:test";
import assert from "node:assert/strict";
import { sidOf, createTargetRegistry } from "../extensions/atomic-remote-ssh/targets.ts";

test("sidOf precedence: sessionId -> sessionFile -> __global__; missing ctx is safe", () => {
  assert.equal(
    sidOf({ sessionManager: { sessionId: "abc", sessionFile: "/s/f.json" } }),
    "abc",
  );
  assert.equal(sidOf({ sessionManager: { sessionFile: "/s/f.json" } }), "/s/f.json");
  assert.equal(sidOf({ sessionManager: {} }), "__global__");
  assert.equal(sidOf({}), "__global__");
  assert.equal(sidOf(undefined), "__global__");
  assert.equal(sidOf(null), "__global__");
  assert.equal(sidOf({ sessionManager: { sessionId: 42 } }), "42");
});

test("registry isolates two sessions with the same path but different sids; del returns booleans", () => {
  const r = createTargetRegistry();
  r.set("s1", { remote: "user@a", remoteCwd: "/home/user" });
  r.set("s2", { remote: "user@b", remoteCwd: "/home/user" });
  assert.deepEqual(r.get("s1"), { remote: "user@a", remoteCwd: "/home/user" });
  assert.deepEqual(r.get("s2"), { remote: "user@b", remoteCwd: "/home/user" });
  assert.equal(r.del("s1"), true);
  assert.equal(r.get("s1"), undefined);
  assert.equal(r.del("never-set"), false);
});
