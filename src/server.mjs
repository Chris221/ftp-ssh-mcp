// MCP server wiring.
//
// stdout is the JSON-RPC channel, so every diagnostic goes to stderr.

import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveConfig, validateConfig, configWarnings } from "./config.mjs";
import { loadEnvFile } from "./env-file.mjs";
import { selectCapabilities, unknownCapabilities } from "./capabilities/index.mjs";
import { withClient } from "./transports/index.mjs";

// Read from package.json rather than written out here. A hardcoded copy is a
// third version string that `npm version` does not touch and that
// test/manifest.test.mjs (which pins server.json to package.json) did not know
// about — it already said 1.0.0 while the manifests said 0.0.0, so MCP's
// serverInfo.version and the --selftest banner would have been wrong from the
// first release onward. createRequire because JSON import attributes are still
// awkward across the supported Node range.
export const VERSION = createRequire(import.meta.url)("../package.json").version;

function text(body) {
  return { content: [{ type: "text", text: body }] };
}

function failure(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Build the MCP server and register every selected capability's tools. */
export function createServer(config) {
  const server = new McpServer({ name: "ftp-ssh-mcp", version: VERSION });
  const toolNames = [];

  // Thrown errors become structured tool errors rather than killing the transport.
  const register = (name, toolConfig, handler) => {
    toolNames.push(name);
    server.registerTool(name, toolConfig, async (args) => {
      try {
        return await handler(args || {});
      } catch (e) {
        return failure(e?.message || String(e));
      }
    });
  };

  const ctx = {
    config,
    register,
    text,
    withClient: (fn, override) => withClient(config, fn, override),
  };

  const selected = selectCapabilities(config);
  for (const capability of selected) capability.register(ctx);

  return { server, toolNames, capabilities: selected.map((c) => c.name) };
}

/** One-line summary for --selftest. Never includes a secret. */
export function selftestSummary(config, toolNames, envFile) {
  const capabilities = selectCapabilities(config).map((c) => c.name);
  return (
    `ftp-ssh-mcp ${VERSION} selftest OK. ` +
    `env=${envFile ?? "<none>"}, ` +
    `transport=${config.files.transport}, ` +
    `host=${(config.ftp || config.ssh)?.host || "<unset>"}, ` +
    `capabilities=[${capabilities.join(", ")}], ` +
    `tools=[${toolNames.join(", ")}]`
  );
}

/** The text `--help` prints. Kept next to main so the two cannot drift. */
export function helpText() {
  return [
    `ftp-ssh-mcp ${VERSION} — MCP server for a remote host over FTP/FTPS/SFTP, SSH and MySQL.`,
    "",
    "Usage:",
    "  ftp-ssh-mcp [options]",
    "",
    "With no options it serves MCP over stdio. An MCP client normally launches it",
    "that way itself; the options below are for checking a setup by hand.",
    "",
    "Options:",
    "  --selftest     Resolve the configuration, print the tools it would register,",
    "                 and exit. Opens no connection.",
    "  -v, --version  Print the version and exit.",
    "  -h, --help     Print this help and exit.",
    "",
    "Configuration comes from the environment, or from a .env file in the working",
    "directory — set MCP_ENV_FILE to point somewhere else, which is what clients",
    "with no project directory need. At minimum set REMOTE_HOST, REMOTE_USER and a",
    "secret. Full variable reference:",
    "  https://github.com/Chris221/ftp-ssh-mcp#variables",
  ].join("\n");
}

export async function main(argv = process.argv, env = process.env, cwd = process.cwd()) {
  // Answered before any configuration is touched. Someone reaching for --help is
  // often someone whose configuration does not work yet, and every path below
  // this throws "No connection profile configured" on an empty environment.
  //
  // These two write to stdout, unlike every other diagnostic in this file,
  // because they return before the stdio transport is connected — there is no
  // JSON-RPC channel to corrupt — and `ftp-ssh-mcp --version` has to be
  // capturable in a script.
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(helpText());
    return;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(VERSION);
    return;
  }

  const envFile = loadEnvFile(env, cwd);
  const config = resolveConfig(env);

  const unknown = unknownCapabilities(config);
  if (unknown.length > 0) {
    throw new Error(
      `MCP_CAPABILITIES names unknown capabilities: ${unknown.join(", ")}. ` +
        "Valid names are: files, ssh, mysql."
    );
  }

  validateConfig(config);

  // Non-fatal configuration observations (e.g. DB_USER with no resolvable
  // DB_PASSWORD) are printed here, once, in both the --selftest path and the
  // real startup path, so they're visible whether checking deliberately or
  // starting for real.
  for (const warning of configWarnings(config)) {
    console.error(`Warning: ${warning}`);
  }

  const { server, toolNames } = createServer(config);

  if (argv.includes("--selftest")) {
    console.error(selftestSummary(config, toolNames, envFile));
    return;
  }

  await server.connect(new StdioServerTransport());
  console.error(
    `ftp-ssh-mcp running on stdio (transport=${config.files.transport}, ` +
      `host=${(config.ftp || config.ssh)?.host || "<unset>"})`
  );
}
