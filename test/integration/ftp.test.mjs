// Wire-level FTP tests against a real ftp-srv instance on localhost. Plain
// FTP, because the point is to exercise the adapter and the guards, not TLS.
//
// The tool-layer tests below reuse test/fixtures/tool-runner.mjs (buildTools)
// rather than hand-building a registration context: that helper already
// exists from Task 7 and is exercised by test/capabilities.test.mjs, so a
// second copy here would just be a second thing to keep in sync. Passing a
// real withClient (backed by this file's live server) lets buildTools' run()
// reach the actual transport instead of a stub.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveConfig } from "../../src/config.mjs";
import { withClient } from "../../src/transports/index.mjs";
import { startFtpServer } from "../fixtures/ftp-server.mjs";
import { buildTools } from "../fixtures/tool-runner.mjs";

let server;
let remoteRoot;
let localRoot;
let config;

const baseEnv = (port) => ({
  FTP_HOST: "127.0.0.1",
  FTP_PORT: String(port),
  FTP_USER: "tester",
  FTP_PASSWORD: "secret",
  FTP_SECURITY: "ftp",
});

beforeEach(async () => {
  remoteRoot = mkdtempSync(path.join(tmpdir(), "ftp-remote-"));
  localRoot = mkdtempSync(path.join(tmpdir(), "ftp-local-"));
  server = await startFtpServer({ root: remoteRoot });
  config = resolveConfig(baseEnv(server.port));
});

afterEach(async () => {
  await server.close();
  rmSync(remoteRoot, { recursive: true, force: true });
  rmSync(localRoot, { recursive: true, force: true });
});

/** Build a tool runner wired to this test's live server via withClient. */
function toolRunnerFor(cfg) {
  return buildTools(cfg, { withClient: (fn, override) => withClient(cfg, fn, override) }).run;
}

