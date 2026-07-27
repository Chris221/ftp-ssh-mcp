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

/**
 * Populate `env` from the first readable candidate file.
 *
 * Values already present and non-empty in `env` win, so a real environment
 * variable can override the file. An empty string counts as absent, so blanking
 * a key in .mcp.json falls through to .env rather than silently setting "".
 *
 * @returns the path of the file that was read, or null when none was.
 */
export function loadEnvFile(env = process.env, cwd = process.cwd()) {
  const candidates = [env.MCP_ENV_FILE, path.resolve(cwd, ".env")].filter(Boolean);

  for (const file of candidates) {
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const match = ASSIGNMENT.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (env[key]) continue;
      env[key] = rawValue.trim().replace(/^["'](.*)["']$/, "$1");
    }
    return file;
  }
  return null;
}
