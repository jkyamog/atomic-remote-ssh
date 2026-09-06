import test from "node:test";
import assert from "node:assert/strict";

import {
  q,
  buildFileMetadata,
  modeToOctalInt,
  defaultMode,
  uploadCommand,
  fileInfoCommand,
  downloadCommand,
  hostTempPath,
  wcCommand,
  sha256Command,
  base64Command,
  base64ChunkCommand,
  cleanupCommand,
  chunkRanges,
  classifySimple,
} from "../extensions/atomic-remote-sandbox/commands.ts";

const EP = "http://127.0.0.1:8090/proxy/sbx_1";
const W_TAG = `-w '\\n__HTTP_CODE__:%{http_code}'`;

test("q: single-quote escaping (POSIX '\\'' idiom)", () => {
  assert.equal(q("abc"), "'abc'");
  assert.equal(q("a'b"), "'a'\\''b'");
  assert.equal(q("it's"), "'it'\\''s'");
});

test("buildFileMetadata: exact JSON, key order, owner/group omitted when undefined", () => {
  assert.equal(buildFileMetadata("/opt/a.py", 755), '{"path":"/opt/a.py","mode":755}');
  assert.equal(
    buildFileMetadata("/opt/a.py", 493, "root", "root"),
    '{"path":"/opt/a.py","mode":493,"owner":"root","group":"root"}',
  );
  assert.equal(
    buildFileMetadata("/opt/a.py", 644, "root", undefined),
    '{"path":"/opt/a.py","mode":644,"owner":"root"}',
  );
});

test("modeToOctalInt: octal permission digits as a decimal int", () => {
  assert.equal(modeToOctalInt(0o755), 755);
  assert.equal(modeToOctalInt(0o644), 644);
  assert.equal(modeToOctalInt(0o600), 600);
  // full stat.mode (file-type bits included) — only the permission digits survive
  assert.equal(modeToOctalInt(0o100755), 755);
  assert.equal(modeToOctalInt(0o100644), 644);
});

test("defaultMode: 755 on any execute bit, else 644", () => {
  assert.equal(defaultMode(0o100755), 755);
  assert.equal(defaultMode(0o100644), 644);
  assert.equal(defaultMode(0o100111), 755); // user-only exec
  assert.equal(defaultMode(0o100001), 755); // other-only exec
  assert.equal(defaultMode(0o100444), 644);
});

test("uploadCommand: multipart POST, metadata part first, file=@- stdin part, filenames on both parts (FormFile requirement), -w tag", () => {
  const meta = buildFileMetadata("/opt/a.py", 755);
  assert.equal(
    uploadCommand("k", EP, meta, "a.py"),
    `curl -sS -X POST -H 'OPEN-SANDBOX-API-KEY: k' -F 'metadata="{\\"path\\":\\"/opt/a.py\\",\\"mode\\":755}";type=application/json;filename=metadata' -F 'file=@-;type=application/octet-stream;filename=a.py' ${W_TAG} '${EP}/files/upload'`,
  );
  // default file-part filename keeps the pure builder standalone-runnable
  assert.ok(uploadCommand("k", EP, meta).includes("filename=file"), "default filename=file missing");
  // part order: metadata part must precede the file part
  const cmd = uploadCommand("k", EP, meta, "a.py");
  assert.ok(cmd.indexOf("metadata=") < cmd.indexOf("file=@-"), `got: ${cmd}`);
});

test("uploadCommand: double-quoted metadata survives single-quoting; a single quote in the path is q-escaped", () => {
  const cmd = uploadCommand("k", EP, buildFileMetadata("/tmp/a'b.py", 644), "a'b.py");
  assert.ok(cmd.includes(`-F 'metadata="{\\"path\\":\\"/tmp/a'\\''b.py\\",\\"mode\\":644}";type=application/json;filename=metadata'`), `got: ${cmd}`);
  assert.ok(cmd.includes(`filename=a'\\''b.py'`), `got: ${cmd}`);
});

