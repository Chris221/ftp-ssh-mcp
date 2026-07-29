// Turn a configured base directory into the one this connection will actually
// use.
//
// Shared by both file transports so the tilde rule cannot drift between them:
// the SFTP and FTP adapters previously carried hand-duplicated connection code
// which had already diverged once (see the note on buildAuthOptions in
// ../ssh.mjs), and this is the same kind of shared rule.

import { expandRemoteBase, isHomeRelative } from "../guards.mjs";

/**
 * Resolve `baseDir` for a live connection, asking the server for its login
 * directory only when there is a `~` to expand.
 *
 * `lookup` is the protocol's way of asking "where did I land?" — realpath(".")
 * over SFTP, PWD over FTP. `variable` is the environment variable to name if
 * anything goes wrong, because a protocol-level error on its own gives the user
 * nothing to change. That includes expandRemoteBase's own refusal: it is
 * deliberately variable-agnostic (it does no I/O and does not know which
 * profile it serves), so its bare message never names what to edit — this is
 * the one place that does, since this is the one place that knows. A tilde most
 * often arrives through REMOTE_BASE_DIR, or reaches a profile via the
 * cross-profile fallback in ../config.mjs, so both messages name that too.
 */
export async function effectiveBaseDir(baseDir, variable, lookup) {
  const base = baseDir ?? "";
  if (!isHomeRelative(base)) return base;

  let home;
  try {
    home = await lookup();
  } catch (err) {
    throw new Error(
      `${variable} (or REMOTE_BASE_DIR) is "${base}", but the account's login directory ` +
        `could not be resolved, so the "~" cannot be expanded: ${err.message}`,
      { cause: err }
    );
  }

  try {
    return expandRemoteBase(base, home);
  } catch (err) {
    // expandRemoteBase's own message already quotes `base`, so this only adds
    // which variable to change, not the value again.
    throw new Error(`${variable} (or REMOTE_BASE_DIR): ${err.message}`, { cause: err });
  }
}
