// MCP server wiring.
//
// stdout is the JSON-RPC channel, so every diagnostic goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveConfig, validateConfig, configWarnings } from "./config.mjs";
import { loadEnvFile } from "./env-file.mjs";
import { selectCapabilities, unknownCapabilities } from "./capabilities/index.mjs";
import { withClient } from "./transports/index.mjs";

const VERSION = "1.0.0";

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

export async function main(argv = process.argv, env = process.env, cwd = process.cwd()) {
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
