import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import {
  clampTimeoutSeconds,
  clampMaxBytes,
  bashCommand,
  catCommand,
  readCommand,
  writeCommand,
  mkdirCommand,
  accessCommand,
  connectPrepareCommand,
} from "../atomic-remote-ssh/commands.ts";

test("clampTimeoutSeconds: undefined->120, 0->5, 1000->900 (ms conversion stays in the tool layer)", () => {
  assert.equal(clampTimeoutSeconds(undefined), 120);
  assert.equal(clampTimeoutSeconds(0), 5);
  assert.equal(clampTimeoutSeconds(1_000), 900);
  assert.equal(clampTimeoutSeconds(120) * 1000, 120_000);
  assert.equal(clampTimeoutSeconds(30) * 1000, 30_000);
});

test("clampMaxBytes: undefined->200000, 2000000->1000000", () => {
  assert.equal(clampMaxBytes(undefined), 200_000);
  assert.equal(clampMaxBytes(2_000_000), 1_000_000);
  assert.equal(clampMaxBytes(50_000), 50_000);
});

test("bashCommand: no cwd is verbatim; with cwd it is cd single-quoted cwd && command", () => {
  assert.equal(bashCommand("ls -la"), "ls -la");
  assert.equal(bashCommand("ls -la", "/tmp/work"), "cd '/tmp/work' && ls -la");
  assert.equal(bashCommand("echo hi", "/tmp/we\"ird"), "cd '/tmp/we\"ird' && echo hi");
  assert.equal(bashCommand("echo hi", "/tmp/we'ird"), "cd '/tmp/we'\\''ird' && echo hi");
});

test("catCommand / readCommand exact strings", () => {
  assert.equal(catCommand("/home/user/x.ts"), "cat '/home/user/x.ts'");
  assert.equal(readCommand("/home/user/x.ts", 200_000), "cat '/home/user/x.ts' | head -c 200000");
});

test("writeCommand / mkdirCommand / accessCommand / connectPrepareCommand exact strings", () => {
  assert.equal(
    writeCommand("/home/user/Projects/x/f.txt"),
    "mkdir -p $(dirname '/home/user/Projects/x/f.txt') && base64 -d > '/home/user/Projects/x/f.txt'",
  );
  assert.equal(mkdirCommand("/a/b"), "mkdir -p '/a/b'");
  assert.equal(accessCommand("/a/b"), "test -r '/a/b'");
  assert.equal(connectPrepareCommand("/x/y"), "mkdir -p '/x/y' && cd '/x/y' && pwd");
  assert.equal(connectPrepareCommand(undefined), "pwd");
});

test("injection: $(...)/backtick payloads in cwd stay inert in the emitted string", () => {
  assert.equal(
    bashCommand("echo hi", "$(echo INJECTED)"),
    "cd '$(echo INJECTED)' && echo hi",
  );
  assert.equal(
    bashCommand("echo hi", "$(echo BAD) `echo X`"),
    "cd '$(echo BAD) `echo X`' && echo hi",
  );
});

test("injection: round-trip through real bash — payload never executes", () => {
  // execFileSync: no outer shell, so the emitted command is parsed exactly
  // as the remote would parse it. Old JSON.stringify double-quote form
  // executed the substitution (printed "BAD", cd failed, no "ok").
  const literalDir = "/tmp/atomic-q-rt-$(echo BAD)";
  mkdirSync(literalDir, { recursive: true });
  try {
    const out = execFileSync("bash", ["-c", bashCommand("echo ok", literalDir)], { encoding: "utf8" });
    assert.equal(out, "ok\n");
  } finally {
    rmSync(literalDir, { recursive: true, force: true });
  }
});

test("injection: writeCommand redirect target is the literal path (no substitution)", () => {
  // Old form: `base64 -d > "...$(echo BAD)..."` substituted the payload,
  // creating ...-BAD and leaving the literal target absent. New form:
  // the redirect target is a literal single-quoted path.
  const target = "/tmp/atomic-q-w-$(echo BAD)";
  try {
    execFileSync("bash", ["-c", `${writeCommand(target)} </dev/null`], { encoding: "utf8" });
    assert.ok(existsSync(target), "redirect target was substituted instead of staying literal");
  } finally {
    rmSync(target, { force: true });
    rmSync("/tmp/atomic-q-w-BAD", { force: true }); // the substituted artifact old code would create
  }
});
