import test from "node:test";
import assert from "node:assert/strict";
import { createSshRunner } from "../extensions/atomic-remote-ssh/ssh.ts";
import { createFakeSpawn } from "./fixtures/fake-spawn.ts";

/**
 * Fake-pi smoke test for the OpenSandbox registrar.
 * Skips itself when typebox (imported by sandbox-tools.ts) is not resolvable.
 *
 * sandbox_exec makes two ssh calls (endpoint GET, then command POST) and may
 * retry the POST on warmup, so tests drive the fake children in order and
 * flush between calls:
 *   - tick()   flushes microtasks (endpoint -> command transition, no sleep)
 *   - settle() waits past an injected retry sleep (retryDelayMs: 1)
 */
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test("sandbox-tools: registration, command shapes, and retry flow", async (t) => {
  let registerSandboxTools;
  try {
    ({ registerSandboxTools } = await import("../extensions/atomic-remote-sandbox/sandbox-tools.ts"));
  } catch (e) {
    t.skip(`typebox not resolvable in this environment: ${e && e.message}`);
    return;
  }

  const fake = createFakeSpawn();
  const deps = {
    sshExec: createSshRunner({ spawn: fake.fn }),
    maxAttempts: 3,
    retryDelayMs: 1,
  };
  const registered = [];
  const pi = { registerTool: (tool) => registered.push(tool) };
  registerSandboxTools(pi, deps);

  assert.deepEqual(
    registered.map((tool) => tool.name),
    ["sandbox_list", "sandbox_create", "sandbox_exec", "sandbox_destroy"],
  );
  const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]));
  const last = () => fake.calls[fake.calls.length - 1];
  const textOf = (r) => r.content[0].text;
  const drive = (child, stdout) => {
    if (stdout) child.stdout.emit("data", stdout);
    child.emit("close", 0);
  };

  // --- sandbox_list: success shape --------------------------------------
  {
    let p = byName.sandbox_list.execute("id", { host: "user@h" }, undefined);
    let call = last();
    assert.equal(call.args[call.args.length - 1], "curl -fsS -H 'OPEN-SANDBOX-API-KEY: poc-t13-nyx' 'http://127.0.0.1:8090/v1/sandboxes'");
    drive(call.child, '{"items":[{"id":"sbx_1"}]}');
    assert.equal(textOf(await p), '{"items":[{"id":"sbx_1"}]}');
  }

  // --- sandbox_list: non-zero ssh exit -> FAILED -------------------------
  {
    let p = byName.sandbox_list.execute("id", { host: "user@h" }, undefined);
    let call = last();
    call.child.stderr.emit("data", "ssh: connect failed");
    call.child.emit("close", 255);
    assert.equal(textOf(await p), "sandbox_list FAILED: ssh: connect failed");
  }

  // --- sandbox_create: success parses id + state -------------------------
  {
    let p = byName.sandbox_create.execute(
      "id",
      { host: "user@h", image: "python:3.11", timeout: 120, cpu: "1", memory: "1Gi", name: "mine" },
      undefined,
    );
    let call = last();
    assert.match(call.args[call.args.length - 1], /-d '\{"image":\{"uri":"python:3\.11"\},"timeout":120/);
    drive(call.child, '{"id":"sbx_new","status":{"state":"Running"}}');
    assert.equal(textOf(await p), "created id=sbx_new state=Running\n{\"id\":\"sbx_new\",\"status\":{\"state\":\"Running\"}}");
  }

  // --- sandbox_exec: endpoint + command, success on first attempt --------
  {
    let p = byName.sandbox_exec.execute("id", { host: "user@h", sandbox_id: "sbx_1", command: "echo hi" }, undefined);
    // call 0: endpoint GET
    let c0 = last();
    assert.equal(
      c0.args[c0.args.length - 1],
      "curl -fsS -H 'OPEN-SANDBOX-API-KEY: poc-t13-nyx' 'http://127.0.0.1:8090/v1/sandboxes/sbx_1/endpoints/44772?use_server_proxy=true'",
    );
    drive(c0.child, '{"endpoint":"http://127.0.0.1:8090/proxy/sbx_1"}');
    await tick();
    // call 1: command POST
    let c1 = last();
    assert.equal(
      c1.args[c1.args.length - 1],
      `curl -sS -X POST -H 'OPEN-SANDBOX-API-KEY: poc-t13-nyx' -H 'Content-Type: application/json' -d '{"command":"echo hi","background":false,"timeout":30000}' -w '\\n__HTTP_CODE__:%{http_code}' 'http://127.0.0.1:8090/proxy/sbx_1/command'`,
    );
    drive(c1.child, 'data: {"type":"stdout","text":"hi"}\ndata: {"type":"execution_complete"}\n__HTTP_CODE__:200');
    assert.equal(textOf(await p), "hi\n[execution_complete: true]");
  }

  // --- sandbox_exec: warmup (502) then success on attempt 2 --------------
  {
    fake.calls.length = 0;
    let p = byName.sandbox_exec.execute("id", { host: "user@h", sandbox_id: "sbx_1", command: "echo hi" }, undefined);
    // endpoint
    let c0 = last();
    drive(c0.child, '{"endpoint":"http://127.0.0.1:8090/proxy/sbx_1"}');
    await tick();
    // attempt 1: 502 (warmup) -> sleep(1ms) -> attempt 2
    let c1 = last();
    drive(c1.child, "\n__HTTP_CODE__:502");
    await settle();
    // attempt 2: success
    let c2 = last();
    drive(c2.child, 'data: {"type":"stdout","text":"hi"}\ndata: {"type":"execution_complete"}\n__HTTP_CODE__:200');
    assert.equal(textOf(await p), "hi\n[execution_complete: true]");
    // endpoint + 2 attempts
    assert.equal(fake.calls.length, 3);
  }

  // --- sandbox_exec: 4xx fails fast (no retry) ---------------------------
  {
    fake.calls.length = 0;
    let p = byName.sandbox_exec.execute("id", { host: "user@h", sandbox_id: "sbx_missing", command: "echo hi" }, undefined);
    let c0 = last();
    drive(c0.child, '{"endpoint":"http://127.0.0.1:8090/proxy/sbx_missing"}');
    await tick();
    let c1 = last();
    drive(c1.child, '{"error":"not found"}\n__HTTP_CODE__:404');
    const r = await p;
    assert.match(textOf(r), /^sandbox_exec FAILED \(http=404\)/);
    // endpoint + exactly 1 attempt (no retry on 4xx)
    assert.equal(fake.calls.length, 2);
  }

  // --- sandbox_exec: all attempts warmup -> FAILED after N attempts ------
  {
    fake.calls.length = 0;
    let p = byName.sandbox_exec.execute("id", { host: "user@h", sandbox_id: "sbx_1", command: "echo hi" }, undefined);
    let c0 = last();
    drive(c0.child, '{"endpoint":"http://127.0.0.1:8090/proxy/sbx_1"}');
    await tick();
    // maxAttempts: 3 -> three warmup attempts, two sleeps between them
    for (let i = 0; i < 3; i++) {
      const c = last();
      drive(c.child, "\n__HTTP_CODE__:502");
      if (i < 2) await settle();
    }
    const r = await p;
    assert.match(textOf(r), /^sandbox_exec FAILED after 3 attempts \(last http=502\)/);
    // endpoint + 3 attempts
    assert.equal(fake.calls.length, 4);
  }

  // --- sandbox_destroy: delete + re-list confirm gone --------------------
  {
    fake.calls.length = 0;
    let p = byName.sandbox_destroy.execute("id", { host: "user@h", sandbox_id: "sbx_1" }, undefined);
    // call 0: DELETE
    let c0 = last();
    assert.equal(
      c0.args[c0.args.length - 1],
      "curl -fsS -X DELETE -H 'OPEN-SANDBOX-API-KEY: poc-t13-nyx' 'http://127.0.0.1:8090/v1/sandboxes/sbx_1'",
    );
    drive(c0.child, "");
    await tick();
    // call 1: list confirm
    let c1 = last();
    assert.equal(c1.args[c1.args.length - 1], "curl -fsS -H 'OPEN-SANDBOX-API-KEY: poc-t13-nyx' 'http://127.0.0.1:8090/v1/sandboxes'");
    drive(c1.child, '{"items":[{"id":"sbx_other"}]}');
    assert.equal(textOf(await p), "destroyed sbx_1 (confirmed gone)");
  }

  // --- sandbox_destroy: still listed -------------------------------------
  {
    fake.calls.length = 0;
    let p = byName.sandbox_destroy.execute("id", { host: "user@h", sandbox_id: "sbx_1" }, undefined);
    let c0 = last();
    drive(c0.child, "");
    await tick();
    let c1 = last();
    drive(c1.child, '{"items":[{"id":"sbx_1"}]}');
    assert.equal(textOf(await p), "destroyed sbx_1 (STILL LISTED)");
  }
});
