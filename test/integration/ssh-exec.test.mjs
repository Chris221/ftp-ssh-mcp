// Wire-level tests for command execution (ssh_exec / sshRun), against the
// same ssh2-backed fixture Task 10 built for SFTP (test/fixtures/sftp-server
// .mjs), extended with a session `exec` handler.
//
// Task 6 claimed this surface was covered by a later task's tests; nothing
// actually exercised it. That is unacceptable for a public package that ships
// remote command execution, so this file was added as an explicit scope
// extension to Task 10 (approved by the human partner — see task-10-report
// .md). It is not in the Task 10 brief.
//
// Two levels are used, chosen per test:
//
//   - Transport level (sshRun + formatResult, called directly): for
//     properties that belong to sshRun itself — the shape of a result,
//     base-directory confinement (buildRemoteCommand's `cd`), output
//     truncation, exit-code plumbing, stdin delivery, and the timeout. These
//     don't depend on the allowlist, so calling sshRun directly tests the
//     unit responsible without a layer of tool wiring in between.
//
//   - Tool level (the registered `ssh_exec` tool, via buildTools): for the
//     allowlist and shell-metacharacter guards. Those live in
//     validateCommand, which only capabilities/ssh.mjs's tool handler calls
//     before sshRun — sshRun itself never validates. Testing the tool is the
//     only way to prove the rejection happens on the path a real MCP caller
//     actually takes, before anything reaches the wire.
//
// Every exec the fixture receives is recorded in server.execCommands, so
// "nothing was sent to the server" is asserted against the fixture, not
// inferred from an error message.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveConfig } from "../../src/config.mjs";
import { formatResult, sshRun } from "../../src/ssh.mjs";
import { startSftpServer } from "../fixtures/sftp-server.mjs";
import { buildTools } from "../fixtures/tool-runner.mjs";

let server;
let remoteRoot;
let config;

const baseEnv = (port, overrides = {}) => ({
  SSH_HOST: "127.0.0.1",
  SSH_PORT: String(port),
  SSH_USER: "tester",
  SSH_PASSWORD: "secret",
  SSH_ALLOW_EXEC: "true",
  SSH_BASE_DIR: "/srv/app",
  SSH_ALLOWED_CMDS: "echo",
  ...overrides,
});

beforeEach(async () => {
  // Unused by the exec path, but startSftpServer's SFTP handlers close over
  // `root`; a real temp dir keeps this fixture identical to the SFTP suite's.
  remoteRoot = mkdtempSync(path.join(tmpdir(), "ssh-exec-remote-"));
  server = await startSftpServer({ root: remoteRoot });
  config = resolveConfig(baseEnv(server.port));
});

afterEach(async () => {
  await server.close();
  rmSync(remoteRoot, { recursive: true, force: true });
});

/** Answer an exec request with fixed stdout/stderr/exit code. */
function respond(stream, { stdout = "", stderr = "", code = 0 } = {}) {
  if (stdout) stream.write(stdout);
  if (stderr) stream.stderr.write(stderr);
  stream.exit(code);
  stream.end();
}

