import test from "node:test";
import assert from "node:assert/strict";
import { toRemotePath } from "../extensions/atomic-remote-ssh/paths.ts";

test("prefix path maps to remoteCwd + rest", () => {
  assert.equal(toRemotePath("/local/cwd", "/remote/cwd", "/local/cwd/a/b.ts"), "/remote/cwd/a/b.ts");
  assert.equal(toRemotePath("/local/cwd", "/remote/cwd", "/local/cwd/x"), "/remote/cwd/x");
  // the local cwd itself maps to the remote cwd
  assert.equal(toRemotePath("/local", "/remote", "/local"), "/remote");
});

test("non-prefix, already-remote, and non-string inputs pass through unchanged", () => {
  assert.equal(toRemotePath("/local", "/remote", "/other/file"), "/other/file");
  assert.equal(toRemotePath("/local", "/remote", "/remote/already"), "/remote/already");
  assert.equal(toRemotePath("/local", "/remote", null), null);
  assert.equal(toRemotePath("/local", "/remote", 42), 42);
  assert.equal(toRemotePath("/local", "/remote", undefined), undefined);
});
