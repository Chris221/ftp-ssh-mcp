// Run a single command on the remote host over SSH.
//
// Every command is assembled from configuration, never from caller input — the
// command itself has already been checked against the allowlist by the caller.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { buildRemoteCommand, formatFingerprint, normalizeFingerprint } from "./guards.mjs";

export function assertSshUsable(profile) {
  if (!profile) throw new Error("No SSH profile configured. Set SSH_HOST (or REMOTE_HOST).");
  if (!profile.allowExec) {
    throw new Error("SSH execution is disabled. Set SSH_ALLOW_EXEC=true to enable it.");
  }
  if (!profile.baseDir) {
    throw new Error("SSH_BASE_DIR is not set. Commands must run inside a known directory.");
  }
}

/**
 * Build the ssh2 connect options for a profile — address, identity and
 * authentication.
 *
 * This is the ONE builder for both SSH-backed transports: ssh_exec (withSsh
 * here) and SFTP (withSftp in transports/sftp.mjs). They previously carried
 * hand-duplicated copies which had already diverged — the SFTP copy set
 * `tryKeyboard` but registered no keyboard-interactive handler, so a host
 * presenting password auth as keyboard-interactive (exactly the case the SSH
 * copy was written for) stalled until readyTimeout, 120s by default, and then
 * failed, while ssh_exec against the same host worked. Keeping one builder is
 * what stops that from happening again, so resist inlining "just this one
 * option" at either call site.
 *
 * A key and a password are not mutually exclusive: some hosts require both, in
 * sequence. When both are configured, `authHandler` lists the methods to walk so
 * the server can ask for a second factor after the first succeeds.
 *
 * Returns `{ options, hostKeyError }`. ssh2's hostVerifier can only answer
 * yes/no — a rejection surfaces as its generic "Host denied (verification
 * failed)" — so the detailed "expected X, received Y" has to be carried out of
 * the closure. Call `hostKeyError()` on a connect failure and prefer its result
 * over ssh2's own error when it is non-null.
 */
export async function buildAuthOptions(profile) {
  const options = {
    host: profile.host,
    port: profile.port,
    username: profile.user,
    readyTimeout: profile.timeout,
  };

  if (profile.privateKeyPath) {
    options.privateKey = await readFile(profile.privateKeyPath);
    if (profile.passphrase) options.passphrase = profile.passphrase;
  }
  if (profile.password) {
    options.password = profile.password;
    // Many hosts present password auth as keyboard-interactive.
    options.tryKeyboard = true;
  }
  if (options.privateKey && options.password) {
    options.authHandler = ["publickey", "password", "keyboard-interactive"];
  }

  // Without a hostVerifier ssh2 accepts ANY host key, so a machine on the path
  // gets handed the account's password. Pinning a fingerprint is opt-in
  // (configWarnings says so when it is missing), but when set it is enforced on
  // both transports, because they both come through here.
  let mismatch = null;
  const expected = normalizeFingerprint(profile.hostFingerprint);
  if (expected) {
    options.hostVerifier = (key) => {
      // `key` is the raw public-key blob, which is what ssh-keygen -lf hashes,
      // so this digest is comparable with what SSH_HOST_FINGERPRINT holds.
      const actual = createHash("sha256").update(key).digest("hex");
      if (actual === expected) return true;
      mismatch = new Error(
        `Host key verification failed for ${profile.host}: expected ` +
          `${formatFingerprint(expected)}, received ${formatFingerprint(actual)}. ` +
          "Update SSH_HOST_FINGERPRINT only if you know the host key legitimately changed."
      );
      return false;
    };
  }

  return { options, hostKeyError: () => mismatch };
}

/**
 * Answer the keyboard-interactive prompt with the profile's password.
 *
 * `tryKeyboard` alone only offers the method; without this listener ssh2 never
 * replies to the prompt and the connection hangs until readyTimeout. Must be
 * attached to the ssh2 Client BEFORE connect() is called.
 */
export function attachKeyboardInteractive(client, profile) {
  client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
    finish(prompts.map(() => profile.password));
  });
  return client;
}

/** Open an SSH connection, hand it to `fn`, always tear it down. */
export async function withSsh(profile, fn) {
  const { Client } = await import("ssh2").catch(() => {
    throw new Error("SSH requires the 'ssh2' package. Run: npm install ssh2");
  });

  const { options, hostKeyError } = await buildAuthOptions(profile);
  const conn = new Client();
  try {
    await new Promise((resolve, reject) => {
      attachKeyboardInteractive(conn, profile);
      conn
        .on("ready", resolve)
        // A host-key mismatch reaches ssh2 as a generic handshake failure;
        // swap in the message that names the two fingerprints.
        .on("error", (err) => reject(hostKeyError() || err))
        .connect(options);
    });
    return await fn(conn);
  } finally {
    conn.end();
  }
}

/**
 * Run one command in the profile's base directory.
 *
 * `stdin` is written to the process rather than placed on the command line,
 * which is how SQL reaches the mysql client without shell redirection.
 */
export async function sshRun(profile, command, { stdin = "", env = {} } = {}) {
  const full = buildRemoteCommand({
    activate: profile.activate,
    baseDir: profile.baseDir,
    env,
    command,
  });

  return withSsh(
    profile,
    (conn) =>
      new Promise((resolve, reject) => {
        conn.exec(full, (err, stream) => {
          if (err) return reject(err);

          let stdout = "";
          let stderr = "";
          let truncated = false;
          let code = null;

          const append = (target, chunk) => {
            const remaining = profile.maxOutputBytes - (stdout.length + stderr.length);
            if (remaining <= 0) {
              truncated = true;
              return target;
            }
            const text = chunk.toString();
            if (text.length > remaining) truncated = true;
            return target + text.slice(0, remaining);
          };

          const timer = setTimeout(() => {
            stream.close();
            reject(new Error(`Command timed out after ${profile.timeout}ms: ${command}`));
          }, profile.timeout);

          stream
            .on("close", (exitCode) => {
              clearTimeout(timer);
              resolve({ code: exitCode ?? code ?? 0, stdout, stderr, truncated });
            })
            .on("exit", (exitCode) => {
              code = exitCode;
            })
            .on("data", (chunk) => {
              stdout = append(stdout, chunk);
            })
            .stderr.on("data", (chunk) => {
              stderr = append(stderr, chunk);
            });

          if (stdin) stream.end(stdin);
        });
      })
  );
}

/** Render a command result for a tool response. */
export function formatResult(command, { code, stdout, stderr, truncated }, maxOutputBytes) {
  const parts = [`$ ${command}`, `exit ${code}`];
  if (stdout.trim()) parts.push(`--- stdout ---\n${stdout.trimEnd()}`);
  if (stderr.trim()) parts.push(`--- stderr ---\n${stderr.trimEnd()}`);
  if (truncated) parts.push(`(output truncated at ${maxOutputBytes} bytes)`);
  if (!stdout.trim() && !stderr.trim()) parts.push("(no output)");
  return parts.join("\n");
}