describe("sshRun (transport level)", () => {
  it("runs a permitted command and surfaces stdout, stderr and exit code; formatResult renders them", async () => {
    server.onExec = (command, stream) => {
      respond(stream, { stdout: "out-line\n", stderr: "err-line\n", code: 0 });
    };

    const result = await sshRun(config.ssh, "echo hi");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("out-line\n");
    expect(result.stderr).toBe("err-line\n");
    expect(result.truncated).toBe(false);

    const rendered = formatResult("echo hi", result, config.ssh.maxOutputBytes);
    expect(rendered).toContain("$ echo hi");
    expect(rendered).toContain("exit 0");
    expect(rendered).toContain("--- stdout ---\nout-line");
    expect(rendered).toContain("--- stderr ---\nerr-line");
  });

  it("runs the command inside the configured SSH_BASE_DIR", async () => {
    server.onExec = (command, stream) => respond(stream, { code: 0 });

    await sshRun(config.ssh, "echo hi");

    expect(server.execCommands).toHaveLength(1);
    // buildRemoteCommand assembles `cd '<baseDir>' && <command>` — this is
    // the confinement property: a caller cannot reach outside SSH_BASE_DIR
    // because every command is prefixed with a cd into it before it runs.
    expect(server.execCommands[0]).toContain("cd '/srv/app' &&");
    expect(server.execCommands[0]).toContain("echo hi");
  });

  it("caps combined stdout+stderr at SSH_MAX_OUTPUT and sets truncated, not per stream", async () => {
    const cfg = resolveConfig(baseEnv(server.port, { SSH_MAX_OUTPUT: "10" }));
    server.onExec = (command, stream) => {
      // 8 bytes on each stream: a per-stream cap of 10 would keep all 16
      // bytes. A combined cap of 10 must truncate, and the two streams
      // together must land at exactly 10, not 16.
      stream.write("A".repeat(8));
      stream.stderr.write("B".repeat(8));
      stream.exit(0);
      stream.end();
    };

    const result = await sshRun(cfg.ssh, "echo hi");

    expect(result.stdout.length + result.stderr.length).toBe(10);
    expect(result.truncated).toBe(true);
  });

  // The combined-cap test above proves the property the brief asks for (cap
  // spans both streams). This one additionally exercises the "budget was
  // already fully spent before this chunk arrived" path inside sshRun's
  // append() helper, which the two-write version above never reaches (the
  // second write is the one that exhausts the budget, not one arriving
  // after it's already gone). It writes three chunks to a single stream
  // (stdout only) rather than interleaving stdout/stderr, because Node only
  // guarantees in-order 'data' events within one stream — the relative
  // arrival order of two distinct extended-data channels (stdout vs stderr)
  // over the same SSH connection is not something to assert timing on.
  it("adds nothing further once the output budget is already exhausted", async () => {
    const cfg = resolveConfig(baseEnv(server.port, { SSH_MAX_OUTPUT: "10" }));
    server.onExec = (command, stream) => {
      stream.write("A".repeat(6)); // fits: budget now 6/10
      stream.write("B".repeat(6)); // only 4 more fit: budget now 10/10, truncated
      stream.write("C".repeat(4)); // budget already at 0: must contribute nothing
      stream.exit(0);
      stream.end();
    };

    const result = await sshRun(cfg.ssh, "echo hi");

    expect(result.stdout).toBe("A".repeat(6) + "B".repeat(4));
    expect(result.stdout).not.toContain("C");
    expect(result.stdout.length).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it("reports a non-zero exit code rather than swallowing it", async () => {
    server.onExec = (command, stream) => respond(stream, { stdout: "partial\n", code: 3 });

    const result = await sshRun(config.ssh, "echo hi");

    expect(result.code).toBe(3);
    expect(result.stdout).toBe("partial\n");
  });

  it("delivers stdin to the remote process rather than placing it on the command line", async () => {
    let receivedStdin = null;
    server.onExec = (command, stream) => {
      let data = "";
      stream.on("data", (chunk) => {
        data += chunk.toString();
      });
      stream.on("end", () => {
        receivedStdin = data;
        respond(stream, { stdout: "ok\n", code: 0 });
      });
    };

    const sql = "SELECT * FROM secrets;";
    const result = await sshRun(config.ssh, "echo hi", { stdin: sql });

    expect(receivedStdin).toBe(sql);
    expect(result.stdout).toBe("ok\n");
    // This is the security property: the payload travels over the stdin
    // stream, never as part of the assembled command string.
    expect(server.execCommands[0]).not.toContain(sql);
  });

  it("times out and rejects when the remote process never responds", async () => {
    const cfg = resolveConfig(baseEnv(server.port, { SSH_TIMEOUT_MS: "150" }));
    server.onExec = () => {
      // Deliberately never call stream.exit()/end() — simulates a hung
      // remote process. sshRun's own setTimeout must fire and close the
      // stream rather than hanging the test (or the whole suite) forever.
    };

    await expect(sshRun(cfg.ssh, "echo hi")).rejects.toThrow(/timed out/i);
  });
});

describe("ssh_exec tool (guards run before anything reaches the wire)", () => {
  function toolRunner(cfg) {
    return buildTools(cfg).run;
  }

  it("rejects a program not in SSH_ALLOWED_CMDS before contacting the server", async () => {
    const run = toolRunner(config); // SSH_ALLOWED_CMDS=echo
    const result = await run("ssh_exec", { command: "rm -rf /" });

    expect(result.error).toMatch(/not allowed/);
    expect(server.execCommands).toStrictEqual([]);
  });

  it.each([
    ["command chaining (;)", "echo hi; rm -rf /"],
    ["a pipe (|)", "echo hi | rm -rf /"],
    ["command substitution ($())", "echo $(rm -rf /)"],
    ["command substitution (backticks)", "echo `rm -rf /`"],
    ["a redirect (>)", "echo hi > /etc/passwd"],
    ["a newline", "echo hi\nrm -rf /"],
  ])("rejects shell metacharacters: %s", async (_label, command) => {
    const run = toolRunner(config);
    const result = await run("ssh_exec", { command });

    expect(result.error).toMatch(/shell metacharacters/i);
    expect(server.execCommands).toStrictEqual([]);
  });

  // The six cases above are realistic attack shapes, chosen per named
  // category (chaining, pipe, substitution x2, redirect, newline). They
  // don't individually prove every one of SHELL_METACHARACTERS' 14 members
  // is still in the class, because several rows carry more than one member
  // at once (e.g. "$(...)" carries both $, ( and ) ) — a regression that
  // dropped a single character, such as &, could still leave every row
  // above rejecting (via a different character in the same string) and the
  // suite would stay green.
  //
  // This table closes that gap: one row per character in
  // SHELL_METACHARACTERS (src/guards.mjs), each command holding that
  // character and no other class member, so a row can only pass because of
  // the character it names. \r is included deliberately — this project is
  // developed on Windows, where a carriage return can arrive in input
  // without anyone intending it.
  it.each([
    ["; (chaining)", "ls; whoami"],
    ["& (backgrounding/chaining)", "ls & whoami"],
    ["| (pipe)", "ls | whoami"],
    ["` (backtick substitution)", "ls `whoami`"],
    ["$ (variable/substitution)", "ls $HOME"],
    ["( (subshell/group open)", "ls (whoami"],
    [") (subshell/group close)", "ls whoami)"],
    ["{ (brace expansion open)", "ls {whoami"],
    ["} (brace expansion close)", "ls whoami}"],
    ["< (input redirect)", "cat < /etc/passwd"],
    ["> (output redirect)", "echo hi > /etc/passwd"],
    ["\\n (newline)", "echo hi\nwhoami"],
    ["\\r (carriage return)", "echo hi\rwhoami"],
    ["\\\\ (backslash escape)", "echo hi\\whoami"],
  ])("rejects every character in the shell-metacharacter class in isolation: %s", async (_label, command) => {
    const run = toolRunner(config);
    const result = await run("ssh_exec", { command });

    expect(result.error).toMatch(/shell metacharacters/i);
    expect(server.execCommands).toStrictEqual([]);
  });

  it("runs a permitted, clean command end to end through the tool", async () => {
    server.onExec = (command, stream) => respond(stream, { stdout: "hi\n", code: 0 });
    const run = toolRunner(config);

    const result = await run("ssh_exec", { command: "echo hi" });

    expect(result.error).toBeUndefined();
    expect(result.content[0].text).toContain("hi");
    expect(server.execCommands).toHaveLength(1);
  });
});
