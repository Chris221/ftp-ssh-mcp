import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.mjs";
import { createServer, selftestSummary, main, VERSION } from "../src/server.mjs";

const ftpOnly = { FTP_HOST: "h", FTP_USER: "u", FTP_PASSWORD: "p" };

describe("createServer", () => {
  it("returns the tool names for an ftp-only config", () => {
    const { toolNames } = createServer(resolveConfig(ftpOnly));
    expect(toolNames).toStrictEqual([
      "file_list",
      "file_upload",
      "file_upload_dir",
      "file_download",
      "file_mkdir",
      "file_delete",
    ]);
  });

  it("includes ssh_exec and mysql_query when both are configured", () => {
    const { toolNames } = createServer(
      resolveConfig({
        SSH_HOST: "h",
        SSH_USER: "u",
        SSH_PASSWORD: "p",
        SSH_ALLOW_EXEC: "true",
        SSH_BASE_DIR: "/home/u",
        DB_USER: "d",
        DB_NAME: "n",
      })
    );
    expect(toolNames).toContain("ssh_exec");
    expect(toolNames).toContain("mysql_query");
  });
});

describe("selftestSummary", () => {
  it("names the tools and the env file", () => {
    const config = resolveConfig(ftpOnly);
    const { toolNames } = createServer(config);
    const summary = selftestSummary(config, toolNames, "/tmp/.env");
    expect(summary).toContain("/tmp/.env");
    expect(summary).toContain("file_list");
    expect(summary).toContain("capabilities=[files]");
  });

  it("reports <none> when no env file was read", () => {
    const config = resolveConfig(ftpOnly);
    const { toolNames } = createServer(config);
    expect(selftestSummary(config, toolNames, null)).toContain("<none>");
  });

  it("never includes a password", () => {
    const config = resolveConfig({ ...ftpOnly, FTP_PASSWORD: "hunter2" });
    const { toolNames } = createServer(config);
    expect(selftestSummary(config, toolNames, null)).not.toContain("hunter2");
  });
});

describe("main", () => {
  // main() calls loadEnvFile(env, cwd), which reads <cwd>/.env when present.
  // This package's whole purpose is reading a gitignored .env from the
  // project root, so a real one is very likely to exist on a dev machine.
  // Point cwd at a fresh empty directory per test rather than the repo root,
  // so these tests never depend on whatever local state happens to exist.
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "server-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints configWarnings to stderr when the config triggers one", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const env = {
        SSH_HOST: "h",
        SSH_USER: "u",
        SSH_PASSWORD: "p",
        DB_USER: "d",
        DB_NAME: "n",
        // DB_PASSWORD intentionally unset -> configWarnings() should fire.
      };
      await main(["node", "bin/ftp-ssh-mcp.mjs", "--selftest"], env, dir);

      const lines = stderr.mock.calls.map((call) => call[0]);
      expect(lines.some((line) => String(line).includes("DB_PASSWORD"))).toBe(true);
      // stdout is the JSON-RPC channel; nothing on this path may write to it.
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it("emits no warning for a clean config", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const env = { ...ftpOnly };
      await main(["node", "bin/ftp-ssh-mcp.mjs", "--selftest"], env, dir);

      const lines = stderr.mock.calls.map((call) => call[0]);
      expect(lines.some((line) => String(line).includes("DB_PASSWORD"))).toBe(false);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });
});

// --version and --help answer before any configuration is read. Someone
// reaching for --help is very often someone whose configuration does not work
// yet, so an EMPTY env is the case that matters: every other path through
// main() throws "No connection profile configured" on it.
//
// They print to stdout, unlike every other diagnostic here, because both return
// before the stdio transport is connected — there is no JSON-RPC channel to
// corrupt — and `VERSION=$(ftp-ssh-mcp --version)` has to work.
describe("main version and help flags", () => {
  let dir;
  let stdout;
  let stderr;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "server-flags-"));
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const output = () => stdout.mock.calls.map((call) => String(call[0])).join("\n");

  it.each(["--version", "-v"])("prints the bare version for %s, with no config", async (flag) => {
    await main(["node", "bin/ftp-ssh-mcp.mjs", flag], {}, dir);
    expect(output()).toBe(VERSION);
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each(["--help", "-h"])("prints usage for %s, with no config", async (flag) => {
    await main(["node", "bin/ftp-ssh-mcp.mjs", flag], {}, dir);

    const text = output();
    expect(text).toContain("Usage:");
    // Every flag the server accepts must be discoverable from --help.
    expect(text).toContain("--selftest");
    expect(text).toContain("--version");
    expect(text).toContain("--help");
    // Where configuration comes from is the question --help is usually asked.
    expect(text).toContain("MCP_ENV_FILE");
    expect(stderr).not.toHaveBeenCalled();
  });

  it("prefers help over selftest when both are passed", async () => {
    await main(["node", "bin/ftp-ssh-mcp.mjs", "--selftest", "--help"], {}, dir);
    expect(output()).toContain("Usage:");
  });

  it("still refuses to start with no config when no flag is passed", async () => {
    await expect(main(["node", "bin/ftp-ssh-mcp.mjs"], {}, dir)).rejects.toThrow(
      /No connection profile configured/
    );
  });
});
