# atomic-remote-extensions

Remote execution + OpenSandbox lifecycle for atomic workflow stages, as plain
extensions. Two extensions ship in this repo, both over the same SSH transport:

1. **atomic-remote-ssh** — remote execution over SSH. Two modes load at the same time:
   - **Additive tools** — `remote_bash`, `remote_read`, `remote_write`: each call carries its own `host` (and optional `cwd`), so concurrent stages may target different machines with no shared state.
   - **Transparent routing** — `ssh_connect` / `ssh_disconnect`: this session's built-in `read`/`write`/`edit`/`bash` tools are transparently routed to the remote host, keyed per session. Sessions that never connect keep plain local tools.
2. **atomic-remote-sandbox** — OpenSandbox lifecycle, command execution, and file transfer. Six additive tools, each call carrying its own `host` (the OpenSandbox lifecycle manager is loopback-only at `127.0.0.1:8090` on that host).

Auth rides the ssh-agent sidecar (`SSH_AUTH_SOCK` is inherited from the launcher env); keys never enter the container. ControlMaster multiplexing keeps per-call latency low. The sandbox extension reuses the ssh transport (`createSshRunner`) — there is no duplicate ssh layer.

## Layout

Both extensions live under `extensions/`; each root `*.ts` file is one extension's entry (the loader auto-discovers top-level `*.ts` files):

```
atomic-remote-ssh.ts        # entry: registerRemoteSsh
atomic-remote-sandbox.ts    # entry: registerRemoteSandbox
extensions/
  atomic-remote-ssh/        # ssh.ts, targets.ts, paths.ts, commands.ts, ops.ts,
                            #   remote-tools.ts, transparent-tools.ts
  atomic-remote-sandbox/    # commands.ts, execd.ts, sandbox-tools.ts, file-tools.ts
test/                       # node --test (spawner injected, no real ssh)
```

## atomic-remote-ssh

| Tool | Parameters | Defaults / clamps |
|---|---|---|
| `remote_bash` | `host`, `command`, `cwd?`, `timeout_seconds?` | kill after `min(max(sec ?? 120, 5), 1800)` seconds |
| `remote_read` | `host`, `path`, `max_bytes?` | `min(max_bytes ?? 200000, 1000000)`; 60 s ssh timeout |
| `remote_write` | `host`, `path`, `content` | base64 over stdin, `mkdir -p` of parent dir; 60 s ssh timeout |
| `ssh_connect` | `host`, `cwd?` | `cwd` defaults to remote home; created if missing |
| `ssh_disconnect` | — | — |

Output over 40 000 characters is capped to the first 12 000 + `\n...[truncated]...\n` + last 12 000.

## atomic-remote-sandbox

Six additive tools against the OpenSandbox lifecycle manager (`127.0.0.1:8090` on the target host). Auth is the `OPEN-SANDBOX-API-KEY` header (default `poc-t13-nyx`; override per call with `api_key`).

| Tool | Parameters | Notes |
|---|---|---|
| `sandbox_list` | `host`, `api_key?` | `GET /v1/sandboxes`; returns the raw manager JSON |
| `sandbox_create` | `host`, `image`, `cpu?`, `memory?`, `timeout?`, `name?`, `api_key?` | `POST /v1/sandboxes`; defaults `cpu=500m`, `memory=512Mi`, `timeout=900`, `name=atomic-sandbox`; 1800 s ssh timeout (long docker pulls) |
| `sandbox_exec` | `host`, `sandbox_id`, `command`, `api_key?` | resolves the server-proxied execd endpoint (`GET /v1/sandboxes/{id}/endpoints/44772?use_server_proxy=true`), then `POST {endpoint}/command`; concatenates the SSE `stdout` stream and reports `execution_complete` |
| `sandbox_push` | `host`, `sandbox_id`, `local_path`, `remote_path`, `mode?`, `owner?`, `group?`, `api_key?` | `POST {endpoint}/files/upload` multipart — metadata JSON part + file part fed through the ssh leg's stdin; then `GET /files/info` must report the local byte length; 120 s ssh timeout |
| `sandbox_pull` | `host`, `sandbox_id`, `remote_path`, `local_path`, `api_key?` | `GET {endpoint}/files/download` into a host-side temp file, bytes travel back base64-armored (32 000-char chunks when long), sha256-checked against the host-side hash, written locally as tmp + rename; the host temp is removed on every path; 120 s ssh timeout |
| `sandbox_destroy` | `host`, `sandbox_id`, `api_key?` | `DELETE /v1/sandboxes/{id}`, then re-lists to confirm the id is gone |

### The create payload

`sandbox_create` posts this exact JSON (key order preserved by `JSON.stringify`):

