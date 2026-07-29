// A real SFTP server on localhost backed by a temp directory, built on ssh2's
// Server. Only the operations the file tools use are implemented.
//
// Task 10 scope extension: this fixture also answers `session.exec` requests,
// so it doubles as the ssh_exec wire-level fixture (test/integration/ssh-exec
// .test.mjs). Every exec command string the server receives is recorded in
// `execCommands`, in order, so a test can assert exactly what was sent (or
// that nothing was sent, for allowlist/metacharacter rejections that must
// never reach the wire). A test can also set `server.onExec = (command,
// stream) => {...}` to control the exec channel directly — write to `stream`
// for stdout, `stream.stderr` for stderr, read `stream` for stdin, and call
// `stream.exit(code)` then `stream.end()` to finish. `onExec` is read at call
// time (the fixture object is mutated in place, not copied), so a test may
// set it any time after the server starts and before the command it targets
// runs. With no `onExec` set, a command exits 0 immediately with no output —
// enough for tests that only care about the command string, not the result.

import fs from "node:fs";
import path from "node:path";
import { Server, utils } from "ssh2";

import { freePort } from "./free-port.mjs";
import { generateHostKey } from "./host-key.mjs";

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

/**
 * Server-side authentication, one method per fixture.
 *
 * `auth` picks which method this server will accept, so a test can prove a
 * client-side auth path actually works rather than falling through to another:
 *
 *   - "password" (default): the plain password method.
 *   - "keyboard-interactive": password auth presented as a single prompt, the
 *     shape many shared hosts use. Every other method is rejected, so a client
 *     that offers `tryKeyboard` without answering the prompt hangs rather than
 *     quietly succeeding by another route.
 *   - "publickey": only the key in `clientKey` (a private-key PEM, from which
 *     the fixture derives the public half) is accepted.
 */
