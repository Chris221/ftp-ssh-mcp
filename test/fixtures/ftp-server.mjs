// A real FTP server on localhost, serving a temp directory. Plain FTP, because
// the point is to exercise the adapter and the guards, not TLS.

import FtpSrv from "ftp-srv";

import { freePort } from "./free-port.mjs";

export async function startFtpServer({ root, user = "tester", password = "secret" }) {
  const port = await freePort();
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    anonymous: false,
    // Without an explicit pasv_url, ftp-srv can't tell clients where to reach
    // passive-mode data connections on Windows, and transfers hang instead of
    // failing outright.
    pasv_url: "127.0.0.1",
  });

  server.on("login", ({ username, password: given }, resolve, reject) => {
    if (username === user && given === password) return resolve({ root });
    return reject(new Error("Bad credentials"));
  });

  await server.listen();
  return {
    port,
    async close() {
      await server.close();
    },
  };
}