```json
{"image":{"uri":"<image>"},"timeout":<timeout ?? 900>,"resourceLimits":{"cpu":"<cpu ?? 500m>","memory":"<memory ?? 512Mi>"},"entrypoint":["sh","-c","while :; do sleep 3600; done"],"metadata":{"name":"<name ?? atomic-sandbox>"}}
```

The `entrypoint` is a no-op keep-alive loop (`while :; do sleep 3600; done`) so the container stays alive and reachable for `sandbox_exec`.

### Execd warmup retry (never fail fast)

The gVisor execd proxy returns `502` (or an empty stream) until it is warm. `sandbox_exec` therefore **never fails fast on the first attempt**: it retries up to **5 attempts, 5 s apart**, on a `502`/`5xx`/no-status response or an empty `2xx` stream. A `3xx`/`4xx` is a definitive client error and fails fast (no retry). Each attempt is observable via curl's `-w '\n__HTTP_CODE__:%{http_code}'` write-out.

The same shared helper backs `sandbox_push` and `sandbox_pull`; their `/files` calls carry no SSE, so the verdict is the status tag alone: `2xx` ok, `5xx`/no-status retry, `3xx`/`4xx` fail fast.

### File transfer (`sandbox_push` / `sandbox_pull`)

The OpenSandbox execd files API does the file semantics; the tools only adapt transport (server-proxied endpoint + the warmup retry above).

`sandbox_push` uploads a controller-side file. `mode` is the octal permission digits expressed as a decimal int (e.g. `644`, `755`); when omitted it defaults to `755` if the source has any execute bit, else `644`. After upload, `GET /files/info` must report the local byte length or the call fails.

```
sandbox_push(host="user@example.host", sandbox_id="sbx_...", local_path="./build/app.bin", remote_path="/app/app.bin", mode=755)
# -> pushed ./build/app.bin -> /app/app.bin bytes=48231 mode=755
# local=48231 remote=48231
```

`sandbox_pull` downloads a sandbox file. The ssh leg returns utf8 text, so the host-side bytes are base64-armored — one read when short, 32 000-char chunks otherwise (the runner caps stdout at 40 000 chars) — then sha256-verified against the host-side hash and written atomically (tmp + rename, never partial):

```
sandbox_pull(host="user@example.host", sandbox_id="sbx_...", remote_path="/var/log/app.log", local_path="./out/app.log")
# -> pulled /var/log/app.log -> ./out/app.log bytes=1823 chunks=1
# sha256_local=<hex> sha256_remote=<hex> match=true
```

## Install

Clone (or download) this repo, then copy **both** entry files and the shared `extensions/` subdirectory into your extensions dir:

```bash
git clone https://github.com/jkyamog/atomic-remote-extensions
EXT=~/.atomic/agent/extensions        # or legacy ~/.pi/agent/extensions
mkdir -p "$EXT"
cp atomic-remote-ssh.ts atomic-remote-sandbox.ts "$EXT/"
cp -r extensions "$EXT/"
```

The entries import from `./extensions/...`, so the `extensions/` subdirectory must sit next to them. Do not add an `index.ts` inside a subdirectory — the loader auto-discovers top-level `*.ts` entries, and a stray `index.ts` would load as a second extension.

> Container deployments may flatten the layout (one subdirectory per extension, e.g. `$EXT/atomic-remote-ssh/` + `$EXT/atomic-remote-sandbox/`) and point the entry imports at the flat paths; the module files themselves are unchanged.

### Make the host's modules resolvable (node_modules symlinks)

The entries import `typebox` and lazily import `@bastani/atomic`. The extensions dir has no `package.json`, so point node at the host install:

```bash
EXT=~/.atomic/agent/extensions
mkdir -p "$EXT/node_modules/@bastani"
ln -sfn "$(npm root -g)/@bastani/atomic/node_modules/typebox" "$EXT/node_modules/typebox"
ln -sfn "$(npm root -g)/@bastani/atomic" "$EXT/node_modules/@bastani/atomic"
```

### SSH_AUTH_SOCK sidecar

Auth rides the agent: `SSH_AUTH_SOCK` must be present in the agent process's environment (inherited from the launcher). Keys never enter the container. The ControlMaster multiplexing socket lives at `~/.cache/atomic-ssh/%C` in a `0700` directory created at load (`ControlPersist=120`); `%C` is OpenSSH's hash of the connection tuple, so host/user pairs are not enumerable from the socket name.

### Restart-to-reload-modules caveat

Extension modules are cached by the loader. `/reload` re-runs the entry file, but trust a full restart for module-graph changes (new or renamed files in the subdirectory).

### Loader syntax constraints (when editing)

