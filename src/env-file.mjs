// Load configuration from a .env file so credentials live in one gitignored
// place rather than in .mcp.json, which is tracked.
//
// The server is normally started by npx, so the package lives in an npm cache
// directory. Resolving relative to this module would therefore find nothing —
// discovery is anchored on the working directory, which the MCP client sets to
// the project root.

import { readFileSync } from "node:fs";
import path from "node:path";

const ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

// Both quotes must be the SAME character. The obvious /^["'](.*)["']$/ does not
// require that, so `PASSWORD="hunter2'` silently became hunter2 — a wrong
// secret on every connect, which on cPanel means repeated auth failures and
// eventually a cPHulk lockout. Quoting is also the only way to keep leading or
// trailing spaces in a value, so a quoted value must not be trimmed inside.
const QUOTED = /^(["'])([\s\S]*)\1$/;

/**
 * Resolve one raw right-hand side.
 *
 * Unquoted values are trimmed (the common case: `KEY=value` with stray spaces).
 * A correctly quoted value keeps its interior verbatim. Anything that only
 * looks quoted — mismatched or unterminated — is left exactly as written rather
 * than being half-stripped, so a surprising value is visible instead of silent.
 */
function parseValue(rawValue) {
  const trimmed = rawValue.trim();
  const quoted = QUOTED.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

/** Apply every KEY=value line of `raw` that `env` does not already carry. */
function applyLines(env, raw) {
  for (const line of raw.split(/\r?\n/)) {
    const match = ASSIGNMENT.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (env[key]) continue;
    env[key] = parseValue(rawValue);
  }
}

/**
 * Populate `env` from MCP_ENV_FILE, or failing that from cwd/.env.
 *
 * Values already present and non-empty in `env` win, so a real environment
 * variable can override the file. An empty string counts as absent, so blanking
 * a key in .mcp.json falls through to .env rather than silently setting "".
 *
 * The two candidates fail differently, and that asymmetry is the point. A
 * missing cwd/.env is the everyday case (variables set some other way) and is
 * silently fine. MCP_ENV_FILE is a path the user wrote out by hand; a typo'd
 * one that quietly fell back to cwd/.env — or to nothing — would start the
 * server on DIFFERENT credentials than the ones asked for, and the only trace
 * would be `env=` in a --selftest nobody is required to run. So an unreadable
 * MCP_ENV_FILE throws, and it is resolved against `cwd` like the fallback is,
 * rather than against wherever the process happened to start.
 *
 * @returns the path of the file that was read, or null when none was.
 */
export function loadEnvFile(env = process.env, cwd = process.cwd()) {
  if (env.MCP_ENV_FILE) {
    const file = path.resolve(cwd, env.MCP_ENV_FILE);
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(
        `MCP_ENV_FILE is "${env.MCP_ENV_FILE}", but that file could not be read ` +
          `(${err.code || err.message}). Fix the path, or unset MCP_ENV_FILE to use ` +
          `cwd/.env or the process environment.`,
        { cause: err }
      );
    }
    applyLines(env, raw);
    return file;
  }

  const fallback = path.resolve(cwd, ".env");
  let raw;
  try {
    raw = readFileSync(fallback, "utf8");
  } catch {
    return null;
  }
  applyLines(env, raw);
  return fallback;
}
