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
import { Server } from "ssh2";

import { freePort } from "./free-port.mjs";
import { generateHostKey } from "./host-key.mjs";

const { OPEN_MODE, STATUS_CODE } = (await import("ssh2")).utils.sftp;

export async function startSftpServer({ root, user = "tester", password = "secret" } = {}) {
  const port = await freePort();
  const handles = new Map();
  let nextHandle = 0;

  // Returned to the caller and mutated by tests (`server.onExec = ...`). The
  // exec handler below closes over this exact object, so later mutation is
  // visible to it — do not spread/copy it when returning.
  const fixture = { port, execCommands: [], onExec: null };

  // Map a client path onto the temp root, refusing anything that escapes it.
  const localPath = (given) => {
    const resolved = path.resolve(root, `.${path.posix.normalize(`/${given}`)}`);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error("escapes root");
    }
    return resolved;
  };

  const server = new Server({ hostKeys: [generateHostKey()] }, (client) => {
    client
      .on("authentication", (auth) => {
        if (auth.method === "password" && auth.username === user && auth.password === password) {
          return auth.accept();
        }
        if (auth.method === "none") return auth.reject(["password"]);
        return auth.reject();
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
              const target = given === "." || given === "" ? "/" : path.posix.normalize(given);
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
