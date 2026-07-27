import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.mjs";
import { ALL, selectCapabilities } from "../src/capabilities/index.mjs";
import { buildTools } from "./fixtures/tool-runner.mjs";

// sshRun is mocked so the deviation-2 mysql tests can drive an auth failure
// without opening a real connection. Every other test in this file only
// checks which tools got registered and never invokes a handler that reaches
// sshRun, so the mock is inert for them.
vi.mock("../src/ssh.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sshRun: vi.fn() };
});
import { sshRun } from "../src/ssh.mjs";

const ftpOnly = { FTP_HOST: "h", FTP_USER: "u", FTP_PASSWORD: "p" };
const sshOnly = { SSH_HOST: "h", SSH_USER: "u", SSH_PASSWORD: "p" };
const db = { DB_USER: "dbu", DB_NAME: "dbn", DB_PASSWORD: "dbp" };

const names = (env) => selectCapabilities(resolveConfig(env)).map((c) => c.name);

describe("capability selection", () => {
  it("selects only files for an ftp-only config", () => {
    expect(names(ftpOnly)).toStrictEqual(["files"]);
  });

  it("selects files for an ssh config with exec disabled", () => {
    expect(names(sshOnly)).toStrictEqual(["files"]);
  });

  it("adds ssh when exec is explicitly enabled", () => {
    expect(names({ ...sshOnly, SSH_ALLOW_EXEC: "true", SSH_BASE_DIR: "/home/u" })).toStrictEqual([
      "files",
      "ssh",
    ]);
  });

  it("adds mysql when db credentials resolve alongside an ssh profile", () => {
    expect(names({ ...sshOnly, ...db })).toStrictEqual(["files", "mysql"]);
  });

  it("does NOT add mysql without an ssh profile", () => {
    expect(names({ ...ftpOnly, ...db })).toStrictEqual(["files"]);
  });

  it("does NOT require SSH_ALLOW_EXEC for mysql", () => {
    expect(names({ ...sshOnly, ...db })).toContain("mysql");
  });

  it("honours MCP_CAPABILITIES as an allowlist", () => {
    const env = { ...sshOnly, ...db, SSH_ALLOW_EXEC: "true", SSH_BASE_DIR: "/home/u" };
    expect(names({ ...env, MCP_CAPABILITIES: "files" })).toStrictEqual(["files"]);
    expect(names({ ...env, MCP_CAPABILITIES: "files,mysql" })).toStrictEqual(["files", "mysql"]);
  });

  it("selects everything configured when MCP_CAPABILITIES is unset", () => {
    const env = { ...sshOnly, ...db, SSH_ALLOW_EXEC: "true", SSH_BASE_DIR: "/home/u" };
    expect(names(env)).toStrictEqual(["files", "ssh", "mysql"]);
  });

  it("exposes exactly the three built-in capabilities", () => {
    expect(ALL.map((c) => c.name)).toStrictEqual(["files", "ssh", "mysql"]);
  });
});

describe("registered tool names", () => {
  const registeredFor = (env) => buildTools(resolveConfig(env)).names;

  it("registers the six transport-neutral file tools", () => {
    expect(registeredFor(ftpOnly)).toStrictEqual([
      "file_list",
      "file_upload",
      "file_upload_dir",
      "file_download",
      "file_mkdir",
      "file_delete",
    ]);
  });

  it("never registers a legacy ftp_* name", () => {
    const env = { ...sshOnly, ...db, SSH_ALLOW_EXEC: "true", SSH_BASE_DIR: "/home/u" };
    expect(registeredFor(env).filter((n) => n.startsWith("ftp_"))).toStrictEqual([]);
  });

  it("registers ssh_exec only when the ssh capability is active", () => {
    expect(registeredFor(ftpOnly)).not.toContain("ssh_exec");
    expect(registeredFor({ ...sshOnly, SSH_ALLOW_EXEC: "true", SSH_BASE_DIR: "/home/u" })).toContain(
      "ssh_exec"
    );
  });

  it("registers mysql_query only when the mysql capability is active", () => {
    expect(registeredFor(sshOnly)).not.toContain("mysql_query");
    expect(registeredFor({ ...sshOnly, ...db })).toContain("mysql_query");
  });
});

// Deviation 2: mysql_query runs the mysql client on the remote host, where a
// missing DB_PASSWORD can legitimately mean credentials come from ~/.my.cnf
// or socket trust (see configWarnings in config.mjs) — so it is a startup
// warning, not a hard failure. But that warning lands on stderr, which is
// easy to miss in an MCP client, so when the mysql invocation actually fails
// and no password was configured, the tool error must name DB_PASSWORD again
// so the diagnostic is visible where the failure is.
describe("mysql_query auth-failure diagnostics", () => {
  const authFailureStderr = "ERROR 1045 (28000): Access denied for user 'dbu'@'localhost'";

  it("names DB_PASSWORD and ~/.my.cnf when no password is configured", async () => {
    sshRun.mockResolvedValue({ code: 1, stdout: "", stderr: authFailureStderr, truncated: false });
    const config = resolveConfig({ ...sshOnly, ...db, DB_PASSWORD: "", SSH_BASE_DIR: "/home/u" });
    expect(config.db.password).toBe("");

    const { run } = buildTools(config);
    const result = await run("mysql_query", { sql: "SELECT 1" });

    expect(result.error).toBe(
      `${authFailureStderr} DB_PASSWORD is not set; the mysql client relied on host-side ` +
        "credentials such as ~/.my.cnf."
    );
  });

  it("keeps the plain stderr message when a password is configured", async () => {
    sshRun.mockResolvedValue({ code: 1, stdout: "", stderr: authFailureStderr, truncated: false });
    const config = resolveConfig({ ...sshOnly, ...db, SSH_BASE_DIR: "/home/u" });
    expect(config.db.password).toBe("dbp");

    const { run } = buildTools(config);
    const result = await run("mysql_query", { sql: "SELECT 1" });

    expect(result.error).toBe(authFailureStderr);
  });
});
