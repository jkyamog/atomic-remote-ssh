# Deploying extensions from this repo

This repo hosts TWO atomic extensions sharing one transport:

```
extensions/
├── atomic-remote-ssh/       ← transport + remote_bash/read/write + transparent ssh_connect
└── atomic-remote-sandbox/   ← OpenSandbox lifecycle tools (imports ../atomic-remote-ssh/ssh.ts)
atomic-remote-ssh.ts         ← entry (repo layout: imports ./extensions/atomic-remote-ssh/*)
atomic-remote-sandbox.ts     ← entry (repo layout: imports ./extensions/atomic-remote-sandbox/*)
```

## The deploy-time import rule (do not skip)

Atomic's extension directory is FLAT: each extension is `<name>.ts` (entry) plus `<name>/`
(code dir), side by side in `~/.atomic/agent/extensions/`. The repo uses an
`extensions/` parent that does not exist at the deploy target.

Therefore a deployed ENTRY must use **flat imports**:

```ts
// repo (atomic-remote-sandbox.ts):          deployed ($EXT/atomic-remote-sandbox.ts):
import { X } from "./extensions/             import { X } from "./
  atomic-remote-sandbox/tools.ts";             atomic-remote-sandbox/tools.ts";
```

Deployed DIR files are copied verbatim (byte-identical); only the entry's import
prefix changes. A deployed entry carrying repo-style `./extensions/...` imports will
fail to resolve — this is not a bug in the extension, it is a broken deploy.

## Deploy checklist (per extension)

1. Copy `extensions/<name>/*.ts` → `$EXT/<name>/` verbatim (currently no node_modules
   needed — the loader resolves `typebox` from the app; revisit if imports grow).
2. Copy the root `<name>.ts` entry → `$EXT/<name>.ts` with the import prefix flattened
   to `./<name>/`.
3. Smoke: `docker exec atomic atomic -p "reply with exactly: ok"` — clean output with
   no extension warnings.
4. Running sessions are unaffected (modules already loaded); new sessions pick it up.

$EXT = the atomic-home extensions dir, e.g. `~/Tools/atomic/data/atomic-home/agent/extensions/`
on the erabus deployment.

## Known deployed-state notes (2026-09-06)

- Deployed `atomic-remote-ssh` entry intentionally keeps flat imports (see rule above);
  it is one restructure behind the repo layout but byte-consistent and loading clean.
- Sandbox tools target the OpenSandbox manager at `127.0.0.1:8090` on the remote host
  (loopback-only, T13 F6) with default API key `poc-t13-nyx` — replace with per-job
  keys when T12 step 11 lands.
