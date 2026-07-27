// Host-key pinning, over the wire, on both SSH-backed transports.
//
// ssh2 accepts ANY host key unless a hostVerifier is supplied, so before
// SSH_HOST_FINGERPRINT existed a machine on the path could present its own key
// and be handed the account's password. Pinning is opt-in, but when it is set
// it must be enforced identically for ssh_exec and for SFTP — both build their
// connect options through buildAuthOptions, and these tests are what proves
// that is still true.
//
// The fixture generates a fresh host key per run, so the expected fingerprint
// is computed from that key (see fingerprintOf) rather than pinned to a
// committed value. fingerprintOf derives it through ssh2's own key parser, so
// a match here is a genuine cross-check of the server's hashing, not a restated
// copy of it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveConfig, validateConfig } from "../../src/config.mjs";
import { sshRun } from "../../src/ssh.mjs";
import { withClient } from "../../src/transports/index.mjs";
import { fingerprintOf, generateHostKey } from "../fixtures/host-key.mjs";
import { startSftpServer } from "../fixtures/sftp-server.mjs";

let server;
let remoteRoot;

beforeEach(async () => {
  remoteRoot = mkdtempSync(path.join(tmpdir(), "hostkey-remote-"));
  server = await startSftpServer({ root: remoteRoot });
  writeFileSync(path.join(remoteRoot, "pinned.txt"), "x");
});

afterEach(async () => {
  await server.close();
  rmSync(remoteRoot, { recursive: true, force: true });
});

const envFor = (fingerprint) => ({
  SSH_HOST: "127.0.0.1",
  SSH_PORT: String(server.port),
  SSH_USER: "tester",
  SSH_PASSWORD: "secret",
  SSH_ALLOW_EXEC: "true",
  SSH_BASE_DIR: "/srv/app",
  SSH_ALLOWED_CMDS: "echo",
  SSH_TIMEOUT_MS: "8000",
  FILE_TRANSPORT: "sftp",
  ...(fingerprint === undefined ? {} : { SSH_HOST_FINGERPRINT: fingerprint }),
});

// A syntactically valid fingerprint that is not this server's: 32 bytes of a
// fixed pattern, so the mismatch is deterministic and obviously synthetic.
const WRONG_HEX = "ab".repeat(32);

describe("a matching fingerprint connects", () => {
  it("over sftp", async () => {
    const config = resolveConfig(envFor(fingerprintOf(server.hostKey)));

    const entries = await withClient(config, (c) => c.list("/"));

    expect(entries.map((e) => e.name)).toStrictEqual(["pinned.txt"]);
  });

  it("over ssh_exec", async () => {
    const config = resolveConfig(envFor(fingerprintOf(server.hostKey)));
    server.onExec = (_command, stream) => {
      stream.write("verified\n");
      stream.exit(0);
      stream.end();
    };

    const result = await sshRun(config.ssh, "echo hi");

    expect(result.stdout).toBe("verified\n");
  });

  it("accepts the bare hex rendering as well as SHA256:base64", async () => {
    const canonical = fingerprintOf(server.hostKey);
    const hex = Buffer.from(canonical.replace(/^SHA256:/, ""), "base64").toString("hex");
    // Upper case on purpose: hex comparison is case-insensitive.
    const config = resolveConfig(envFor(hex.toUpperCase()));

    const entries = await withClient(config, (c) => c.list("/"));

    expect(entries.map((e) => e.name)).toStrictEqual(["pinned.txt"]);
  });
});

describe("a mismatched fingerprint is refused", () => {
  // Both the value the operator pinned and the one the host actually offered
  // have to be in the message: without the received value there is no way to
  // tell a genuine key rotation from an interception, and no way to update the
  // setting if it was a rotation.
  const wrongBase64 = () => Buffer.from(WRONG_HEX, "hex").toString("base64").replace(/=+$/, "");

  const expectBothFingerprints = (message) => {
    expect(message).toContain(`expected SHA256:${wrongBase64()}`);
    expect(message).toContain(`received ${fingerprintOf(server.hostKey)}`);
  };

  it("over sftp, naming both fingerprints", async () => {
    const config = resolveConfig(envFor(WRONG_HEX));

    const failure = await withClient(config, (c) => c.list("/")).then(
      () => null,
      (err) => err
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("Host key verification failed for 127.0.0.1");
    expectBothFingerprints(failure.message);
  });

  it("over ssh_exec, naming both fingerprints", async () => {
    const config = resolveConfig(envFor(WRONG_HEX));

    const failure = await sshRun(config.ssh, "echo hi").then(
      () => null,
      (err) => err
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("Host key verification failed for 127.0.0.1");
    expectBothFingerprints(failure.message);
    // The command never ran: verification fails during the handshake, well
    // before any exec channel is opened.
    expect(server.execCommands).toStrictEqual([]);
  });
});

describe("configuration surface", () => {
  it("rejects a fingerprint that is not a SHA-256 digest at all", () => {
    const config = resolveConfig(envFor("not-a-fingerprint"));
    // Rather than silently connecting unverified, which is what treating an
    // unparseable value as "unset" would do.
    expect(() => validateConfig(config)).toThrow(/SSH_HOST_FINGERPRINT/);
  });

  it("inherits the fingerprint from REMOTE_HOST_FINGERPRINT", async () => {
    const shared = fingerprintOf(server.hostKey);
    const env = envFor(undefined);
    const config = resolveConfig({ ...env, REMOTE_HOST_FINGERPRINT: shared });
    expect(config.ssh.hostFingerprint).toBe(shared);

    const entries = await withClient(config, (c) => c.list("/"));
    expect(entries.map((e) => e.name)).toStrictEqual(["pinned.txt"]);
  });

  it("still connects with no fingerprint set, which is why it warns", async () => {
    const config = resolveConfig(envFor(undefined));
    expect(config.ssh.hostFingerprint).toBe("");

    const entries = await withClient(config, (c) => c.list("/"));
    expect(entries.map((e) => e.name)).toStrictEqual(["pinned.txt"]);
  });
});

// A throwaway key that is definitely not the server's, used to prove the check
// is on the host key rather than on anything else in the handshake.
describe("a fingerprint of a different key is refused", () => {
  it("over sftp", async () => {
    const config = resolveConfig(envFor(fingerprintOf(generateHostKey())));

    await expect(withClient(config, (c) => c.list("/"))).rejects.toThrow(
      /Host key verification failed/
    );
  });
});
