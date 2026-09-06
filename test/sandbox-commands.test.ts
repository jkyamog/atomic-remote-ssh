import test from "node:test";
import assert from "node:assert/strict";

import {
  MANAGER_BASE,
  EXECD_PORT,
  DEFAULT_API_KEY,
  EXEC_MAX_ATTEMPTS,
  EXEC_RETRY_DELAY_MS,
  buildCreatePayload,
  listCommand,
  createCommand,
  endpointCommand,
  postCommandCommand,
  destroyCommand,
  splitHttpCode,
  parseSse,
  curlFormValue,
  classifyAttempt,
  extractEndpoint,
  normalizeEndpointUrl,
} from "../extensions/atomic-remote-sandbox/commands.ts";

/** Build a full parseSse-shaped object with only the given fields set. */
const P = (o) => ({ stdout: "", stderr: "", executionComplete: false, results: null, error: null, ...o });

test("constants", () => {
  assert.equal(MANAGER_BASE, "http://127.0.0.1:8090");
  assert.equal(EXECD_PORT, 44772);
  assert.equal(DEFAULT_API_KEY, "poc-t13-nyx");
  assert.equal(EXEC_MAX_ATTEMPTS, 5);
  assert.equal(EXEC_RETRY_DELAY_MS, 5_000);
});

test("listCommand quotes the key and manager url", () => {
  assert.equal(
    listCommand("k"),
    "curl -fsS -H 'OPEN-SANDBOX-API-KEY: k' 'http://127.0.0.1:8090/v1/sandboxes'",
  );
});

test("listCommand uses the default key when omitted", () => {
  assert.equal(
    listCommand(DEFAULT_API_KEY),
    `curl -fsS -H 'OPEN-SANDBOX-API-KEY: ${DEFAULT_API_KEY}' 'http://127.0.0.1:8090/v1/sandboxes'`,
  );
});

test("buildCreatePayload: exact objective payload (key order + explicit values)", () => {
  assert.equal(
    buildCreatePayload("python:3.11", "1", "1Gi", 120, "mine"),
    '{"image":{"uri":"python:3.11"},"timeout":120,"resourceLimits":{"cpu":"1","memory":"1Gi"},"entrypoint":["sh","-c","while :; do sleep 3600; done"],"metadata":{"name":"mine"}}',
  );
});

test("buildCreatePayload: defaults for timeout/cpu/memory/name", () => {
  assert.equal(
    buildCreatePayload("python:3.11"),
    '{"image":{"uri":"python:3.11"},"timeout":900,"resourceLimits":{"cpu":"500m","memory":"512Mi"},"entrypoint":["sh","-c","while :; do sleep 3600; done"],"metadata":{"name":"atomic-sandbox"}}',
  );
});

test("createCommand: POST with key, content-type, payload, url", () => {
  const payload = buildCreatePayload("python:3.11");
  assert.equal(
    createCommand("k", "python:3.11"),
    `curl -fsS -X POST -H 'OPEN-SANDBOX-API-KEY: k' -H 'Content-Type: application/json' -d '${payload}' 'http://127.0.0.1:8090/v1/sandboxes'`,
  );
});

test("endpointCommand: server-proxied execd endpoint url", () => {
  assert.equal(
    endpointCommand("k", "sbx_1"),
    "curl -fsS -H 'OPEN-SANDBOX-API-KEY: k' 'http://127.0.0.1:8090/v1/sandboxes/sbx_1/endpoints/44772?use_server_proxy=true'",
  );
});

test("postCommandCommand: streaming POST with -w status tag, raw command", () => {
  assert.equal(
    postCommandCommand("k", "http://127.0.0.1:8090/proxy/sbx_1", "echo hi"),
    `curl -sS -X POST -H 'OPEN-SANDBOX-API-KEY: k' -H 'Content-Type: application/json' -d '{"command":"echo hi","background":false,"timeout":30000}' -w '\\n__HTTP_CODE__:%{http_code}' 'http://127.0.0.1:8090/proxy/sbx_1/command'`,
  );
});

