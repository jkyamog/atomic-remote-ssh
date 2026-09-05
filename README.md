# atomic-remote-ssh

Remote execution over SSH for atomic workflow stages, as a plain extension. Two modes load at the same time:

1. **Additive tools** — `remote_bash`, `remote_read`, `remote_write`: each call carries its own `host` (and optional `cwd`), so concurrent stages may target different machines with no shared state.
2. **Transparent routing** — `ssh_connect` / `ssh_disconnect`: this session's built-in `read`/`write`/`edit`/`bash` tools are transparently routed to the remote host, keyed per session. Sessions that never connect keep plain local tools.

Auth rides the ssh-agent sidecar (`SSH_AUTH_SOCK` is inherited from the launcher env); keys never enter the container. ControlMaster multiplexing keeps per-call latency low.

## Tools

| Tool | Parameters | Defaults / clamps |
|---|---|---|
| `remote_bash` | `host`, `command`, `cwd?`, `timeout_seconds?` | kill after `min(max(sec ?? 120, 5), 900)` seconds |
| `remote_read` | `host`, `path`, `max_bytes?` | `min(max_bytes ?? 200000, 1000000)`; 60 s ssh timeout |
| `remote_write` | `host`, `path`, `content` | base64 over stdin, `mkdir -p` of parent dir; 60 s ssh timeout |
| `ssh_connect` | `host`, `cwd?` | `cwd` defaults to remote home; created if missing |
| `ssh_disconnect` | — | — |

Output over 40 000 characters is capped to the first 12 000 + `\n...[truncated]...\n` + last 12 000.

## Install

Clone (or download) this repo, then copy the entry file **and** the shared subdirectory into your extensions dir:

```bash
git clone https://github.com/jkyamog/atomic-remote-ssh
EXT=~/.atomic/agent/extensions        # or legacy ~/.pi/agent/extensions
mkdir -p "$EXT"
cp atomic-remote-ssh/atomic-remote-ssh.ts "$EXT/"
cp -r atomic-remote-ssh/atomic-remote-ssh "$EXT/"
```

Do not rename the `atomic-remote-ssh/` subdirectory and do not add an `index.ts` inside it — the loader auto-discovers top-level `*.ts` entries, and a stray `index.ts` would load as a second extension.

### Make the host's modules resolvable (node_modules symlinks)

The entry imports `typebox` and lazily imports `@bastani/atomic`. The extensions dir has no `package.json`, so point node at the host install:

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

## Usage

Additive (any session, no shared state):

```
remote_bash(host="user@example.host", command="uname -a")
remote_read(host="user@example.host", path="/etc/hostname")
remote_write(host="user@example.host", path="/tmp/hello.txt", content="hi")
```

Transparent (per session):

```
ssh_connect(host="user@example.host", cwd="/home/user/Projects/foo")
# -> CONNECTED user@example.host:/home/user/Projects/foo hostname=example-host overrides=registered session=<sid13>
# built-in read/write/edit/bash now route to the remote host (local-cwd prefix maps to remote cwd)
ssh_disconnect()
# -> DISCONNECTED (built-ins local again)
```

Concurrent sessions route independently: the target is keyed by `sessionManager.sessionId` (falling back to `sessionFile`, then `__global__`), and the overrides are re-registered on **every** `ssh_connect` because `registerTool` binds to the caller's session.

In real atomic sessions `ctx` is always supplied by the loader (`runner.createContext()` → the runner's live `SessionManager`), and `SessionManager.sessionId` is always non-empty, so targets are strictly per-session. The `__global__` fallback exists only for out-of-loader test harnesses; if it were ever hit in production, multiple callers would silently share one target.

## Development

- Tests: `node --test` from the repo root (node ≥ 22.18 with native type stripping). No network, no real ssh — the spawner is injected. `node --test test/` is NOT supported on node 22 (the directory is treated as an entry module); use `node --test` or a glob.
- The five core modules (`atomic-remote-ssh/ssh.ts`, `targets.ts`, `paths.ts`, `commands.ts`, `ops.ts`) import neither `typebox` nor `@bastani/atomic`, so they unit-test under plain `node --test`. Tool-registration tests self-skip when `typebox` is not resolvable in the test environment.
- Deep-module design: `ssh.ts` (transport, injectable spawner), `targets.ts` (per-session target registry), `paths.ts` (local→remote path mapping), `commands.ts` (remote shell command construction + clamps), `ops.ts` (transparent-mode operations bundles) — each a small interface hiding one concern.
- License: MIT (see `LICENSE`).
