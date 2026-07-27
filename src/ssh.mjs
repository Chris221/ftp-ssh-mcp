// Run a single command on the remote host over SSH.
//
// Every command is assembled from configuration, never from caller input — the
// command itself has already been checked against the allowlist by the caller.

import { readFile } from "node:fs/promises";

import { buildRemoteCommand } from "./guards.mjs";

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
 * Build ssh2 connection options.
 *
 * A key and a password are not mutually exclusive: some hosts require both, in
 * sequence. When both are configured, `authHandler` lists the methods to walk so
 * the server can ask for a second factor after the first succeeds.
 */
async function connectOptions(profile) {
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
  return options;
}

/** Open an SSH connection, hand it to `fn`, always tear it down. */
export async function withSsh(profile, fn) {
  const { Client } = await import("ssh2").catch(() => {
    throw new Error("SSH requires the 'ssh2' package. Run: npm install ssh2");
  });

  const options = await connectOptions(profile);
  const conn = new Client();
  try {
    await new Promise((resolve, reject) => {
      conn
        .on("ready", resolve)
        .on("error", reject)
        // Hosts that use keyboard-interactive for password auth send one prompt.
        .on("keyboard-interactive", (_n, _i, _l, prompts, finish) => {
          finish(prompts.map(() => profile.password));
        })
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