test("postCommandCommand shell-quotes a command containing a single quote", () => {
  // The raw command is JSON-encoded (single quotes survive JSON), then q()
  // escapes each `'` as `'\''` for the POSIX single-quoted -d argument.
  const cmd = postCommandCommand("k", "http://127.0.0.1:8090/proxy/sbx_1", "echo 'a'");
  assert.ok(
    cmd.includes(`{"command":"echo '\\''a'\\''","background":false,"timeout":30000}`),
    `got: ${cmd}`,
  );
});

test("destroyCommand: DELETE the sandbox", () => {
  assert.equal(
    destroyCommand("k", "sbx_1"),
    "curl -fsS -X DELETE -H 'OPEN-SANDBOX-API-KEY: k' 'http://127.0.0.1:8090/v1/sandboxes/sbx_1'",
  );
});

test("splitHttpCode: splits the -w tag into body + string code", () => {
  assert.deepEqual(splitHttpCode("body here\n__HTTP_CODE__:200"), { body: "body here", code: "200" });
});

test("splitHttpCode: keeps the newline before a double-newline tag", () => {
  assert.deepEqual(splitHttpCode("abc\n\n__HTTP_CODE__:502"), { body: "abc\n", code: "502" });
});

test("splitHttpCode: no tag -> full body, code null", () => {
  assert.deepEqual(splitHttpCode("just body"), { body: "just body", code: null });
});

test("splitHttpCode: empty string", () => {
  assert.deepEqual(splitHttpCode(""), { body: "", code: null });
});

test("parseSse: concatenates stdout across events + execution_complete", () => {
  const p = parseSse(
    'data: {"type":"stdout","text":"line1\\n"}\ndata: {"type":"stdout","text":"line2"}\ndata: {"type":"execution_complete"}\n',
  );
  assert.equal(p.stdout, "line1\nline2");
  assert.equal(p.executionComplete, true);
});

test("parseSse: captures stderr, error object, and results object", () => {
  const p = parseSse(
    'data: {"type":"stderr","text":"err line"}\ndata: {"type":"error","text":"boom"}\ndata: {"type":"result","results":{"exitCode":0}}\n',
  );
  assert.equal(p.stderr, "err line");
  assert.deepEqual(p.error, { type: "error", text: "boom" });
  assert.deepEqual(p.results, { exitCode: 0 });
});

test("parseSse: malformed / non-data lines are skipped", () => {
  const p = parseSse("not json\ndata: {bad\ndata: {}\n");
  assert.equal(p.stdout, "");
  assert.equal(p.executionComplete, false);
  assert.equal(p.error, null);
  assert.equal(p.results, null);
});

test("parseSse: ignores event: and id: lines", () => {
  const p = parseSse('event: out\ndata: {"type":"stdout","text":"x"}\nid: 1\n');
  assert.equal(p.stdout, "x");
});

test("parseSse: bare-JSON execd framing (no data: prefix, blank-line separated) is parsed", () => {
  const p = parseSse(
    '{"type":"init","timestamp":1}\n\n{"type":"stdout","text":"line1\\n"}\n\n{"type":"stdout","text":"line2"}\n\n{"type":"execution_complete"}\n',
  );
  assert.equal(p.stdout, "line1\nline2");
  assert.equal(p.executionComplete, true);
});

test("parseSse: a no-output command still carries execution_complete", () => {
  const p = parseSse('{"type":"execution_complete"}\n');
  assert.equal(p.stdout, "");
  assert.equal(p.executionComplete, true);
});

test("parseSse: mixed data:-framed and bare JSON lines both parse", () => {
  const p = parseSse('data: {"type":"stdout","text":"a"}\n{"type":"stderr","text":"b"}\n');
  assert.equal(p.stdout, "a");
  assert.equal(p.stderr, "b");
});

test("parseSse: bare-JSON malformed lines are skipped, like data:-framed ones", () => {
  assert.equal(parseSse("not json\n\n{bad\n\n{\"type\":\"stdout\",\"text\":\"ok\"}\n").stdout, "ok");
});

test("curlFormValue: quotes+escapes on ';', '\"' or '\\'; leaves plain values verbatim", () => {
  assert.equal(curlFormValue("a;b.txt"), '"a;b.txt"');
  assert.equal(curlFormValue('we"ird.txt'), '"we\\"ird.txt"');
  assert.equal(curlFormValue("a\\b.txt"), '"a\\\\b.txt"');
  assert.equal(curlFormValue("a b.txt"), "a b.txt");
  assert.equal(curlFormValue("it's here.txt"), "it's here.txt");
  assert.equal(curlFormValue("plain.txt"), "plain.txt");
});

