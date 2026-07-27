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
export function buildRemoteCommand({ activate = "", baseDir, env = {}, command }) {
  if (!baseDir) throw new Error("A baseDir is required.");
  if (!command) throw new Error("A command is required.");

  const steps = [];
  // `.` rather than `source` so this works under a plain POSIX shell too.
  // `|| :` keeps a missing venv from aborting the chain; POSIX parses the
  // sequence left to right, so this reads as (activate || true) && cd && cmd.
  if (activate) steps.push(`. ${quoteRemotePath(activate)} 2>/dev/null || :`);
  steps.push(`cd ${quoteRemotePath(baseDir)}`);

  const prefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)} `)
    .join("");
  steps.push(`${prefix}${command}`);

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