describe("ftp transport", () => {
  it("lists an empty directory", async () => {
    const entries = await withClient(config, (c) => c.list("/"));
    expect(entries).toStrictEqual([]);
  });

  it("uploads a file and lists it", async () => {
    const local = path.join(localRoot, "hello.txt");
    writeFileSync(local, "hi");

    await withClient(config, (c) => c.upload(local, "/hello.txt"));

    expect(readFileSync(path.join(remoteRoot, "hello.txt"), "utf8")).toBe("hi");
    const entries = await withClient(config, (c) => c.list("/"));
    expect(entries.map((e) => e.name)).toStrictEqual(["hello.txt"]);
    expect(entries[0].isDir).toBe(false);
  });

  it("downloads a file", async () => {
    writeFileSync(path.join(remoteRoot, "there.txt"), "content");
    const local = path.join(localRoot, "there.txt");

    await withClient(config, (c) => c.download("/there.txt", local));

    expect(readFileSync(local, "utf8")).toBe("content");
  });

  it("creates a directory", async () => {
    await withClient(config, (c) => c.mkdir("/nested/deep"));
    expect(existsSync(path.join(remoteRoot, "nested", "deep"))).toBe(true);
  });

  it("uploads a directory recursively", async () => {
    mkdirSync(path.join(localRoot, "site"));
    writeFileSync(path.join(localRoot, "site", "a.txt"), "a");
    mkdirSync(path.join(localRoot, "site", "sub"));
    writeFileSync(path.join(localRoot, "site", "sub", "b.txt"), "b");

    await withClient(config, (c) => c.uploadDir(path.join(localRoot, "site"), "/site"));

    expect(readFileSync(path.join(remoteRoot, "site", "a.txt"), "utf8")).toBe("a");
    expect(readFileSync(path.join(remoteRoot, "site", "sub", "b.txt"), "utf8")).toBe("b");
  });

  it("removes a file", async () => {
    writeFileSync(path.join(remoteRoot, "gone.txt"), "x");
    await withClient(config, (c) => c.removeFile("/gone.txt"));
    expect(existsSync(path.join(remoteRoot, "gone.txt"))).toBe(false);
  });

  it("removes a directory recursively", async () => {
    mkdirSync(path.join(remoteRoot, "dir"));
    writeFileSync(path.join(remoteRoot, "dir", "x.txt"), "x");
    await withClient(config, (c) => c.removeDir("/dir"));
    expect(existsSync(path.join(remoteRoot, "dir"))).toBe(false);
  });

  // Task 5 fixed a real bug: basic-ftp's ensureDir() changes the client's
  // working directory as a side effect, and the original upload() uploaded by
  // basename, so a second upload in the same session could land wherever the
  // first upload's ensureDir() left the cwd instead of where it was asked to
  // go. The fix captures the cwd, restores it in a finally, and uploads by
  // full path. Nothing exercised that fix until now — both tests below fail
  // against the pre-fix adapter (verified manually; see task-9-report.md).
  it("keeps a second upload's destination independent of a prior nested upload (Task 5 fix)", async () => {
    await withClient(config, async (c) => {
      const first = path.join(localRoot, "first.txt");
      writeFileSync(first, "first");
      await c.upload(first, "/a/b/first.txt");

      const second = path.join(localRoot, "second.txt");
      writeFileSync(second, "second");
      await c.upload(second, "/second.txt");
    });

    expect(readFileSync(path.join(remoteRoot, "a", "b", "first.txt"), "utf8")).toBe("first");
    expect(readFileSync(path.join(remoteRoot, "second.txt"), "utf8")).toBe("second");
    // The bug this guards against would resolve "second.txt" against the cwd
    // left behind by ensureDir("/a/b") and land it inside a/b instead.
    expect(existsSync(path.join(remoteRoot, "a", "b", "second.txt"))).toBe(false);
  });

  // A lone upload to a root-level destination can't distinguish fixed from
  // buggy: posix.dirname("/root-level.txt") is "/", which both the pre-fix
  // and fixed adapter special-case identically (no ensureDir call at all,
  // since cwd is already root on a fresh connection). To actually exercise
  // the fix, the parent-directory-is-"/" upload has to come after something
  // that moved the session's cwd away from root — otherwise this test would
  // pass trivially against either version of the code (verified manually;
  // see task-9-report.md).
  it("uploads to a root-level destination after a prior upload moved the session's cwd (Task 5 fix)", async () => {
    await withClient(config, async (c) => {
      const nested = path.join(localRoot, "nested.txt");
      writeFileSync(nested, "nested");
      await c.upload(nested, "/deep/dir/nested.txt");

      const local = path.join(localRoot, "root-level.txt");
      writeFileSync(local, "root");
      await c.upload(local, "/root-level.txt");
    });

    expect(readFileSync(path.join(remoteRoot, "root-level.txt"), "utf8")).toBe("root");
    // The bug this guards against would resolve "root-level.txt" against the
    // cwd left behind by ensureDir("/deep/dir") and land it there instead.
    expect(existsSync(path.join(remoteRoot, "deep", "dir", "root-level.txt"))).toBe(false);
  });
});

