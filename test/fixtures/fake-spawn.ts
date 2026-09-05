/**
 * Shared test stub: fake child-process spawner.
 * createFakeSpawn() -> { fn, calls, children }.
 * The fake does NOT auto-fire data/close events; tests drive child.stdout/
 * stderr/close manually so timing stays deterministic. A fatal kill()
 * mimics a real child by emitting close(null). Each call records
 * { file, args, opts, child } on calls[i].
 */

import { EventEmitter } from "node:events";

export function createFakeSpawn() {
  const calls = [];
  const children = [];
  const fn = (file, args, opts) => {
    const child = new EventEmitter();
    child.kill = (sig) => {
      child.killed = true;
      child.killSignal = sig;
      // mimic a real child: a fatal signal ends the process (close, null code)
      child.emit("close", null);
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (data) => {
      child.stdin.data = data;
      child.stdin.ended = true;
      child.stdin.emit("end");
    };
    const call = { file, args, opts, child };
    calls.push(call);
    children.push(child);
    return child;
  };
  return { fn, calls, children };
}
