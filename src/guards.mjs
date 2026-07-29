// Pure validation helpers for the MCP server.
//
// Kept separate from server.mjs so they can be tested without loading the MCP
// SDK or starting a transport, and so the rules that decide what may touch the
// live host are readable in one place.

import path from "node:path";
import os from "node:os";

const posix = path.posix;

/**
 * Expand a leading `~` in a LOCAL filesystem path.
 *
 * Only shells expand tildes, so a path like `~/.ssh/id_rsa` handed straight to
 * fs.readFile fails with ENOENT. Config files are a natural place to write one,
 * so expand it here.
 */
export function expandHome(filePath) {
  const str = String(filePath ?? "");
  if (str === "~") return os.homedir();
  if (str.startsWith("~/") || str.startsWith("~\\")) {
    return path.join(os.homedir(), str.slice(2));
  }
  return str;
}

/**
 * Does `baseDir` refer to the login account's own home — a bare `~` or a
 * `~/`-prefixed path?
 *
 * Shared by expandRemoteBase (below) and effectiveBaseDir (../transports/
 * base-dir.mjs), which also uses it to decide whether the network round trip
 * to look up the login directory is needed at all — so the two cannot drift.
 *
 * Coerces like expandHome and expandRemoteBase do, rather than assuming a
 * string. Every base directory in practice comes through normalizeBase, which
 * guarantees one — but this is exported, and a caller that hands over an unset
 * value should get "no, that is not a home reference" back, not a TypeError
 * raised mid-connect.
 */
export function isHomeRelative(baseDir) {
  const base = String(baseDir ?? "");
  return base === "~" || base.startsWith("~/");
}

/**
 * Expand a leading `~` in a REMOTE base directory.
 *
 * Unlike expandHome, which resolves against THIS machine's home, `home` here is
 * what the remote server reported for the account that logged in: realpath(".")
 * over SFTP, PWD over FTP. Neither protocol expands a tilde itself — an OpenSSH
 * server resolves `~` to a directory literally NAMED "~" under the home
 * directory — so the expansion has to happen client-side, and it can only happen
 * once a connection exists.
 *
 * A relative `home` is refused rather than used. resolveRemotePath reads a falsy
 * base as "no confinement", and a relative one would quietly rebase every path
 * onto the session's working directory; neither is what the user asked for.
 */
export function expandRemoteBase(baseDir, home) {
  const base = String(baseDir ?? "");
  if (!isHomeRelative(base)) return base;

  const login = String(home ?? "");
  if (!login.startsWith("/")) {
    throw new Error(
      `Cannot expand the base directory "${base}": the server reported its login ` +
        `directory as "${login}", which is not an absolute path.`
    );
  }

  const rest = base.slice(2);
  const normalized = posix.normalize(rest ? posix.join(login, rest) : login);
  return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
}

/**
 * Normalise a SHA-256 host-key fingerprint to lowercase hex.
 *
 * Accepts the two renderings a user actually has to hand:
 *   - `SHA256:<base64>` — what `ssh-keyscan -t rsa host | ssh-keygen -lf -`
 *     prints, with or without base64 padding.
 *   - a 64-character hex digest, with or without `:` separators, any case.
 *
 * Returns "" for anything else. That makes an unusable value distinguishable
 * from an unset one, so a typo can be reported rather than silently degrading
 * to "no verification" — the failure mode pinning exists to prevent.
 */
export function normalizeFingerprint(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";

  const body = value.replace(/^sha256:/i, "");
  const hex = body.replace(/:/g, "");
  if (/^[0-9a-f]{64}$/i.test(hex)) return hex.toLowerCase();

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    const decoded = Buffer.from(body, "base64");
    if (decoded.length === 32) return decoded.toString("hex");
  }
  return "";
}

/** Render a normalized (hex) fingerprint the way ssh-keygen prints it. */
export function formatFingerprint(hex) {
  return `SHA256:${Buffer.from(hex, "hex").toString("base64").replace(/=+$/, "")}`;
}

/** Single-quote a value for POSIX sh, neutralising any embedded quote. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a remote path that may start with `~`.
 *
 * Single-quoting a path suppresses tilde expansion, so `cd '~/site'` fails.
 * A leading `~/` becomes `"$HOME"/` and only the remainder is quoted — the
 * shell concatenates the adjacent quoted strings, so the path still cannot be
 * split or substituted.
 */