- The entry must be a top-level `*.ts` in the extensions dir.
- Shared code lives in a **subdirectory** only (top-level non-entry `.ts` files are rejected).
- Syntax must be jiti/babel-safe plain TS **and** erasable: no `type`/`interface` aliases, no `enum`, no namespaces, no parameter properties, no generic calls (`new Promise<T>(…)`, `arr.reduce<T>(…)`). Type annotations on params/returns are fine.
- Verify loading with `atomic -p "hi"` — it surfaces `Failed to load extension` with `file:line` on parse errors.

### known_hosts caveat

`BatchMode=yes` disables interactive prompts, so with `StrictHostKeyChecking` at its default (`ask`), the **first** connection to a host not already in `~/.ssh/known_hosts` **fails** with host key verification failure (it will not prompt). Pre-populate on the machine where atomic executes ssh:

```bash
ssh-keyscan -H example-host >> ~/.ssh/known_hosts
```

### SSH alias gotcha

Use the FQDN, e.g. `user@example.host`. A bare `example-host` can resolve to `127.0.1.1` and fail.

`host` is `user@host` (charset-only) — no `:port` suffix, which OpenSSH's `ssh` destination syntax does not support (that is scp/sftp syntax). For non-default ports, configure `Host <name>` + `Port <n>` in `~/.ssh/config` and pass that alias as `host`.

## Usage

Additive ssh (any session, no shared state):

```
remote_bash(host="user@example.host", command="uname -a")
remote_read(host="user@example.host", path="/etc/hostname")
remote_write(host="user@example.host", path="/tmp/hello.txt", content="hi")
```

Transparent ssh (per session):

```
ssh_connect(host="user@example.host", cwd="/home/user/Projects/foo")
# -> CONNECTED user@example.host:/home/user/Projects/foo hostname=example-host overrides=registered session=<sid13>
# built-in read/write/edit/bash now route to the remote host (local-cwd prefix maps to remote cwd)
ssh_disconnect()
# -> DISCONNECTED (built-ins local again)
```

Concurrent sessions route independently: the target is keyed by `sessionManager.sessionId` (falling back to `sessionFile`, then `__global__`), and the overrides are re-registered on **every** `ssh_connect` because `registerTool` binds to the caller's session.

In real atomic sessions `ctx` is always supplied by the loader (`runner.createContext()` → the runner's live `SessionManager`), and `SessionManager.sessionId` is always non-empty, so targets are strictly per-session. The `__global__` fallback exists only for out-of-loader test harnesses; if it were ever hit in production, multiple callers would silently share one target.

OpenSandbox lifecycle:

```
sandbox_create(host="user@example.host", image="python:3.11", cpu="1", memory="1Gi", timeout=120, name="mine")
# -> created id=sbx_... state=Running
sandbox_exec(host="user@example.host", sandbox_id="sbx_...", command="python -c 'print(1+1)'")
# -> 2
# [execution_complete: true]
sandbox_list(host="user@example.host")
sandbox_destroy(host="user@example.host", sandbox_id="sbx_...")
# -> destroyed sbx_... (confirmed gone)
```

Sandbox file transfer:

```
sandbox_push(host="user@example.host", sandbox_id="sbx_...", local_path="./config.json", remote_path="/app/config.json")
# -> pushed ./config.json -> /app/config.json bytes=512 mode=644
# local=512 remote=512
sandbox_pull(host="user@example.host", sandbox_id="sbx_...", remote_path="/tmp/report.txt", local_path="./out/report.txt")
# -> pulled /tmp/report.txt -> ./out/report.txt bytes=8734 chunks=1
# sha256_local=<hex> sha256_remote=<hex> match=true
```

## Development

- Tests: `node --test` from the repo root (node ≥ 22.18 with native type stripping). No network, no real ssh — the spawner is injected. `node --test test/` is NOT supported on node 22 (the directory is treated as an entry module); use `node --test` or a glob.
- The core modules (`atomic-remote-ssh/{ssh,targets,paths,commands,ops}.ts` and `atomic-remote-sandbox/{commands,execd}.ts`) import neither `typebox` nor `@bastani/atomic`, so they unit-test under plain `node --test`. Tool-registration tests self-skip when `typebox` is not resolvable in the test environment.
- Deep-module design:
  - `atomic-remote-ssh`: `ssh.ts` (transport, injectable spawner), `targets.ts` (per-session target registry), `paths.ts` (local→remote path mapping), `commands.ts` (remote shell command construction + clamps), `ops.ts` (transparent-mode operations bundles).
  - `atomic-remote-sandbox`: `commands.ts` (curl command construction + SSE/endpoint parsing + retry classification + file-transfer command builders), `execd.ts` (shared endpoint resolution + warmup retry), `sandbox-tools.ts` (the four lifecycle typebox tools, sharing the ssh transport), `file-tools.ts` (`sandbox_push` / `sandbox_pull`).
  - Each is a small interface hiding one concern; the two entries wire the tools to `createSshRunner()`.
- License: MIT (see `LICENSE`).
