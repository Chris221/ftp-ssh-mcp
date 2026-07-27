import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Console } from "node:console";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveConfig } from "../../src/config.mjs";
import { withClient } from "../../src/transports/index.mjs";
import { freePort } from "../fixtures/free-port.mjs";
import { startSftpServer } from "../fixtures/sftp-server.mjs";

let server;
let remoteRoot;
let localRoot;
let config;

beforeEach(async () => {
  remoteRoot = mkdtempSync(path.join(tmpdir(), "sftp-remote-"));
  localRoot = mkdtempSync(path.join(tmpdir(), "sftp-local-"));
  server = await startSftpServer({ root: remoteRoot });
  config = resolveConfig({
    SSH_HOST: "127.0.0.1",
    SSH_PORT: String(server.port),
    SSH_USER: "tester",
    SSH_PASSWORD: "secret",
    FILE_TRANSPORT: "sftp",
  });
});

afterEach(async () => {
  await server.close();
  rmSync(remoteRoot, { recursive: true, force: true });
  rmSync(localRoot, { recursive: true, force: true });
});

describe("sftp transport", () => {
  it("uploads a file", async () => {
    const local = path.join(localRoot, "hello.txt");
    writeFileSync(local, "hi");
    await withClient(config, (c) => c.upload(local, "/hello.txt"));
    expect(readFileSync(path.join(remoteRoot, "hello.txt"), "utf8")).toBe("hi");
  });

  it("downloads a file", async () => {
    writeFileSync(path.join(remoteRoot, "there.txt"), "content");
    const local = path.join(localRoot, "there.txt");
    await withClient(config, (c) => c.download("/there.txt", local));
    expect(readFileSync(local, "utf8")).toBe("content");
  });

  it("lists a directory with types and sizes", async () => {
    writeFileSync(path.join(remoteRoot, "a.txt"), "12345");
    mkdirSync(path.join(remoteRoot, "sub"));

    const entries = await withClient(config, (c) => c.list("/"));
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

    expect(Object.keys(byName).sort()).toStrictEqual(["a.txt", "sub"]);
    expect(byName["a.txt"].isDir).toBe(false);
    expect(byName["a.txt"].size).toBe(5);
    expect(byName.sub.isDir).toBe(true);
  });

  it("creates a directory", async () => {
    await withClient(config, (c) => c.mkdir("/nested"));
    expect(existsSync(path.join(remoteRoot, "nested"))).toBe(true);
  });

  it("removes a file", async () => {
    writeFileSync(path.join(remoteRoot, "gone.txt"), "x");
    await withClient(config, (c) => c.removeFile("/gone.txt"));
    expect(existsSync(path.join(remoteRoot, "gone.txt"))).toBe(false);
  });

  it("removes a directory", async () => {
    mkdirSync(path.join(remoteRoot, "dir"));
    await withClient(config, (c) => c.removeDir("/dir"));
    expect(existsSync(path.join(remoteRoot, "dir"))).toBe(false);
  });
});

// stdout is the JSON-RPC channel: one stray non-JSON line corrupts the session
// for the whole client, not just the failing call.
//
// The assertion below is on process.stdout.write, NOT on console.log, and that
// is the whole point of the test. ssh2-sftp-client's default `end`/`close`
// callbacks call console.log on every failure path; the reason that shipped
// through a green suite is that vitest replaces the global console with one
// that routes to its own reporter channel, so a console.log spy — and, it turns
// out, a bare process.stdout.write spy too — observes nothing either way.
//
// So the test first restores a production-shaped console (a real node Console
// bound to the actual process streams, which is what the server has when npx
// starts it), and only then spies one level lower, on the stream write itself.
// With that in place a stray console.log genuinely reaches
// process.stdout.write, and the spy sees it: the test fails without the fix and
// passes with it, rather than being structurally incapable of telling.
describe("sftp connection failures never write to stdout", () => {
  it("writes nothing to stdout when the connection is refused", async () => {
    // A port that was free a moment ago and has nothing listening on it: the
    // connect attempt fails fast with ECONNREFUSED, which is the commonest of
    // the failure paths that used to log.
    const deadPort = await freePort();
    const failing = resolveConfig({
      SSH_HOST: "127.0.0.1",
      SSH_PORT: String(deadPort),
      SSH_USER: "tester",
      SSH_PASSWORD: "secret",
      SSH_TIMEOUT_MS: "5000",
      FILE_TRANSPORT: "sftp",
    });

    const vitestConsole = globalThis.console;
    globalThis.console = new Console({ stdout: process.stdout, stderr: process.stderr });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    let stdoutWrites;
    let failure;
    try {
      failure = await withClient(failing, (c) => c.list("/")).then(
        () => null,
        (err) => err
      );
      // The `close` event can arrive a tick after the connect promise settles,
      // so give the client's own teardown a chance to log before asserting.
      await new Promise((resolve) => setTimeout(resolve, 100));
      stdoutWrites = stdout.mock.calls.map((call) => String(call[0]));
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      globalThis.console = vitestConsole;
    }

    expect(stdoutWrites).toStrictEqual([]);
    // Nothing is being swallowed to achieve that: the failure still reaches the
    // caller as a rejection, which is how the tool layer turns it into a
    // structured MCP error rather than a line of prose on the wire.
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/ECONNREFUSED/);
  });
});
