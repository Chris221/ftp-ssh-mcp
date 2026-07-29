// Dispatch to the configured file transport.
//
// A fresh connection is opened per operation and closed afterwards. This keeps
// the server stateless and avoids stale-socket bugs in an occasional-use tool.

import { withFtp } from "./ftp.mjs";
import { withSftp } from "./sftp.mjs";

/**
 * The active file profile and its base directory for the configured transport.
 * Each profile has its own base dir, because on shared hosts the FTP account
 * is often chrooted while SSH sees the full home.
 */
export function fileProfile(config, override) {
  const transport = override || config.files.transport;
  if (transport === "sftp") {
    if (!config.ssh) throw new Error("No SSH profile configured; cannot use the sftp transport.");
    return { transport, profile: config.ssh };
  }
  if (!config.ftp) throw new Error("No FTP profile configured; cannot use the ftp transport.");
  return { transport, profile: config.ftp };
}

export async function withClient(config, fn, override) {
  const { transport, profile } = fileProfile(config, override);
  if (transport === "sftp") return withSftp(profile, fn);
  return withFtp({ ...profile, secure: ftpSecurity(config) }, fn);
}

/** basic-ftp takes `true`, `"implicit"` or `false`. */
function ftpSecurity(config) {
  const mode = (config.ftpSecurity || "ftps").toLowerCase();
  if (mode === "ftps") return true;
  if (mode === "ftps-implicit") return "implicit";
  return false;
}