// These prove the safety flags refuse at the point a caller actually reaches,
// not merely in a unit assertion. buildTools (test/fixtures/tool-runner.mjs)
// supplies the same ctx shape the real server hands to capability.register;
// here it is wired to withClient against this file's live server so a
// handler that gets past a clamp actually touches the host.
describe("safety clamps at the wire", () => {
  it("FTP_READONLY refuses an upload and leaves the host untouched", async () => {
    const cfg = resolveConfig({ ...baseEnv(server.port), FTP_READONLY: "true" });
    const local = path.join(localRoot, "blocked.txt");
    writeFileSync(local, "nope");

    const run = toolRunnerFor(cfg);
    const result = await run("file_upload", { localPath: local, remotePath: "/blocked.txt" });

    expect(result.error).toMatch(/read-only/);
    expect(existsSync(path.join(remoteRoot, "blocked.txt"))).toBe(false);
  });

  it("refuses a delete when FTP_ALLOW_DELETE is unset, leaving the file in place", async () => {
    writeFileSync(path.join(remoteRoot, "keep.txt"), "x");
    const run = toolRunnerFor(resolveConfig(baseEnv(server.port)));

    const result = await run("file_delete", { remotePath: "/keep.txt", isDirectory: false });

    expect(result.error).toMatch(/Deletion is disabled/);
    expect(existsSync(path.join(remoteRoot, "keep.txt"))).toBe(true);
  });

  it("permits a delete once FTP_ALLOW_DELETE=true", async () => {
    writeFileSync(path.join(remoteRoot, "bye.txt"), "x");
    const cfg = resolveConfig({ ...baseEnv(server.port), FTP_ALLOW_DELETE: "true" });

    await toolRunnerFor(cfg)("file_delete", { remotePath: "/bye.txt", isDirectory: false });

    expect(existsSync(path.join(remoteRoot, "bye.txt"))).toBe(false);
  });

  it("refuses a traversal path before touching the connection", async () => {
    const cfg = resolveConfig({ ...baseEnv(server.port), FTP_BASE_DIR: "/site" });
    const run = toolRunnerFor(cfg);

    const result = await run("file_list", { remotePath: "../../etc" });

    expect(result.error).toMatch(/must not contain '\.\.' segments/);
  });
});

// The FTP login directory is whatever PWD reports after login. ftp-srv takes it
// as `cwd` on the login resolve, so the fixture can report something other than
// "/" and prove the client actually asked.
describe("tilde base dir", () => {
  let tildeServer;
  let tildeConfig;

  const envFor = (port, baseDir) => ({ ...baseEnv(port), FTP_BASE_DIR: baseDir });

  beforeEach(async () => {
    mkdirSync(path.join(remoteRoot, "home", "tester", "site"), { recursive: true });
    tildeServer = await startFtpServer({ root: remoteRoot, cwd: "/home/tester" });
    tildeConfig = resolveConfig(envFor(tildeServer.port, "~/site"));
  });

  afterEach(async () => {
    await tildeServer.close();
  });

  it("hands the expanded base dir to the callback", async () => {
    const seen = await withClient(tildeConfig, (_client, baseDir) => baseDir);
    expect(seen).toBe("/home/tester/site");
  });

  it("reaches the expanded directory on the wire", async () => {
    writeFileSync(path.join(remoteRoot, "home", "tester", "site", "a.txt"), "12345");
    const entries = await withClient(tildeConfig, (client, baseDir) => client.list(baseDir));
    expect(entries.map((e) => e.name)).toStrictEqual(["a.txt"]);
  });

  it("passes an absolute base dir through untouched", async () => {
    const config = resolveConfig(envFor(tildeServer.port, "/home/tester/site"));
    const seen = await withClient(config, (_client, baseDir) => baseDir);
    expect(seen).toBe("/home/tester/site");
  });

  it("confines a tool call to the expanded base dir", async () => {
    writeFileSync(path.join(remoteRoot, "home", "tester", "site", "a.txt"), "12345");
    const run = toolRunnerFor(tildeConfig);

    const result = await run("file_list", { remotePath: "." });

    expect(result.error).toBeUndefined();
    expect(result.content[0].text).toMatch(/^\/home\/tester\/site\n/);
    expect(result.content[0].text).toContain("a.txt");
  });

  it("resolves an absolute-looking tool path under the expanded base dir", async () => {
    mkdirSync(path.join(remoteRoot, "home", "tester", "site", "etc"), { recursive: true });
    const run = toolRunnerFor(tildeConfig);

    const result = await run("file_list", { remotePath: "/etc" });

    expect(result.error).toBeUndefined();
    expect(result.content[0].text).toMatch(/^\(empty\) \/home\/tester\/site\/etc$/);
  });

  it("still rejects .. before opening a connection", async () => {
    const run = toolRunnerFor(tildeConfig);

    const result = await run("file_list", { remotePath: "../../etc" });

    expect(result.error).toMatch(/'\.\.' segments/);
  });
});
