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

  // ...but it does require DB_USER to be named explicitly. mysql_query is at
  // least as powerful as ssh_exec (arbitrary SQL, plus the mysql client's `\!`
  // shell escape), and ssh_exec cannot switch itself on either.
  it("does NOT add mysql when only DB_NAME is set", () => {
    expect(names({ ...sshOnly, DB_NAME: "dbn" })).toStrictEqual(["files"]);
  });

  it("does NOT add mysql when DB_NAME is set and only REMOTE_USER supplies a user", () => {
    const env = { REMOTE_HOST: "h", REMOTE_USER: "u", REMOTE_PASSWORD: "p", DB_NAME: "dbn" };
    expect(names(env)).toStrictEqual(["files"]);
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

// The read-only and delete-disabled clamps are new logic introduced by the
// capability modules and throw before withClient/sshRun is ever reached, so
// they are exercisable with no network and no withClient stub: an unstubbed
// buildTools(config) makes withClient throw loudly if a clamp is ever
// removed, so these tests fail rather than hang if a regression drops one.
describe("safety clamps", () => {
  const notStubbed = /no withClient stub/i;

  it("blocks file_upload when FTP_READONLY=true", async () => {
    const config = resolveConfig({ ...ftpOnly, FTP_READONLY: "true" });
    const { run } = buildTools(config);
    const result = await run("file_upload", { localPath: "/tmp/a.txt", remotePath: "a.txt" });
    expect(result.error).toMatch(/read-only/i);
  });

  it("blocks file_mkdir when FTP_READONLY=true — not upload-specific", async () => {
    const config = resolveConfig({ ...ftpOnly, FTP_READONLY: "true" });
    const { run } = buildTools(config);
    const result = await run("file_mkdir", { remotePath: "newdir" });
    expect(result.error).toMatch(/read-only/i);
  });

  it("blocks file_upload_dir when FTP_READONLY=true", async () => {
    const config = resolveConfig({ ...ftpOnly, FTP_READONLY: "true" });
    const { run } = buildTools(config);
    const result = await run("file_upload_dir", { localDir: "/tmp/dir", remoteDir: "remotedir" });
    expect(result.error).toMatch(/read-only/i);
  });

  it("blocks file_delete without FTP_ALLOW_DELETE, naming the variable", async () => {
    const config = resolveConfig({ ...ftpOnly });
    const { run } = buildTools(config);
    const result = await run("file_delete", { remotePath: "a.txt" });
    expect(result.error).toMatch(/FTP_ALLOW_DELETE/);
  });

  it("lets file_delete past the clamp when FTP_ALLOW_DELETE=true and read-only is off", async () => {
    const config = resolveConfig({ ...ftpOnly, FTP_ALLOW_DELETE: "true" });
    const { run } = buildTools(config);
    const result = await run("file_delete", { remotePath: "a.txt" });
    // No withClient stub was supplied, so getting past the clamp surfaces as
    // the unstubbed-withClient error, not a deletion-disabled one — that
    // distinction IS the "it got through" signal here, not a success return.
    expect(result.error).not.toMatch(/FTP_ALLOW_DELETE/);
    expect(result.error).toMatch(notStubbed);
  });

  it("still blocks file_delete on read-only even with FTP_ALLOW_DELETE=true", async () => {
    const config = resolveConfig({ ...ftpOnly, FTP_READONLY: "true", FTP_ALLOW_DELETE: "true" });
    const { run } = buildTools(config);
    const result = await run("file_delete", { remotePath: "a.txt" });
    expect(result.error).toMatch(/read-only/i);
  });

  it("blocks ssh_exec when FTP_READONLY=true, even with exec allowed", async () => {
    const config = resolveConfig({
      ...sshOnly,
      SSH_ALLOW_EXEC: "true",
      SSH_BASE_DIR: "/home/u",
      FTP_READONLY: "true",
    });
    const { run } = buildTools(config);
    const result = await run("ssh_exec", { command: "ls" });
    expect(result.error).toMatch(/read-only/i);
  });

  // A server that refuses `touch` but happily runs DROP TABLE is not read-only.
  // mysql_query used to be exempt from this clamp entirely.
  it("blocks mysql_query when FTP_READONLY=true", async () => {
    const config = resolveConfig({
      ...sshOnly,
      ...db,
      SSH_BASE_DIR: "/home/u",
      FTP_READONLY: "true",
    });
    const { run } = buildTools(config);
    const result = await run("mysql_query", { sql: "DROP TABLE users" });

    expect(result.error).toMatch(/read-only/i);
    // The clamp fires before anything is sent: sshRun is mocked in this file,
    // so "never called" is the proof nothing reached the host.
    expect(sshRun).not.toHaveBeenCalled();
  });

  it("uses the same read-only message for mysql_query as for ssh_exec", async () => {
    const env = { ...sshOnly, ...db, SSH_BASE_DIR: "/home/u", FTP_READONLY: "true" };
    const { run } = buildTools(resolveConfig({ ...env, SSH_ALLOW_EXEC: "true" }));

    const sql = await run("mysql_query", { sql: "SELECT 1" });
    const exec = await run("ssh_exec", { command: "ls" });

    expect(sql.error).toBe("Server is in read-only mode (FTP_READONLY=true).");
    expect(exec.error).toBe(sql.error);
  });

  it("does not block reads (file_list, file_download) on a read-only server", async () => {
    const config = resolveConfig({ ...ftpOnly, FTP_READONLY: "true" });
    const { run } = buildTools(config);

    const listResult = await run("file_list", {});
    expect(listResult.error).not.toMatch(/read-only/i);
    expect(listResult.error).toMatch(notStubbed);

    const downloadResult = await run("file_download", { remotePath: "a.txt", localPath: "/tmp/a.txt" });
    expect(downloadResult.error).not.toMatch(/read-only/i);
    expect(downloadResult.error).toMatch(notStubbed);
  });
});

// The file tools take a per-call `transport` override, and each profile has
// its own base directory, so confinement has to hold for the profile the call
// selects — not just for the default one. Before the cross-profile fallback, a
// config with FTP_BASE_DIR set and SSH_BASE_DIR unset resolved an sftp-override
// call against an empty base dir, which resolveRemotePath treats as "no
// confinement": /etc/passwd stayed /etc/passwd.
describe("path confinement follows the per-call transport override", () => {
  const bothProfiles = { ...ftpOnly, ...sshOnly };

  /** Capture the remote path each tool actually asks the transport for. */
  const listing = () => {
    const seen = [];
    const withClient = (fn) =>
      fn({
        list: async (remote) => {
          seen.push(remote);
          return [];
        },
      });
    return { seen, withClient };
  };

  it("confines an sftp-override call to the base dir borrowed from FTP_BASE_DIR", async () => {
    const config = resolveConfig({ ...bothProfiles, FTP_BASE_DIR: "/home/u/public_html" });
    const { seen, withClient } = listing();
    const { run } = buildTools(config, { withClient });

    const result = await run("file_list", { remotePath: "/etc/passwd", transport: "sftp" });

    expect(result.error).toBeUndefined();
    expect(seen).toStrictEqual(["/home/u/public_html/etc/passwd"]);
  });

  it("confines an ftp-override call to the base dir borrowed from SSH_BASE_DIR", async () => {
    const config = resolveConfig({ ...bothProfiles, SSH_BASE_DIR: "/home/u" });
    const { seen, withClient } = listing();
    const { run } = buildTools(config, { withClient });

    const result = await run("file_list", { remotePath: "/etc/passwd", transport: "ftp" });

    expect(result.error).toBeUndefined();
    expect(seen).toStrictEqual(["/home/u/etc/passwd"]);
  });

  it("still rejects .. on an overridden transport", async () => {
    const config = resolveConfig({ ...bothProfiles, FTP_BASE_DIR: "/home/u/public_html" });
    const { seen, withClient } = listing();
    const { run } = buildTools(config, { withClient });

    const result = await run("file_list", { remotePath: "../../etc", transport: "sftp" });

    expect(result.error).toMatch(/'\.\.' segments/);
    expect(seen).toStrictEqual([]);
  });

  it("keeps each profile's own base dir when both are set", async () => {
    const config = resolveConfig({
      ...bothProfiles,
      FTP_BASE_DIR: "/home/u/public_html",
      SSH_BASE_DIR: "/home/u",
    });
    const { seen, withClient } = listing();
    const { run } = buildTools(config, { withClient });

    await run("file_list", { remotePath: "logs", transport: "ftp" });
    await run("file_list", { remotePath: "logs", transport: "sftp" });

    expect(seen).toStrictEqual(["/home/u/public_html/logs", "/home/u/logs"]);
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
