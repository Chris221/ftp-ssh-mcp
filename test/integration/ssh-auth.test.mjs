// Authentication paths, exercised over the wire for BOTH SSH-backed
// transports.
//
// ssh_exec and SFTP used to build their connect options separately, by hand,
// and had already drifted: the SFTP copy set `tryKeyboard` but never
// registered a keyboard-interactive listener, so against a host that presents
// password auth as keyboard-interactive — the exact case the ssh_exec copy was
// written for — SFTP stalled until readyTimeout and then failed while ssh_exec
// worked. Nothing caught it because neither auth path had a test at all.
//
// Both transports now share buildAuthOptions/attachKeyboardInteractive from
// src/ssh.mjs, and each case below runs against a fixture that accepts ONE
// method and rejects every other, so a passing test cannot be a fall-through
// to a different method that happens to also be configured.
//
// SSH_TIMEOUT_MS is deliberately short here: an unanswered keyboard-interactive
// prompt is a hang, and the point is to fail in seconds with a diagnosable
// error rather than to sit for the 120s default.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveConfig } from "../../src/config.mjs";
import { buildAuthOptions, sshRun } from "../../src/ssh.mjs";
import { withClient } from "../../src/transports/index.mjs";
import { generateHostKey } from "../fixtures/host-key.mjs";
import { startSftpServer } from "../fixtures/sftp-server.mjs";

let dir;
let remoteRoot;
let server;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ssh-auth-"));
  remoteRoot = mkdtempSync(path.join(tmpdir(), "ssh-auth-remote-"));
});

afterEach(async () => {
  if (server) await server.close();
  server = null;
  rmSync(dir, { recursive: true, force: true });
  rmSync(remoteRoot, { recursive: true, force: true });
});

const envFor = (extra) => ({
  SSH_HOST: "127.0.0.1",
  SSH_PORT: String(server.port),
  SSH_USER: "tester",
  SSH_ALLOW_EXEC: "true",
  SSH_BASE_DIR: "/srv/app",
  SSH_ALLOWED_CMDS: "echo",
  SSH_TIMEOUT_MS: "8000",
  FILE_TRANSPORT: "sftp",
  ...extra,
});

/** Answer one exec with fixed stdout and exit 0. */
const echoBack = (stream) => {
  stream.write("authenticated\n");
  stream.exit(0);
  stream.end();
};

describe("connection liveness options", () => {
  it("arms keepalives so a silently dead connection cannot hang an operation forever", async () => {
    // SSH_TIMEOUT_MS only becomes ssh2's readyTimeout — handshake cover — and
    // ssh_exec has its own command timer, but SFTP operations had nothing: a
    // network path that dies without an RST (NAT expiry, dropped Wi-Fi) left
    // put/get pending until TCP retransmission gave up, tens of minutes later.
    // Keepalive probes bound that on BOTH transports, since both connect
    // through buildAuthOptions: with a probe every 15s and 4 tolerated
    // misses, a dead connection surfaces as an error within ~60-75s.
    const { options } = await buildAuthOptions({
      host: "127.0.0.1",
      port: 22,
      user: "tester",
      password: "secret",
      timeout: 8000,
    });

    expect(options.keepaliveInterval).toBe(15000);
    expect(options.keepaliveCountMax).toBe(4);
  });
});

describe("private-key authentication", () => {
  let keyPath;

  beforeEach(async () => {
    const clientKey = generateHostKey(); // a throwaway RSA key, generated per test
    keyPath = path.join(dir, "id_rsa");
    writeFileSync(keyPath, clientKey);
    server = await startSftpServer({ root: remoteRoot, auth: "publickey", clientKey });
  });

  it("connects over sftp with a private key and no password", async () => {
    const config = resolveConfig(envFor({ SSH_PRIVATE_KEY: keyPath }));
    expect(config.ssh.password).toBe("");

    writeFileSync(path.join(remoteRoot, "keyed.txt"), "x");
    const entries = await withClient(config, (c) => c.list("/"));

    expect(entries.map((e) => e.name)).toStrictEqual(["keyed.txt"]);
  });

  it("connects over ssh_exec with a private key and no password", async () => {
    const config = resolveConfig(envFor({ SSH_PRIVATE_KEY: keyPath }));
    server.onExec = (_command, stream) => echoBack(stream);

    const result = await sshRun(config.ssh, "echo hi");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("authenticated\n");
  });

  it("refuses a key the host does not accept, on both transports", async () => {
    const wrongPath = path.join(dir, "wrong_rsa");
    writeFileSync(wrongPath, generateHostKey());
    const config = resolveConfig(envFor({ SSH_PRIVATE_KEY: wrongPath }));

    await expect(withClient(config, (c) => c.list("/"))).rejects.toThrow();
    await expect(sshRun(config.ssh, "echo hi")).rejects.toThrow();
  });
});

describe("keyboard-interactive authentication", () => {
  beforeEach(async () => {
    server = await startSftpServer({ root: remoteRoot, auth: "keyboard-interactive" });
  });

  it("answers the prompt over sftp rather than stalling until readyTimeout", async () => {
    const config = resolveConfig(envFor({ SSH_PASSWORD: "secret" }));

    writeFileSync(path.join(remoteRoot, "prompted.txt"), "x");
    const entries = await withClient(config, (c) => c.list("/"));

    expect(entries.map((e) => e.name)).toStrictEqual(["prompted.txt"]);
  });

  it("answers the prompt over ssh_exec", async () => {
    const config = resolveConfig(envFor({ SSH_PASSWORD: "secret" }));
    server.onExec = (_command, stream) => echoBack(stream);

    const result = await sshRun(config.ssh, "echo hi");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("authenticated\n");
  });

  it("is refused with the wrong password, on both transports", async () => {
    const config = resolveConfig(envFor({ SSH_PASSWORD: "wrong" }));

    await expect(withClient(config, (c) => c.list("/"))).rejects.toThrow();
    await expect(sshRun(config.ssh, "echo hi")).rejects.toThrow();
  });
});
