// ssh2-sftp-client adapter. Normalized to the shape in ./index.mjs.
import { readFile } from "node:fs/promises";
import path from "node:path";

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

  const sftp = new SftpClient();
  // SFTP rides on SSH, so it takes the same auth as ssh_exec: a key, a password,
  // or both. An encrypted key is useless without its passphrase.
  const auth = {};
  if (profile.privateKeyPath) {
    auth.privateKey = await readFile(profile.privateKeyPath);
    if (profile.passphrase) auth.passphrase = profile.passphrase;
  }
  if (profile.password) {
    auth.password = profile.password;
    auth.tryKeyboard = true;
  }

  await sftp.connect({
    host: profile.host,
    port: profile.port,
    username: profile.user,
    readyTimeout: profile.timeout,
    ...auth,
  });
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
