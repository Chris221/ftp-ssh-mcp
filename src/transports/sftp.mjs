// ssh2-sftp-client adapter. Normalized to the shape in ./index.mjs.
import path from "node:path";

import { attachKeyboardInteractive, buildAuthOptions } from "../ssh.mjs";

const posix = path.posix;

export function sftpAdapter(sftp) {
  return {
    async list(remote) {
      const entries = await sftp.list(remote);
      return entries.map((f) => ({ name: f.name, isDir: f.type === "d", size: f.size }));
    },
    async upload(local, remote) {
      const dir = posix.dirname(remote);
      if (dir && dir !== "." && dir !== "/" && !(await sftp.exists(dir))) {
        await sftp.mkdir(dir, true);
      }
      await sftp.put(local, remote);
    },
    async uploadDir(local, remote) {
      await sftp.uploadDir(local, remote);
    },
    async download(remote, local) {
      await sftp.get(remote, local);
    },
    async mkdir(remote) {
      await sftp.mkdir(remote, true);
    },
    async removeFile(remote) {
      await sftp.delete(remote);
    },
    async removeDir(remote) {
      await sftp.rmdir(remote, true);
    },
  };
}

/** Open an SFTP connection over SSH, run `fn`, always close. */
export async function withSftp(profile, fn) {
  let SftpClient;
  try {
    ({ default: SftpClient } = await import("ssh2-sftp-client"));
  } catch {
    throw new Error(
      "SFTP is selected but 'ssh2-sftp-client' is not installed. Run: npm install ssh2-sftp-client"
    );
  }

  // ssh2-sftp-client's DEFAULT global listeners call console.log on `end` and
  // `close` (src/index.js). They are suppressed on a clean teardown, but not on
  // any failure path — connection refused, host down, TCP reset, handshake
  // timeout — so a failed connect writes a bare non-JSON line to stdout, which
  // is the JSON-RPC channel. Supplying our own callbacks is the only way to
  // stop that: errors go to stderr, end/close say nothing.
  const sftp = new SftpClient("ftp-ssh-mcp", {
    error: (err) => console.error(`sftp: ${err.message}`),
    end: () => {},
    close: () => {},
  });

  // SFTP rides on SSH, so it takes exactly the same connect options as
  // ssh_exec, built by the same function — see buildAuthOptions in ../ssh.mjs
  // for why this must not be hand-rolled here again. `sftp.client` is the
  // underlying ssh2 Client, and the keyboard-interactive listener has to be on
  // it before connect() or the prompt goes unanswered.
  const { options, hostKeyError } = await buildAuthOptions(profile);
  attachKeyboardInteractive(sftp.client, profile);

  try {
    await sftp.connect(options);
  } catch (err) {
    // A host-key mismatch arrives as a generic handshake failure; swap in the
    // message that names the expected and received fingerprints.
    throw hostKeyError() || err;
  }
  try {
    return await fn(sftpAdapter(sftp));
  } finally {
    try {
      await sftp.end();
    } catch {
      /* teardown errors are not actionable */
    }
  }
}
