// Capability registry.
//
// A capability registers its tools only when it is both configured and allowed.
// One that is not selected never calls register(), so its tools are absent from
// the tool list — no context cost, and nothing to call by mistake.
//
// The modules themselves are imported statically: they are a few KB of tool
// definitions each. What stays lazy is the expensive part — basic-ftp, ssh2 and
// ssh2-sftp-client are loaded by dynamic import inside the transport and SSH
// modules, so an FTP-only deployment never loads the SSH stack.

import files from "./files.mjs";
import ssh from "./ssh.mjs";
import mysql from "./mysql.mjs";

/** Built-ins, in registration order. */
export const ALL = [files, ssh, mysql];

/**
 * Select the capabilities that are configured and, when MCP_CAPABILITIES is
 * set, also named in that allowlist.
 */
export function selectCapabilities(config, modules = ALL) {
  const allowed = config.requestedCapabilities;
  return modules.filter(
    (capability) =>
      capability.isConfigured(config) && (!allowed || allowed.includes(capability.name))
  );
}

/** Names in MCP_CAPABILITIES that match no built-in capability. */
export function unknownCapabilities(config, modules = ALL) {
  if (!config.requestedCapabilities) return [];
  const known = new Set(modules.map((c) => c.name));
  return config.requestedCapabilities.filter((name) => !known.has(name));
}
