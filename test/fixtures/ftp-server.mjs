// A real FTP server on localhost, serving a temp directory. Plain FTP, because
// the point is to exercise the adapter and the guards, not TLS.

import FtpSrv from "ftp-srv";

import { freePort } from "./free-port.mjs";

// ftp-srv's own FileSystem builds its initial `cwd` by running it through
// node's platform `path` module (src/fs.js). On Windows that module is
// path.win32, whose normalize() rewrites "/" to "\", so a server constructed
// with `cwd: "/home/tester"` would report PWD as "\home\tester" instead of the
// posix path the FTP wire format requires. Setting `.cwd` directly after
// construction bypasses that normalization; every other FileSystem method
// already keeps `cwd` posix-formatted from then on (see chdir in fs.js).
const { FileSystem } = FtpSrv;

// `cwd` is the directory PWD reports after login, relative to `root`. ftp-srv
// defaults it to "/" when undefined. A test sets it to prove a client expanded
// "~" from PWD rather than assuming a root.
export async function startFtpServer({ root, user = "tester", password = "secret", cwd }) {
  const port = await freePort();
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    anonymous: false,
    // Without an explicit pasv_url, ftp-srv can't tell clients where to reach
    // passive-mode data connections on Windows, and transfers hang instead of
    // failing outright.
    pasv_url: "127.0.0.1",
  });

  server.on("login", ({ username, password: given, connection }, resolve, reject) => {
    if (username !== user || given !== password) return reject(new Error("Bad credentials"));
    if (cwd === undefined) return resolve({ root });
    const fs = new FileSystem(connection, { root });
    fs.cwd = cwd;
    return resolve({ fs });
  });

  await server.listen();
  return {
    port,
    async close() {
      await server.close();
    },
  };
}
