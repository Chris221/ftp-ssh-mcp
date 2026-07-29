// Wire-level tests for mysql_query's credential delivery, against the same
// ssh2-backed exec fixture as test/integration/ssh-exec.test.mjs.
//
// The property under test is WHERE the password travels. The whole command is
// executed as a single shell string, so anything in it — including an
// environment-variable prefix like `MYSQL_PWD='…'` — lands in the wrapping
// shell's argv, and `ps` on the host shows argv to every co-tenant for the
// duration of the query. On shared hosting that is a real exposure, not a
// theoretical one. The password must therefore reach the mysql client without
// ever appearing in the exec'd command string: it rides the first line of
// stdin, is read into MYSQL_PWD by the remote shell, and only then does mysql
// start. execCommands (what the server actually received) is the assertion
// surface, so a regression that puts the secret back in argv fails here.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveConfig } from "../../src/config.mjs";
import { startSftpServer } from "../fixtures/sftp-server.mjs";
import { buildTools } from "../fixtures/tool-runner.mjs";

let server;
let remoteRoot;

const PASSWORD = "s3cr3t-dbp";

const baseEnv = (port, overrides = {}) => ({
  SSH_HOST: "127.0.0.1",
  SSH_PORT: String(port),
  SSH_USER: "tester",
  SSH_PASSWORD: "secret",
  SSH_BASE_DIR: "/srv/app",
  DB_USER: "dbu",
  DB_NAME: "dbn",
  DB_PASSWORD: PASSWORD,
  ...overrides,
});

beforeEach(async () => {
  remoteRoot = mkdtempSync(path.join(tmpdir(), "mysql-remote-"));
  server = await startSftpServer({ root: remoteRoot });
});

afterEach(async () => {
  await server.close();
  rmSync(remoteRoot, { recursive: true, force: true });
});

/** Answer an exec request after collecting its stdin; returns received stdin. */
function respondAfterStdin(stream, { stdout = "", code = 0 } = {}, sink) {
  let data = "";
  stream.on("data", (chunk) => {
    data += chunk.toString();
  });
  stream.on("end", () => {
    sink.stdin = data;
    if (stdout) stream.write(stdout);
    stream.exit(code);
    stream.end();
  });
}

describe("mysql_query credential delivery", () => {
  it("keeps the password out of the exec'd command string, delivering it as the first stdin line", async () => {
    const received = {};
    server.onExec = (command, stream) => respondAfterStdin(stream, { stdout: "ok\n" }, received);

    const config = resolveConfig(baseEnv(server.port));
    const { run } = buildTools(config);
    const result = await run("mysql_query", { sql: "SELECT 1;" });

    expect(result.error).toBeUndefined();
    expect(server.execCommands).toHaveLength(1);
    // The security property: the secret is nowhere in what `ps` can see.
    expect(server.execCommands[0]).not.toContain(PASSWORD);
    expect(server.execCommands[0]).toContain("mysql --user='dbu' --database='dbn' --table");
    // Password first, then the SQL, both newline-terminated — the remote
    // shell reads line one into MYSQL_PWD and mysql consumes the rest.
    expect(received.stdin).toBe(`${PASSWORD}\nSELECT 1;\n`);
  });

  it("runs a bare mysql command with no password mechanism at all when DB_PASSWORD is unset", async () => {
    const received = {};
    server.onExec = (command, stream) => respondAfterStdin(stream, { stdout: "ok\n" }, received);

    const config = resolveConfig(baseEnv(server.port, { DB_PASSWORD: "" }));
    const { run } = buildTools(config);
    const result = await run("mysql_query", { sql: "SELECT 1;" });

    expect(result.error).toBeUndefined();
    // No MYSQL_PWD='' prefix and no stdin preamble: an exported empty
    // password is an empty-password auth attempt, which defeats the
    // documented ~/.my.cnf host-side fallback. Absent means absent.
    expect(server.execCommands[0]).not.toContain("MYSQL_PWD");
    expect(server.execCommands[0]).not.toContain("read");
    expect(received.stdin).toBe("SELECT 1;\n");
  });

  it("names the signal when the mysql client is killed, not 'mysql exited null'", async () => {
    // An OOM-killed import is the realistic shape on shared hosting. The
    // stderr-empty + signal-death path used to render "mysql exited null".
    server.onExec = (command, stream) => {
      stream.resume();
      stream.on("end", () => {
        stream.exit("KILL");
        stream.end();
      });
    };

    const config = resolveConfig(baseEnv(server.port));
    const { run } = buildTools(config);
    const result = await run("mysql_query", { sql: "SELECT 1;" });

    expect(result.error).toMatch(/killed by SIGKILL/);
    expect(result.error).not.toMatch(/exited null/);
  });

  it("refuses a DB_PASSWORD containing a line break rather than corrupting the stdin framing", async () => {
    const config = resolveConfig(baseEnv(server.port, { DB_PASSWORD: "bro\nken" }));
    const { run } = buildTools(config);
    const result = await run("mysql_query", { sql: "SELECT 1;" });

    expect(result.error).toMatch(/DB_PASSWORD/);
    expect(result.error).toMatch(/line break/i);
    // Refused before anything reached the wire.
    expect(server.execCommands).toStrictEqual([]);
  });
});
