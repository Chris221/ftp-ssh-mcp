// ssh2-sftp-client adapter. Normalized to the shape in ./index.mjs.
import { createWriteStream } from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";

import { attachKeyboardInteractive, buildAuthOptions } from "../ssh.mjs";
import { effectiveBaseDir } from "./base-dir.mjs";

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
      // get() resolves on the REMOTE read stream's `end`, before a local write
      // stream it opened itself has flushed — so given a path, it can report
      // success while the file is still empty on disk (seen as a flaky test on
      // Node 20). Hand it our own stream and wait for that to finish instead.
      const out = createWriteStream(local);
      try {
        await sftp.get(remote, out);
        await finished(out);
      } catch (err) {
        out.destroy();
        throw err;
      }
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
    // The base directory is resolved AFTER connecting because a "~" is expanded
    // from realpath("."), the SFTP way to ask where the session landed. An
    // absolute base skips the round trip entirely. Inside the try, so a failed
    // lookup still closes the connection.
    const baseDir = await effectiveBaseDir(profile.baseDir, "SSH_BASE_DIR", () =>
      sftp.realPath(".")
    );
    return await fn(sftpAdapter(sftp), baseDir);
  } finally {
    try {
      await sftp.end();
    } catch {
      /* teardown errors are not actionable */
    }
  }
}
