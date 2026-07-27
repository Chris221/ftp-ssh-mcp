import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.mjs";
import { createServer, selftestSummary, main } from "../src/server.mjs";

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
  it("prints configWarnings to stderr when the config triggers one", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = {
        SSH_HOST: "h",
        SSH_USER: "u",
        SSH_PASSWORD: "p",
        DB_USER: "d",
        DB_NAME: "n",
        // DB_PASSWORD intentionally unset -> configWarnings() should fire.
      };
      await main(["node", "bin/ftp-ssh-mcp.mjs", "--selftest"], env, process.cwd());

      const lines = stderr.mock.calls.map((call) => call[0]);
      expect(lines.some((line) => String(line).includes("DB_PASSWORD"))).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it("emits no warning for a clean config", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = { ...ftpOnly };
      await main(["node", "bin/ftp-ssh-mcp.mjs", "--selftest"], env, process.cwd());

      const lines = stderr.mock.calls.map((call) => call[0]);
      expect(lines.some((line) => String(line).includes("DB_PASSWORD"))).toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });
});
