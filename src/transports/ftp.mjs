// basic-ftp adapter. Normalized to the shape in ./index.mjs.
import path from "node:path";

const posix = path.posix;

export function ftpAdapter(client) {
  return {
    async list(remote) {
      const entries = await client.list(remote);
      return entries.map((f) => ({ name: f.name, isDir: f.isDirectory, size: f.size }));
    },
    async upload(local, remote) {
      const dir = posix.dirname(remote);
      // ensureDir also changes the working directory, so capture and restore it
      // and upload by full path — otherwise a later upload in the same session
      // resolves its basename against whatever directory this call left behind.
      if (dir && dir !== "." && dir !== "/") {
        const cwd = await client.pwd();
        await client.ensureDir(dir);
        await client.cd(cwd);
      }
      await client.uploadFrom(local, remote);
    },
    async uploadDir(local, remote) {
      await client.uploadFromDir(local, remote);
    },
    async download(remote, local) {
      await client.downloadTo(local, remote);
    },
    async mkdir(remote) {
      await client.ensureDir(remote);
    },
    async removeFile(remote) {
      await client.remove(remote);
    },
    async removeDir(remote) {
      await client.removeDir(remote);
    },
  };
}

/** Open an FTP/FTPS connection, run `fn`, always close. */
export async function withFtp(profile, fn) {
  const ftp = await import("basic-ftp");
  const client = new ftp.Client(profile.timeout);
  client.ftp.verbose = false;
  try {
    await client.access({
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password: profile.password,
      secure: profile.secure,
      secureOptions: { rejectUnauthorized: profile.tlsRejectUnauthorized },
    });
    return await fn(ftpAdapter(client));
  } finally {
    client.close();
  }
}
