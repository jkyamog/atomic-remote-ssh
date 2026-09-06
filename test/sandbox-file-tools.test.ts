import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createSshRunner } from "../extensions/atomic-remote-ssh/ssh.ts";
import { createFakeSpawn } from "./fixtures/fake-spawn.ts";

/**
 * Fake-pi flow tests for the OpenSandbox file-transfer tools
 * (sandbox_push / sandbox_pull), registered alongside the lifecycle tools
 * by registerSandboxTools. Skips itself when typebox is not resolvable.
 *
 * Drive pattern (same as sandbox-tools.test.ts): each tool step is one ssh
 * child; drive() closes it with stdout, tick() flushes the microtask that
 * issues the next call, settle() waits past an injected warmup retry sleep.
 */
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

const EP = "http://127.0.0.1:8090/proxy/sbx_1";
const ENDPOINT_JSON = `{"endpoint":"${EP}"}`;

const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

test("sandbox file tools: registration and push/pull flows", async (t) => {
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

  // Registration order: lifecycle tools first, then the file-transfer pair.
  assert.deepEqual(
    registered.map((tool) => tool.name),
    ["sandbox_list", "sandbox_create", "sandbox_exec", "sandbox_destroy", "sandbox_push", "sandbox_pull"],
  );

  const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]));
  const last = () => fake.calls[fake.calls.length - 1];
  const cmdOf = (c) => c.args[c.args.length - 1];
  const textOf = (r) => r.content[0].text;
  const drive = (child, stdout) => {
    if (stdout) child.stdout.emit("data", stdout);
    child.emit("close", 0);
  };

  const workdir = mkdtempSync(join(tmpdir(), "atomic-file-tools-"));

  // --- sandbox_push: happy path (endpoint -> upload POST -> info GET) ----
  {
    const src = join(workdir, "a.txt");
    writeFileSync(src, "abc");
    fake.calls.length = 0;
    let p = byName.sandbox_push.execute(
      "id",
      { host: "user@h", sandbox_id: "sbx_1", local_path: src, remote_path: "/opt/a.txt", mode: 755 },
      undefined,
    );
    // call 0: endpoint GET
    let c0 = last();
    assert.match(cmdOf(c0), /\/v1\/sandboxes\/sbx_1\/endpoints\/44772\?use_server_proxy=true/);
    drive(c0.child, ENDPOINT_JSON);
    await tick();
    // call 1: upload POST — multipart, metadata first, file part from ssh stdin
    let c1 = last();
    const up = cmdOf(c1);
    assert.match(up, /^curl -sS -X POST /);
    assert.ok(up.includes(`-F 'metadata={"path":"/opt/a.txt","mode":755};type=application/json;filename=metadata'`), `got: ${up}`);
    assert.ok(up.includes(`-F 'file=@-;type=application/octet-stream;filename=a.txt'`), `got: ${up}`);
    assert.ok(up.indexOf("metadata=") < up.indexOf("file=@-"), "metadata part must precede the file part");
    assert.ok(up.endsWith(`'${EP}/files/upload'`), `got: ${up}`);
    assert.ok(Buffer.isBuffer(c1.child.stdin.data), "file bytes must ride ssh stdin as a Buffer");
    assert.equal(c1.child.stdin.data.toString("utf8"), "abc");
    drive(c1.child, "\n__HTTP_CODE__:201");
    await tick();
    // call 2: /files/info verification GET
    let c2 = last();
    assert.equal(cmdOf(c2), `curl -fsS -H 'OPEN-SANDBOX-API-KEY: poc-t13-nyx' '${EP}/files/info?path=%2Fopt%2Fa.txt'`);
    drive(c2.child, '{"path":"/opt/a.txt","size":3,"mode":755}');
    const r = await p;
    assert.equal(textOf(r), `pushed ${src} -> /opt/a.txt bytes=3 mode=755\nlocal=3 remote=3`);
    assert.equal(fake.calls.length, 3);
  }

  // --- sandbox_push: 502 warmup on the first upload attempt, then ok -----
  {
    const src = join(workdir, "retry.txt");
    writeFileSync(src, "abc");
    fake.calls.length = 0;
    let p = byName.sandbox_push.execute(
      "id",
      { host: "user@h", sandbox_id: "sbx_1", local_path: src, remote_path: "/opt/retry.txt", mode: 755 },
      undefined,
    );
    let c0 = last();
    drive(c0.child, ENDPOINT_JSON);
    await tick();
    // attempt 1: 502 warmup -> sleep(1ms) -> attempt 2
    let c1 = last();
    drive(c1.child, "\n__HTTP_CODE__:502");
    await settle();
    let c2 = last();
    assert.ok(cmdOf(c2).includes("/files/upload"), "retry must re-issue the same upload");
    drive(c2.child, "\n__HTTP_CODE__:201");
    await tick();
    // info verification
    let c3 = last();
    drive(c3.child, '{"size":3}');
    const r = await p;
    assert.match(textOf(r), /^pushed .*retry\.txt -> \/opt\/retry\.txt bytes=3 mode=755\nlocal=3 remote=3$/);
    // endpoint + upload x2 + info = 4 ssh calls
    assert.equal(fake.calls.length, 4);
  }

  // --- sandbox_pull: small file, single base64 read -----------------------
  {
    const content = Buffer.from("hello pull");
    const b64 = content.toString("base64");
    const sha = sha256hex(content);
    const dest = join(workdir, "out.txt");
    fake.calls.length = 0;
    let p = byName.sandbox_pull.execute(
      "id",
      { host: "user@h", sandbox_id: "sbx_1", remote_path: "/opt/out.txt", local_path: dest },
      undefined,
    );
    // call 0: endpoint GET
    let c0 = last();
    drive(c0.child, ENDPOINT_JSON);
    await tick();
    // call 1: download GET into a host temp file
    let c1 = last();
    const dl = cmdOf(c1);
    assert.ok(dl.includes(`'${EP}/files/download?path=%2Fopt%2Fout.txt'`), `got: ${dl}`);
    const m = dl.match(/-o '([^']+)'/);
    assert.ok(m, `download must write to a -o temp file, got: ${dl}`);
    const tmp = m[1];
    assert.match(tmp, /^\/tmp\/\.atomic-pull-[a-z0-9]+$/);
    drive(c1.child, "\n__HTTP_CODE__:200");
    await tick();
    // call 2: byte count
    let c2 = last();
    assert.equal(cmdOf(c2), `wc -c < '${tmp}'`);
    drive(c2.child, `${content.length}\n`);
    await tick();
    // call 3: host-side sha256
    let c3 = last();
    assert.equal(cmdOf(c3), `sha256sum '${tmp}' | cut -d' ' -f1`);
    drive(c3.child, `${sha}\n`);
    await tick();
    // call 4: single base64 read (<= 24 000 chars -> no cut)
    let c4 = last();
    assert.equal(cmdOf(c4), `base64 -w0 '${tmp}'`);
    drive(c4.child, b64);
    await tick();
    // call 5: host temp cleanup (finally, success path)
    let c5 = last();
    assert.equal(cmdOf(c5), `rm -f '${tmp}'`);
    drive(c5.child);
    const r = await p;
    assert.equal(
      textOf(r),
      `pulled /opt/out.txt -> ${dest} bytes=${content.length} chunks=1\nsha256_local=${sha} sha256_remote=${sha} match=true`,
    );
    assert.deepEqual(readFileSync(dest), content);
    assert.equal(fake.calls.length, 6);
  }

  // --- sandbox_pull: long file, chunked base64 (32 000-char cut reads) ----
  {
    const content = Buffer.alloc(30_000); // 40 000 base64 chars -> 2 chunks
    const b64 = content.toString("base64");
    assert.equal(b64.length, 40_000);
    const sha = sha256hex(content);
    const dest = join(workdir, "big.bin");
    fake.calls.length = 0;
    let p = byName.sandbox_pull.execute(
      "id",
      { host: "user@h", sandbox_id: "sbx_1", remote_path: "/opt/big.bin", local_path: dest },
      undefined,
    );
    let c0 = last();
    drive(c0.child, ENDPOINT_JSON);
    await tick();
    let c1 = last();
    const tmp = cmdOf(c1).match(/-o '([^']+)'/)[1];
    drive(c1.child, "\n__HTTP_CODE__:200");
    await tick();
    let c2 = last();
    drive(c2.child, "30000\n");
    await tick();
    let c3 = last();
    drive(c3.child, `${sha}\n`);
    await tick();
    // chunk 1: chars 1..32000
    let c4 = last();
    assert.equal(cmdOf(c4), `base64 -w0 '${tmp}' | cut -c1-32000`);
    drive(c4.child, b64.slice(0, 32_000));
    await tick();
    // chunk 2: chars 32001..40000
    let c5 = last();
    assert.equal(cmdOf(c5), `base64 -w0 '${tmp}' | cut -c32001-40000`);
    drive(c5.child, b64.slice(32_000));
    await tick();
    // cleanup
    let c6 = last();
    assert.equal(cmdOf(c6), `rm -f '${tmp}'`);
    drive(c6.child);
    const r = await p;
    assert.match(textOf(r), /^pulled \/opt\/big\.bin -> .* bytes=30000 chunks=2\nsha256_local=[0-9a-f]{64} sha256_remote=[0-9a-f]{64} match=true$/);
    assert.deepEqual(readFileSync(dest), content);
    // endpoint + download + wc + sha + 2 chunks + cleanup = 7
    assert.equal(fake.calls.length, 7);
  }

  // --- sandbox_pull: sha256 mismatch -> FAILED with receipt, no write -----
  {
    const content = Buffer.from("corrupt me");
    const realSha = sha256hex(content);
    const dest = join(workdir, "bad.txt");
    fake.calls.length = 0;
    let p = byName.sandbox_pull.execute(
      "id",
      { host: "user@h", sandbox_id: "sbx_1", remote_path: "/opt/bad.txt", local_path: dest },
      undefined,
    );
    let c0 = last();
    drive(c0.child, ENDPOINT_JSON);
    await tick();
    let c1 = last();
    const tmp = cmdOf(c1).match(/-o '([^']+)'/)[1];
    drive(c1.child, "\n__HTTP_CODE__:200");
    await tick();
    let c2 = last();
    drive(c2.child, `${content.length}\n`);
    await tick();
    let c3 = last();
    // host reports a digest that will not match the local decode
    drive(c3.child, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");
    await tick();
    let c4 = last();
    drive(c4.child, content.toString("base64"));
    await tick();
    // host temp cleanup still issued on the failure path
    let c5 = last();
    assert.equal(cmdOf(c5), `rm -f '${tmp}'`);
    drive(c5.child);
    const r = await p;
    assert.equal(
      textOf(r),
      `sandbox_pull FAILED: sha256 mismatch\nsha256_local=${realSha} sha256_remote=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`,
    );
    // no partial local write
    assert.ok(!existsSync(dest), "destination must not be created on mismatch");
    assert.equal(fake.calls.length, 6);
  }
});
