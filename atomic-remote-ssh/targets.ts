/**
 * Per-session remote target registry.
 * Module state is shared across stage sessions (one process), so all state
 * is keyed by session — never global.
 *
 * Invariant: in real atomic sessions ctx is always supplied by the loader
 * (runner.createContext() -> ExtensionRunner.sessionManager), and
 * SessionManager.sessionId is always non-empty, so targets are strictly
 * per-session. The "__global__" fallback below exists only for
 * out-of-loader test harnesses; if it were ever hit in production, multiple
 * callers would silently share one target.
 */

/** sessionManager.sessionId -> sessionFile -> "__global__". */
export function sidOf(ctx) {
  const sm = ctx && ctx.sessionManager;
  if (sm && sm.sessionId) return String(sm.sessionId);
  if (sm && sm.sessionFile) return String(sm.sessionFile);
  return "__global__";
}

/** { get(sid), set(sid, target), del(sid) -> boolean } over a Map. */
export function createTargetRegistry() {
  const m = new Map();
  return {
    get: (sid) => m.get(sid),
    set: (sid, target) => m.set(sid, target),
    del: (sid) => m.delete(sid),
  };
}
