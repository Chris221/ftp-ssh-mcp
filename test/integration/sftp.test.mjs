import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveConfig } from "../../src/config.mjs";
import { withClient } from "../../src/transports/index.mjs";
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