test("uploadCommand: a ';' in the path rides curl's quoted -F form on both parts (curl truncates an unquoted ';')", () => {
  const cmd = uploadCommand("k", EP, buildFileMetadata("/opt/a;b.py", 644), "a;b.py");
  assert.ok(
    cmd.includes(`metadata="{\\"path\\":\\"/opt/a;b.py\\",\\"mode\\":644}";type=application/json;filename=metadata`),
    `got: ${cmd}`,
  );
  assert.ok(cmd.includes(`-F 'file=@-;type=application/octet-stream;filename="a;b.py"'`), `got: ${cmd}`);
});

test("uploadCommand: a double quote in the basename rides the quoted+escaped -F form", () => {
  const cmd = uploadCommand("k", EP, buildFileMetadata('/opt/we"ird.txt', 644), 'we"ird.txt');
  assert.ok(cmd.includes(`filename="we\\"ird.txt"`), `got: ${cmd}`);
});

test("uploadCommand: a space basename stays unquoted in the -F value", () => {
  const cmd = uploadCommand("k", EP, buildFileMetadata("/opt/a b.txt", 644), "a b.txt");
  assert.ok(cmd.includes(`-F 'file=@-;type=application/octet-stream;filename=a b.txt'`), `got: ${cmd}`);
});

test("fileInfoCommand: GET with URL-encoded path", () => {
  assert.equal(
    fileInfoCommand("k", EP, "/opt/a b.py"),
    `curl -fsS -H 'OPEN-SANDBOX-API-KEY: k' '${EP}/files/info?path=%2Fopt%2Fa%20b.py'`,
  );
});

test("downloadCommand: GET to a host temp file with -w tag", () => {
  assert.equal(
    downloadCommand("k", EP, "/opt/out.json", "/tmp/.atomic-pull-abcd1234"),
    `curl -fsS -H 'OPEN-SANDBOX-API-KEY: k' '${EP}/files/download?path=%2Fopt%2Fout.json' -o '/tmp/.atomic-pull-abcd1234' ${W_TAG}`,
  );
});

test("hostTempPath: namespaced /tmp temp name", () => {
  assert.equal(hostTempPath("abcd1234"), "/tmp/.atomic-pull-abcd1234");
});

test("wc / sha256 / base64 / cleanup host-side helpers", () => {
  const t = "/tmp/.atomic-pull-x";
  assert.equal(wcCommand(t), "wc -c < '/tmp/.atomic-pull-x'");
  assert.equal(sha256Command(t), "sha256sum '/tmp/.atomic-pull-x' | cut -d' ' -f1");
  assert.equal(base64Command(t), "base64 -w0 '/tmp/.atomic-pull-x'");
  assert.equal(base64ChunkCommand(t, 1, 32000), "base64 -w0 '/tmp/.atomic-pull-x' | cut -c1-32000");
  assert.equal(base64ChunkCommand(t, 32001, 40000), "base64 -w0 '/tmp/.atomic-pull-x' | cut -c32001-40000");
  assert.equal(cleanupCommand(t), "rm -f '/tmp/.atomic-pull-x'");
});

test("chunkRanges: 0 -> [], exact multiple, ragged last chunk, custom size", () => {
  assert.deepEqual(chunkRanges(0), []);
  assert.deepEqual(chunkRanges(32_000), [{ start: 1, end: 32_000 }]);
  assert.deepEqual(chunkRanges(64_000), [
    { start: 1, end: 32_000 },
    { start: 32_001, end: 64_000 },
  ]);
  assert.deepEqual(chunkRanges(40_000), [
    { start: 1, end: 32_000 },
    { start: 32_001, end: 40_000 },
  ]);
  assert.deepEqual(chunkRanges(10, 3), [
    { start: 1, end: 3 },
    { start: 4, end: 6 },
    { start: 7, end: 9 },
    { start: 10, end: 10 },
  ]);
});

test("classifySimple: 2xx ok, 5xx/no-status warmup, 3xx/4xx error", () => {
  assert.equal(classifySimple("200"), "ok");
  assert.equal(classifySimple("201"), "ok");
  assert.equal(classifySimple("502"), "warmup");
  assert.equal(classifySimple("503"), "warmup");
  assert.equal(classifySimple("500"), "warmup");
  assert.equal(classifySimple(null), "warmup");
  assert.equal(classifySimple("0"), "warmup");
  assert.equal(classifySimple("404"), "error");
  assert.equal(classifySimple("400"), "error");
  assert.equal(classifySimple("301"), "error");
});