export async function startSftpServer({
  root,
  user = "tester",
  password = "secret",
  auth = "password",
  clientKey = null,
  // What realpath(".") answers — the account's login directory. Defaults to "/"
  // (the shape a chrooted account sees); set it to prove a client expanded "~"
  // from the server's answer rather than assuming a root.
  home = "/",
} = {}) {
  const port = await freePort();
  const handles = new Map();
  let nextHandle = 0;
  const hostKey = generateHostKey();

  // Returned to the caller and mutated by tests (`server.onExec = ...`). The
  // exec handler below closes over this exact object, so later mutation is
  // visible to it — do not spread/copy it when returning.
  //
  // `hostKey` is exposed because it is generated fresh per run: a test that
  // needs the expected SSH_HOST_FINGERPRINT computes it from this rather than
  // from a committed key.
  const fixture = { port, hostKey, execCommands: [], serverErrors: [], onExec: null };

  // Map a client path onto the temp root, refusing anything that escapes it.
  const localPath = (given) => {
    const resolved = path.resolve(root, `.${path.posix.normalize(`/${given}`)}`);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error("escapes root");
    }
    return resolved;
  };

  const allowedKey = clientKey ? utils.parseKey(clientKey) : null;

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client
      // A client that rejects our host key, or drops mid-handshake, makes the
      // server emit an error. Without a listener that becomes an uncaught
      // exception and fails the whole test file, even though refusing to
      // connect is exactly what the test asked for. Record it instead.
      .on("error", (err) => {
        fixture.serverErrors.push(err);
      })
      .on("authentication", (ctx) => {
        if (ctx.username !== user) return ctx.reject();

        if (auth === "publickey") {
          if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
          // The algorithm name is deliberately not compared: a modern client
          // signs an RSA key as rsa-sha2-256/512 while the parsed key's type
          // is still ssh-rsa. What must match is the key itself, and then the
          // signature over the session blob.
          if (!ctx.key.data.equals(allowedKey.getPublicSSH())) return ctx.reject();
          if (ctx.signature) {
            // parseKey().verify() wants a DIGEST name, not the SSH algorithm
            // name the context carries: passing "ssh-rsa" straight through
            // throws ERR_CRYPTO_INVALID_DIGEST. The name is not a reliable
            // guide either — ssh2's client reports ssh-rsa here while actually
            // signing with SHA-256 — so the fixture tries the plausible digests
            // and accepts if any of them verifies. verify() returns an Error
            // object rather than throwing for a bad digest, hence `=== true`.
            const verified = ["sha256", "sha512", "sha1"].some(
              (digest) => allowedKey.verify(ctx.blob, ctx.signature, digest) === true
            );
            if (!verified) return ctx.reject();
          }
          return ctx.accept();
        }

        if (auth === "keyboard-interactive") {
          if (ctx.method !== "keyboard-interactive") return ctx.reject(["keyboard-interactive"]);
          return ctx.prompt([{ prompt: "Password: ", echo: false }], (answers) => {
            if (answers && answers[0] === password) return ctx.accept();
            return ctx.reject();
          });
        }

        if (ctx.method === "password" && ctx.password === password) return ctx.accept();
        if (ctx.method === "none") return ctx.reject(["password"]);
        return ctx.reject();
      })
      .on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();

          session.on("exec", (acceptExec, rejectExec, info) => {
            fixture.execCommands.push(info.command);
            const stream = acceptExec();
            if (fixture.onExec) {
              fixture.onExec(info.command, stream);
            } else {
              stream.exit(0);
              stream.end();
            }
          });

          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp();

            const ok = (reqid) => sftp.status(reqid, STATUS_CODE.OK);
            const fail = (reqid) => sftp.status(reqid, STATUS_CODE.FAILURE);
            const missing = (reqid) => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);

            const newHandle = (payload) => {
              const id = nextHandle++;
              handles.set(id, payload);
              const buf = Buffer.alloc(4);
              buf.writeUInt32BE(id, 0);
              return buf;
            };
            const readHandle = (handle) => handles.get(handle.readUInt32BE(0));

            sftp.on("REALPATH", (reqid, given) => {
              const target = given === "." || given === "" ? home : path.posix.normalize(given);
              sftp.name(reqid, [{ filename: target, longname: target, attrs: {} }]);
            });

            sftp.on("OPEN", (reqid, filename, flags) => {
              let file;
              try {
                file = localPath(filename);
              } catch {
                return fail(reqid);
              }
              const write = flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.TRUNC);
              try {
                const fd = fs.openSync(file, write ? "w" : "r");
                return sftp.handle(reqid, newHandle({ fd, offset: 0 }));
              } catch {
                return missing(reqid);
              }
            });

            sftp.on("READ", (reqid, handle, offset, length) => {
              const entry = readHandle(handle);
              if (!entry) return fail(reqid);
              const buf = Buffer.alloc(length);
              const read = fs.readSync(entry.fd, buf, 0, length, offset);
              if (read === 0) return sftp.status(reqid, STATUS_CODE.EOF);
              return sftp.data(reqid, buf.subarray(0, read));
            });

            sftp.on("WRITE", (reqid, handle, offset, data) => {
              const entry = readHandle(handle);
              if (!entry) return fail(reqid);
              fs.writeSync(entry.fd, data, 0, data.length, offset);
              return ok(reqid);
            });

            sftp.on("CLOSE", (reqid, handle) => {
              const id = handle.readUInt32BE(0);
              const entry = handles.get(id);
              if (entry && entry.fd !== undefined) {
                try {
                  fs.closeSync(entry.fd);
                } catch {
                  /* already closed */
                }
              }
              handles.delete(id);
              return ok(reqid);
            });

            sftp.on("OPENDIR", (reqid, given) => {
              let dir;
              try {
                dir = localPath(given);
              } catch {
                return fail(reqid);
              }
              if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return missing(reqid);
              return sftp.handle(reqid, newHandle({ dir, sent: false }));
            });

            sftp.on("READDIR", (reqid, handle) => {
              const entry = readHandle(handle);
              if (!entry) return fail(reqid);
              if (entry.sent) return sftp.status(reqid, STATUS_CODE.EOF);
              entry.sent = true;
              const names = fs.readdirSync(entry.dir).map((name) => {
                const stats = fs.statSync(path.join(entry.dir, name));
                return {
                  filename: name,
                  longname: `${stats.isDirectory() ? "d" : "-"}rw-r--r-- 1 u u ${stats.size} ${name}`,
                  attrs: { mode: stats.mode, size: stats.size, uid: 0, gid: 0, atime: 0, mtime: 0 },
                };
              });
              return sftp.name(reqid, names);
            });

            const statHandler = (reqid, given) => {
              let target;
              try {
                target = localPath(given);
              } catch {
                return fail(reqid);
              }
              if (!fs.existsSync(target)) return missing(reqid);
              const stats = fs.statSync(target);
              return sftp.attrs(reqid, {
                mode: stats.mode,
                size: stats.size,
                uid: 0,
                gid: 0,
                atime: 0,
                mtime: 0,
              });
            };
            sftp.on("STAT", statHandler);
            sftp.on("LSTAT", statHandler);

            sftp.on("MKDIR", (reqid, given) => {
              try {
                fs.mkdirSync(localPath(given), { recursive: true });
                return ok(reqid);
              } catch {
                return fail(reqid);
              }
            });

            sftp.on("RMDIR", (reqid, given) => {
              try {
                fs.rmSync(localPath(given), { recursive: true, force: true });
                return ok(reqid);
              } catch {
                return fail(reqid);
              }
            });

            sftp.on("REMOVE", (reqid, given) => {
              try {
                fs.unlinkSync(localPath(given));
                return ok(reqid);
              } catch {
                return fail(reqid);
              }
            });
          });
        });
      });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  fixture.close = async () => {
    await new Promise((resolve) => server.close(resolve));
  };

  return fixture;
}