test("curlFormValue: the metadata JSON round-trips through curl's unescape", () => {
  // emulate curl 8.21's quoted-form semantics (verified live with a capture probe):
  // strip the wrapping quotes, unescape \" and \\
  const unescape = (v) => v.slice(1, -1).replace(/\\(["\\])/g, "$1");
  assert.equal(unescape(curlFormValue('{"path":"/tmp/a; b","mode":644}')), '{"path":"/tmp/a; b","mode":644}');
  assert.equal(unescape(curlFormValue('{"path":"/tmp/we\\"ird; q","mode":644}')), '{"path":"/tmp/we\\"ird; q","mode":644}');
});

test("classifyAttempt: 2xx with output or completion is ok", () => {
  assert.equal(classifyAttempt("200", P({ stdout: "x" })), "ok");
  assert.equal(classifyAttempt("200", P({ stderr: "y" })), "ok");
  assert.equal(classifyAttempt("200", P({ executionComplete: true })), "ok");
});

test("classifyAttempt: empty 2xx stream is warmup (execd not ready)", () => {
  assert.equal(classifyAttempt("200", P()), "warmup");
});

test("classifyAttempt: a bare-JSON execd stream that executed is ok, even without output", () => {
  // Live-captured gVisor execd framing: bare JSON lines, no `data:` prefix.
  // A no-output command still ends in execution_complete -> a run that happened.
  const bare = '{"type":"init","timestamp":1}\n\n{"type":"execution_complete"}\n';
  assert.equal(classifyAttempt("200", parseSse(bare)), "ok");
});

test("classifyAttempt: a cold proxy emits no events — 2xx empty stream is still warmup", () => {
  assert.equal(classifyAttempt("200", parseSse("")), "warmup");
  assert.equal(classifyAttempt(null, parseSse("")), "warmup");
});

test("classifyAttempt: no status or any 5xx is warmup", () => {
  assert.equal(classifyAttempt(null, P()), "warmup");
  assert.equal(classifyAttempt("0", P()), "warmup");
  assert.equal(classifyAttempt("502", P()), "warmup");
  assert.equal(classifyAttempt("503", P()), "warmup");
  assert.equal(classifyAttempt("500", P()), "warmup");
});

test("classifyAttempt: 3xx/4xx are definitive errors (fail fast)", () => {
  assert.equal(classifyAttempt("404", P()), "error");
  assert.equal(classifyAttempt("400", P()), "error");
  assert.equal(classifyAttempt("301", P()), "error");
});

test("extractEndpoint: endpoint / url / uri keys", () => {
  assert.equal(extractEndpoint('{"endpoint":"http://127.0.0.1:8090/proxy/sbx_1"}'), "http://127.0.0.1:8090/proxy/sbx_1");
  assert.equal(extractEndpoint('{"url":"http://x:1/y"}'), "http://x:1/y");
  assert.equal(extractEndpoint('{"uri":"http://z:2/w"}'), "http://z:2/w");
});

test("extractEndpoint: null / invalid / missing -> null", () => {
  assert.equal(extractEndpoint("no endpoint here"), null);
  assert.equal(extractEndpoint('{"other":1}'), null);
  assert.equal(extractEndpoint(null), null);
});

test("normalizeEndpointUrl: keeps an existing scheme", () => {
  assert.equal(normalizeEndpointUrl("http://127.0.0.1:8090/proxy/sbx_1"), "http://127.0.0.1:8090/proxy/sbx_1");
  assert.equal(normalizeEndpointUrl("https://x:1/y"), "https://x:1/y");
});

test("normalizeEndpointUrl: prefixes http:// when the scheme is omitted", () => {
  assert.equal(normalizeEndpointUrl("127.0.0.1:8090/proxy/sbx_1"), "http://127.0.0.1:8090/proxy/sbx_1");
  assert.equal(normalizeEndpointUrl("host/path"), "http://host/path");
});

test("normalizeEndpointUrl: null / empty -> null", () => {
  assert.equal(normalizeEndpointUrl(null), null);
  assert.equal(normalizeEndpointUrl(""), null);
});
