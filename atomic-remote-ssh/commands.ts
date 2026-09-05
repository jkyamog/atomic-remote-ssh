/**
 * Remote shell command construction + numeric clamps.
 * All quoting goes through POSIX single-quote escaping (q).
 */

/** Shell-quote for POSIX sh: `'` -> `'\''`. No command substitution inside. */
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

/** remote_bash timeout clamp, in seconds: default 120, min 5, max 1800.
 * Max raised 900 -> 1800 (2026-09-05, T13 OpenSandbox POC): long docker pulls on slow upstreams.
 * nohup+poll remains the convention beyond one call. */
export function clampTimeoutSeconds(n) {
  return Math.min(Math.max(n ?? 120, 5), 1800);
}

/** remote_read max_bytes clamp: default 200_000, max 1_000_000. */
export function clampMaxBytes(n) {
  return Math.min(n ?? 200_000, 1_000_000);
}

/** `cd '<cwd>' && <command>`, or the command verbatim when no cwd. */
export function bashCommand(command, cwd) {
  return cwd ? `cd ${q(cwd)} && ${command}` : command;
}

export function catCommand(path) {
  return `cat ${q(path)}`;
}

/** `cat '<path>' | head -c <n>` (additive remote_read). */
export function readCommand(path, maxBytes) {
  return `${catCommand(path)} | head -c ${maxBytes}`;
}

/** `mkdir -p $(dirname '<path>') && base64 -d > '<path>'` (base64 over stdin). */
export function writeCommand(path) {
  return `mkdir -p $(dirname ${q(path)}) && base64 -d > ${q(path)}`;
}

export function mkdirCommand(dir) {
  return `mkdir -p ${q(dir)}`;
}

export function accessCommand(path) {
  return `test -r ${q(path)}`;
}

/** ssh_connect probe: `mkdir -p && cd && pwd`, or bare `pwd`. */
export function connectPrepareCommand(cwd) {
  return cwd
    ? `mkdir -p ${q(cwd)} && cd ${q(cwd)} && pwd`
    : "pwd";
}
