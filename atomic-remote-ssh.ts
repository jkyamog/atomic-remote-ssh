/**
 * atomic-remote-ssh — remote SSH execution for atomic workflow stages.
 *
 * Two modes, both live at the same time:
 *  1. Additive: remote_bash / remote_read / remote_write — each call
 *     carries its own host. Concurrent stages may target different
 *     machines with no shared state.
 *  2. Transparent: ssh_connect / ssh_disconnect route THIS session's
 *     built-in read/write/edit/bash tools to a remote host, keyed per
 *     session. Sessions that never connect keep plain local tools.
 *
 * Auth rides the ssh-agent sidecar (SSH_AUTH_SOCK is inherited from the
 * launcher env); keys never enter the container.
 * ControlMaster multiplexing keeps per-call latency low.
 */

import { createSshRunner } from "./atomic-remote-ssh/ssh.ts";
import { createTargetRegistry } from "./atomic-remote-ssh/targets.ts";
import { registerAdditiveTools } from "./atomic-remote-ssh/remote-tools.ts";
import { registerTransparentTools } from "./atomic-remote-ssh/transparent-tools.ts";

export default function registerRemoteSsh(pi) {
  const deps = {
    sshExec: createSshRunner(),
    targets: createTargetRegistry(),
    localCwd: process.cwd(),
  };
  registerAdditiveTools(pi, deps);
  registerTransparentTools(pi, deps);
}
