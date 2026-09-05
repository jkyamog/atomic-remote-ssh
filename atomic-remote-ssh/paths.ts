/**
 * Local -> remote path mapping.
 * Only strings that are prefixed with localCwd are rewritten; everything
 * else (already-remote paths, bare relative strings, non-strings) passes
 * through unchanged.
 */
export function toRemotePath(localCwd, remoteCwd, p) {
  return typeof p === "string" && p.startsWith(localCwd)
    ? remoteCwd + p.slice(localCwd.length)
    : p;
}