export function quoteRemotePath(value) {
  const str = String(value);
  if (str === "~") return '"$HOME"';
  if (str.startsWith("~/")) {
    const rest = str.slice(2);
    return rest ? `"$HOME"/${shellQuote(rest)}` : '"$HOME"';
  }
  return shellQuote(str);
}

/**
 * Resolve a caller-supplied remote path into a safe, normalized path.
 *
 * Rejects parent-directory traversal and, when `baseDir` is set, anything that
 * would escape it.
 */
export function resolveRemotePath(input, baseDir = "") {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("A remotePath is required.");
  }
  const cleaned = input.replace(/\\/g, "/");
  if (cleaned.split("/").includes("..")) {
    throw new Error("remotePath must not contain '..' segments.");
  }
  if (!baseDir) {
    return posix.normalize(cleaned);
  }
  const joined = posix.normalize(posix.join(baseDir, cleaned));
  const fence = baseDir.endsWith("/") ? baseDir : `${baseDir}/`;
  // This fence is unreachable in practice — the .. check above catches every
  // input that could escape. Retained deliberately as a backstop should the
  // earlier check ever be relaxed.
  if (joined !== baseDir && !joined.startsWith(fence)) {
    throw new Error("remotePath escapes the configured base directory.");
  }
  return joined;
}

/**
 * Assemble the full remote command line.
 *
 * Everything here is built from configuration, never from caller input — the
 * command itself has already been rejected if it contained anything that could
 * break out of this.
 *
 * Activation is deliberately non-fatal. cPanel's Node virtualenv may not exist
 * yet (the app has to be created first), and a missing one must not stop
 * unrelated commands like `ls` or `mysql` from running. When it is missing,
 * `npm` simply fails with "command not found", which says what is wrong.
 */
export function buildRemoteCommand({ activate = "", baseDir, command }) {
  if (!baseDir) throw new Error("A baseDir is required.");
  if (!command) throw new Error("A command is required.");

  const steps = [];
  // `.` rather than `source` so this works under a plain POSIX shell too.
  // `|| :` keeps a missing venv from aborting the chain; POSIX parses the
  // sequence left to right, so this reads as (activate || true) && cd && cmd.
  if (activate) steps.push(`. ${quoteRemotePath(activate)} 2>/dev/null || :`);
  steps.push(`cd ${quoteRemotePath(baseDir)}`);
  steps.push(command);

  // There is deliberately NO env-var-prefix option here. A `KEY='value'`
  // prefix lands in the wrapping shell's argv — the whole assembled string is
  // one `sh -c` argument — so it is exactly the wrong place for a secret:
  // `ps` shows argv to every user on the host. mysql_query used one for
  // MYSQL_PWD and exposed the password that way; secrets belong on stdin
  // (see capabilities/mysql.mjs), never in the command string.
  return steps.join(" && ");
}

// Characters that would let a caller chain, redirect or substitute their way
// past the allowlist. The allowlist only inspects the first token, so it is
// only sound while a command cannot become several commands.
const SHELL_METACHARACTERS = /[;&|`$(){}<>\n\r\\]/;

/**
 * Validate a command against an allowlist of program names.
 *
 * Deliberately strict rather than clever: anything that cannot be read as a
 * single invocation of an allowed program is refused. Returns the trimmed
 * command, or throws with the reason.
 */
export function validateCommand(command, allowedCommands = []) {
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("A command is required.");
  }
  const trimmed = command.trim();

  if (SHELL_METACHARACTERS.test(trimmed)) {
    throw new Error(
      "Command contains shell metacharacters (; & | ` $ ( ) { } < > \\ or a newline). " +
        "Only a single plain invocation is allowed — run multiple steps as separate calls."
    );
  }

  const program = trimmed.split(/\s+/)[0];
  if (!allowedCommands.includes(program)) {
    throw new Error(
      `Command "${program}" is not allowed. Permitted: ${allowedCommands.join(", ")}. ` +
        "Adjust SSH_ALLOWED_CMDS to change this."
    );
  }

  return trimmed;
}
