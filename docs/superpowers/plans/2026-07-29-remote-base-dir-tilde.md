# Base Directory Tilde Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `SSH_BASE_DIR`, `FTP_BASE_DIR` and `REMOTE_BASE_DIR` be written as `~` or `~/<dir>`, expanded at connect time from the account's own login directory, so the six file tools work with a tilde base instead of the server refusing to start.

**Architecture:** A pure helper in `src/guards.mjs` does the string expansion. Each transport (`src/transports/sftp.mjs`, `src/transports/ftp.mjs`) asks the server where it landed — `realPath(".")` over SFTP, `PWD` over FTP — but only when the configured base actually starts with `~`, and hands the resulting **effective** base directory to the `withClient` callback as a second argument. `src/capabilities/files.mjs` moves its fence check inside that callback while keeping its pre-connection rejection of `..`. Config validation stops refusing `~` and starts refusing only `~user/...`.

**Tech Stack:** Node ESM (`.mjs`), vitest, `ssh2-sftp-client`, `basic-ftp`, `ftp-srv` and `ssh2`'s `Server` as test fixtures.

## Global Constraints

- Source files use **double quotes**; `test/guards.test.mjs` uses **single quotes**. Match the file you are editing.
- stdout is the JSON-RPC channel. Never `console.log` from `src/`. Diagnostics go to `console.error`.
- Every error message that concerns configuration must name the environment variable the user has to change (`SSH_BASE_DIR`, `FTP_BASE_DIR`, or `REMOTE_BASE_DIR`).
- An empty base directory (`""`) legitimately means "no confinement". Never conflate it with an unset/undefined one — use `??`, not `||`, when defaulting a base directory.
- Run the full suite with `npx vitest run`. A single file: `npx vitest run test/guards.test.mjs`.
- Commit after every task.

---

### Task 1: The pure expansion helper

**Files:**
- Modify: `src/guards.mjs` (add after `expandHome`, which ends at line 26)
- Test: `test/guards.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `expandRemoteBase(baseDir: string, home: string) -> string`. Returns `baseDir` unchanged when it has no leading `~`; otherwise returns an absolute path. Throws when `home` is not absolute.

- [ ] **Step 1: Write the failing tests**

Add to `test/guards.test.mjs`. Add `expandRemoteBase` to the existing import list from `'../src/guards.mjs'` (keep the list alphabetical — it goes between `expandHome` and `formatFingerprint`).

```js
// A remote base dir may be written "~/site". Neither FTP nor SFTP expands a
// tilde -- an OpenSSH server resolves "~" to a directory literally NAMED "~" --
// so the expansion is done client-side from the login directory the server
// reports. This is the string half of that; the lookup lives in
// src/transports/base-dir.mjs.
describe('expandRemoteBase', () => {
  it('returns an absolute base unchanged', () => {
    expect(expandRemoteBase('/home/u/site', '/home/u')).toBe('/home/u/site');
  });

  it('leaves a tilde that is not a home reference alone', () => {
    expect(expandRemoteBase('/home/u/~backup', '/home/u')).toBe('/home/u/~backup');
  });

  it('returns an empty base unchanged, so "no confinement" stays no confinement', () => {
    expect(expandRemoteBase('', '/home/u')).toBe('');
  });

  it('expands a lone tilde to the login directory', () => {
    expect(expandRemoteBase('~', '/home/u')).toBe('/home/u');
  });

  it('expands a trailing-slash tilde to the login directory', () => {
    expect(expandRemoteBase('~/', '/home/u')).toBe('/home/u');
  });

  it('expands a tilde-prefixed path', () => {
    expect(expandRemoteBase('~/site/public', '/home/u')).toBe('/home/u/site/public');
  });

  it('handles a chrooted login directory of "/"', () => {
    expect(expandRemoteBase('~/site', '/')).toBe('/site');
    expect(expandRemoteBase('~', '/')).toBe('/');
  });

  it('strips a trailing slash from the reported login directory', () => {
    expect(expandRemoteBase('~', '/home/u/')).toBe('/home/u');
    expect(expandRemoteBase('~/site', '/home/u/')).toBe('/home/u/site');
  });

  it('refuses a login directory that is not absolute', () => {
    // A relative base would silently rebase every path onto the session's
    // working directory instead of confining it.
    expect(() => expandRemoteBase('~/site', 'home/u')).toThrow(/not an absolute path/);
    expect(() => expandRemoteBase('~/site', '')).toThrow(/not an absolute path/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/guards.test.mjs`
Expected: FAIL — `expandRemoteBase is not a function` (or an import error).

- [ ] **Step 3: Write the implementation**

In `src/guards.mjs`, immediately after `expandHome` (line 26):

```js
/**
 * Expand a leading `~` in a REMOTE base directory.
 *
 * Unlike expandHome, which resolves against THIS machine's home, `home` here is
 * what the remote server reported for the account that logged in: realpath(".")
 * over SFTP, PWD over FTP. Neither protocol expands a tilde itself — an OpenSSH
 * server resolves `~` to a directory literally NAMED "~" under the home
 * directory — so the expansion has to happen client-side, and it can only happen
 * once a connection exists.
 *
 * A relative `home` is refused rather than used. resolveRemotePath reads a falsy
 * base as "no confinement", and a relative one would quietly rebase every path
 * onto the session's working directory; neither is what the user asked for.
 */
export function expandRemoteBase(baseDir, home) {
  const base = String(baseDir ?? "");
  if (base !== "~" && !base.startsWith("~/")) return base;

  const login = String(home ?? "");
  if (!login.startsWith("/")) {
    throw new Error(
      `Cannot expand the base directory "${base}": the server reported its login ` +
        `directory as "${login}", which is not an absolute path.`
    );
  }

  const rest = base.slice(2);
  const normalized = posix.normalize(rest ? posix.join(login, rest) : login);
  return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
}
```

`posix` is already defined at the top of the file (line 10).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/guards.test.mjs`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/guards.mjs test/guards.test.mjs
git commit -m "feat(guards): expand a tilde remote base against a reported login dir"
```

---

### Task 2: Transports resolve the login directory and pass the effective base

**Files:**
- Create: `src/transports/base-dir.mjs`
- Modify: `src/transports/sftp.mjs:40-86` (`withSftp`)
- Modify: `src/transports/ftp.mjs:48-66` (`withFtp`)
- Modify: `test/fixtures/sftp-server.mjs:41-47` and `:151-154` (add a `home` option)
- Modify: `test/fixtures/ftp-server.mjs:8-22` (add a `cwd` option)
- Test: `test/integration/sftp.test.mjs`, `test/integration/ftp.test.mjs`

**Interfaces:**
- Consumes: `expandRemoteBase(baseDir, home)` from Task 1.
- Produces: `effectiveBaseDir(baseDir: string, variable: string, lookup: () => Promise<string>) -> Promise<string>` from `src/transports/base-dir.mjs`. Also: `withFtp` and `withSftp` now call `fn(client, baseDir)` — the callback's second argument is the expanded base directory for this connection. `withClient` in `src/transports/index.mjs` needs **no change**; it forwards `fn` untouched.
- Fixtures: `startSftpServer({ root, home = "/" })` and `startFtpServer({ root, cwd })` — the login directory each fixture reports.

- [ ] **Step 1: Write the failing tests**

In `test/integration/sftp.test.mjs`, append this describe block at the end of the file. It starts its own server because the login directory is fixed at construction; the outer `beforeEach` server stays up unused and is closed by the outer `afterEach`.

```js
// A "~" base dir is expanded from whatever the server says realpath(".") is, so
// the fixture reports a login directory that is NOT "/" — otherwise the test
// would pass even if the tilde were simply dropped.
describe("tilde base dir", () => {
  let tildeServer;
  let tildeConfig;

  const envFor = (port, baseDir) => ({
    SSH_HOST: "127.0.0.1",
    SSH_PORT: String(port),
    SSH_USER: "tester",
    SSH_PASSWORD: "secret",
    FILE_TRANSPORT: "sftp",
    SSH_BASE_DIR: baseDir,
  });

  beforeEach(async () => {
    mkdirSync(path.join(remoteRoot, "home", "tester", "site"), { recursive: true });
    tildeServer = await startSftpServer({ root: remoteRoot, home: "/home/tester" });
    tildeConfig = resolveConfig(envFor(tildeServer.port, "~/site"));
  });

  afterEach(async () => {
    await tildeServer.close();
  });

  it("hands the expanded base dir to the callback", async () => {
    const seen = await withClient(tildeConfig, (_client, baseDir) => baseDir);
    expect(seen).toBe("/home/tester/site");
  });

  it("expands a lone tilde to the login directory", async () => {
    const config = resolveConfig(envFor(tildeServer.port, "~"));
    const seen = await withClient(config, (_client, baseDir) => baseDir);
    expect(seen).toBe("/home/tester");
  });

  it("reaches the expanded directory on the wire", async () => {
    writeFileSync(path.join(remoteRoot, "home", "tester", "site", "a.txt"), "12345");
    const entries = await withClient(tildeConfig, (client, baseDir) => client.list(baseDir));
    expect(entries.map((e) => e.name)).toStrictEqual(["a.txt"]);
  });

  it("passes an absolute base dir through untouched", async () => {
    const config = resolveConfig(envFor(tildeServer.port, "/home/tester/site"));
    const seen = await withClient(config, (_client, baseDir) => baseDir);
    expect(seen).toBe("/home/tester/site");
  });
});
```

In `test/integration/ftp.test.mjs`, append the same shape. `ftp-srv` reports the initial `cwd` for `PWD`:

```js
// The FTP login directory is whatever PWD reports after login. ftp-srv takes it
// as `cwd` on the login resolve, so the fixture can report something other than
// "/" and prove the client actually asked.
describe("tilde base dir", () => {
  let tildeServer;
  let tildeConfig;

  const envFor = (port, baseDir) => ({ ...baseEnv(port), FTP_BASE_DIR: baseDir });

  beforeEach(async () => {
    mkdirSync(path.join(remoteRoot, "home", "tester", "site"), { recursive: true });
    tildeServer = await startFtpServer({ root: remoteRoot, cwd: "/home/tester" });
    tildeConfig = resolveConfig(envFor(tildeServer.port, "~/site"));
  });

  afterEach(async () => {
    await tildeServer.close();
  });

  it("hands the expanded base dir to the callback", async () => {
    const seen = await withClient(tildeConfig, (_client, baseDir) => baseDir);
    expect(seen).toBe("/home/tester/site");
  });

  it("reaches the expanded directory on the wire", async () => {
    writeFileSync(path.join(remoteRoot, "home", "tester", "site", "a.txt"), "12345");
    const entries = await withClient(tildeConfig, (client, baseDir) => client.list(baseDir));
    expect(entries.map((e) => e.name)).toStrictEqual(["a.txt"]);
  });

  it("passes an absolute base dir through untouched", async () => {
    const config = resolveConfig(envFor(tildeServer.port, "/home/tester/site"));
    const seen = await withClient(config, (_client, baseDir) => baseDir);
    expect(seen).toBe("/home/tester/site");
  });
});
```

`test/integration/ftp.test.mjs` already imports `mkdirSync`; `test/integration/sftp.test.mjs` already imports both `mkdirSync` and `writeFileSync`. Verify the import lines before running — add `mkdirSync`/`writeFileSync` to the `node:fs` import if either is missing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/integration/sftp.test.mjs test/integration/ftp.test.mjs`
Expected: FAIL — the callback's second argument is `undefined`, so `expect(seen).toBe("/home/tester/site")` fails with `undefined`. (The fixture `home`/`cwd` options do not exist yet either, but they are silently ignored rather than throwing.)

- [ ] **Step 3: Teach the fixtures to report a login directory**

In `test/fixtures/sftp-server.mjs`, add `home = "/"` to the destructured options (line 41-47):

```js
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
```

and use it in the `REALPATH` handler (line 151-154):

```js
            sftp.on("REALPATH", (reqid, given) => {
              const target = given === "." || given === "" ? home : path.posix.normalize(given);
              sftp.name(reqid, [{ filename: target, longname: target, attrs: {} }]);
            });
```

In `test/fixtures/ftp-server.mjs`, add a `cwd` option and pass it to the login resolve:

```js
// `cwd` is the directory PWD reports after login, relative to `root`. ftp-srv
// defaults it to "/" when undefined. A test sets it to prove a client expanded
// "~" from PWD rather than assuming a root.
export async function startFtpServer({ root, user = "tester", password = "secret", cwd }) {
```

```js
  server.on("login", ({ username, password: given }, resolve, reject) => {
    if (username === user && given === password) return resolve({ root, cwd });
    return reject(new Error("Bad credentials"));
  });
```

- [ ] **Step 4: Write the shared lookup wrapper**

Create `src/transports/base-dir.mjs`:

```js
// Turn a configured base directory into the one this connection will actually
// use.
//
// Shared by both file transports so the tilde rule cannot drift between them:
// the SFTP and FTP adapters previously carried hand-duplicated connection code
// which had already diverged once (see the note on buildAuthOptions in
// ../ssh.mjs), and this is the same kind of shared rule.

import { expandRemoteBase } from "../guards.mjs";

/**
 * Resolve `baseDir` for a live connection, asking the server for its login
 * directory only when there is a `~` to expand.
 *
 * `lookup` is the protocol's way of asking "where did I land?" — realpath(".")
 * over SFTP, PWD over FTP. `variable` is the environment variable to name if
 * anything goes wrong, because a protocol-level error on its own gives the user
 * nothing to change.
 */
export async function effectiveBaseDir(baseDir, variable, lookup) {
  const base = baseDir || "";
  if (base !== "~" && !base.startsWith("~/")) return base;

  let home;
  try {
    home = await lookup();
  } catch (err) {
    throw new Error(
      `${variable} is "${base}", but the account's login directory could not be ` +
        `resolved, so the "~" cannot be expanded: ${err.message}`
    );
  }
  return expandRemoteBase(base, home);
}
```

- [ ] **Step 5: Wire it into both transports**

In `src/transports/sftp.mjs`, add the import beside the existing one:

```js
import { effectiveBaseDir } from "./base-dir.mjs";
```

and replace the `try` block at the end of `withSftp` (currently lines 77-85). The lookup goes **inside** the `try`, not between the connect and the `try` — a throw before the `try` would skip the `finally` and leak the connection:

```js
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
```

In `src/transports/ftp.mjs`, add the import:

```js
import { effectiveBaseDir } from "./base-dir.mjs";
```

and replace the body of `withFtp`'s `try` (currently lines 53-65):

```js
  try {
    await client.access({
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password: profile.password,
      secure: profile.secure,
      secureOptions: { rejectUnauthorized: profile.tlsRejectUnauthorized },
    });
    // A "~" base is expanded from PWD, which after login is the account's own
    // directory — "/" for a chrooted account, the real home otherwise. An
    // absolute base skips the round trip entirely.
    const baseDir = await effectiveBaseDir(profile.baseDir, "FTP_BASE_DIR", () => client.pwd());
    return await fn(ftpAdapter(client), baseDir);
  } finally {
    client.close();
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/integration/sftp.test.mjs test/integration/ftp.test.mjs`
Expected: PASS, including every pre-existing test in both files — the callbacks there take one argument and ignore the new second one.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS. Nothing consumes the second argument yet, so no other file should change behaviour.

- [ ] **Step 8: Commit**

```bash
git add src/transports/base-dir.mjs src/transports/sftp.mjs src/transports/ftp.mjs test/fixtures/sftp-server.mjs test/fixtures/ftp-server.mjs test/integration/sftp.test.mjs test/integration/ftp.test.mjs
git commit -m "feat(transports): resolve the login directory and hand the effective base to callers"
```

---

### Task 3: The file tools fence against the effective base

**Files:**
- Modify: `src/capabilities/files.mjs` (all six handlers, and the `resolve` helper at lines 32-33)
- Modify: `test/fixtures/tool-runner.mjs:28-36`
- Test: `test/integration/ftp.test.mjs`

**Interfaces:**
- Consumes: `withClient(fn, override)` calling `fn(client, baseDir)` from Task 2.
- Produces: no new exports. The six tools resolve their remote path inside the connection.

- [ ] **Step 1: Write the failing tests**

Append to the `tilde base dir` describe added to `test/integration/ftp.test.mjs` in Task 2:

```js
  it("confines a tool call to the expanded base dir", async () => {
    writeFileSync(path.join(remoteRoot, "home", "tester", "site", "a.txt"), "12345");
    const run = toolRunnerFor(tildeConfig);

    const result = await run("file_list", { remotePath: "." });

    expect(result.error).toBeUndefined();
    expect(result.content[0].text).toMatch(/^\/home\/tester\/site\n/);
    expect(result.content[0].text).toContain("a.txt");
  });

  it("resolves an absolute-looking tool path under the expanded base dir", async () => {
    mkdirSync(path.join(remoteRoot, "home", "tester", "site", "etc"), { recursive: true });
    const run = toolRunnerFor(tildeConfig);

    const result = await run("file_list", { remotePath: "/etc" });

    expect(result.error).toBeUndefined();
    expect(result.content[0].text).toMatch(/^\(empty\) \/home\/tester\/site\/etc$/);
  });

  it("still rejects .. before opening a connection", async () => {
    const run = toolRunnerFor(tildeConfig);

    const result = await run("file_list", { remotePath: "../../etc" });

    expect(result.error).toMatch(/'\.\.' segments/);
  });
```

`toolRunnerFor` is already defined at `test/integration/ftp.test.mjs:48`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/integration/ftp.test.mjs`
Expected: FAIL — `file_list` still resolves against the unexpanded `~/site`, so the reported path is `~/site` and the listing errors or comes back empty. The `..` test passes already; that is the regression guard, not the new behaviour.

- [ ] **Step 3: Rewrite the six handlers**

In `src/capabilities/files.mjs`, replace the `resolve` helper (lines 32-33) with a pre-connection check:

```js
    // Reject "..", an empty path and the like BEFORE opening a connection: that
    // check needs no base directory, and a traversal attempt should not cost a
    // network round trip. The fence check — the part that needs the base — has
    // to wait, because a "~" base is only expanded once the server has reported
    // the account's login directory.
    const precheck = (input) => resolveRemotePath(input, "");
```

Delete the now-unused `fileProfile` import (line 9). `resolveRemotePath` stays imported.

Replace each handler body. `file_list`:

```js
      async ({ remotePath, transport }) => {
        const input = remotePath || ".";
        precheck(input);
        const { remote, entries } = await withClient(async (client, baseDir) => {
          const target = resolveRemotePath(input, baseDir);
          return { remote: target, entries: await client.list(target) };
        }, transport);
        if (entries.length === 0) return text(`(empty) ${remote}`);
        const lines = entries
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
          .map((e) => `${e.isDir ? "d" : "-"}  ${String(e.size ?? "").padStart(10)}  ${e.name}`);
        return text(`${remote}\n${lines.join("\n")}`);
      }
```

`file_upload`:

```js
      async ({ localPath, remotePath, transport }) => {
        assertWritable();
        await assertLocalFile(localPath);
        precheck(remotePath);
        const remote = await withClient(async (client, baseDir) => {
          const target = resolveRemotePath(remotePath, baseDir);
          await client.upload(localPath, target);
          return target;
        }, transport);
        return text(`Uploaded ${localPath} -> ${remote}`);
      }
```

`file_upload_dir`:

```js
      async ({ localDir, remoteDir, transport }) => {
        assertWritable();
        const info = await assertLocalFile(localDir);
        if (!info.isDirectory()) throw new Error(`Not a directory: ${localDir}`);
        precheck(remoteDir);
        const remote = await withClient(async (client, baseDir) => {
          const target = resolveRemotePath(remoteDir, baseDir);
          await client.uploadDir(localDir, target);
          return target;
        }, transport);
        return text(`Uploaded directory ${localDir} -> ${remote}`);
      }
```

`file_download`:

```js
      async ({ remotePath, localPath, transport }) => {
        precheck(remotePath);
        const remote = await withClient(async (client, baseDir) => {
          const target = resolveRemotePath(remotePath, baseDir);
          await client.download(target, localPath);
          return target;
        }, transport);
        return text(`Downloaded ${remote} -> ${localPath}`);
      }
```

`file_mkdir`:

```js
      async ({ remotePath, transport }) => {
        assertWritable();
        precheck(remotePath);
        const remote = await withClient(async (client, baseDir) => {
          const target = resolveRemotePath(remotePath, baseDir);
          await client.mkdir(target);
          return target;
        }, transport);
        return text(`Created directory ${remote}`);
      }
```

`file_delete`:

```js
      async ({ remotePath, isDirectory, transport }) => {
        assertDeletable();
        precheck(remotePath);
        const remote = await withClient(async (client, baseDir) => {
          const target = resolveRemotePath(remotePath, baseDir);
          await (isDirectory ? client.removeDir(target) : client.removeFile(target));
          return target;
        }, transport);
        return text(`Deleted ${isDirectory ? "directory" : "file"} ${remote}`);
      }
```

The order of `assertWritable` / `assertLocalFile` / `precheck` in each handler matches the order the old code ran them in, so which error a bad call reports first does not change.

**Watch for this:** `files.mjs` no longer calls `fileProfile`, so the "No SSH profile configured; cannot use the sftp transport" error now comes out of `withClient` instead. The message is identical — `fileProfile` in `src/transports/index.mjs:14` is the same function — but it is now raised one layer later. If a test asserts it, it should still pass; if it does not, that is a real finding, not something to paper over.

- [ ] **Step 4: Teach the tool-runner fixture to supply a base directory**

In `test/fixtures/tool-runner.mjs`, add the import:

```js
import { fileProfile } from "../../src/transports/index.mjs";
```

and replace `ctx.withClient` (lines 28-36):

```js
    withClient(fn, override) {
      if (!withClient) {
        throw new Error(
          "buildTools: this test's ctx has no withClient stub, but a tool tried to use one. " +
            "Pass { withClient } to buildTools to stub it."
        );
      }
      // The real withClient hands the callback the connection's EFFECTIVE base
      // directory, with any "~" already expanded. A stub never connects and
      // passes nothing, so fall back to the configured value — identical for the
      // absolute base dirs these unit tests use. `??` not `||`: an empty base
      // dir means "no confinement" and must not be replaced.
      const { profile } = fileProfile(config, override);
      return withClient((client, baseDir) => fn(client, baseDir ?? profile.baseDir), override);
    },
```

The `baseDir ?? profile.baseDir` fallback is what lets `test/integration/ftp.test.mjs:49` pass the **real** `withClient` through this same helper and still get the expanded value.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/integration/ftp.test.mjs test/capabilities.test.mjs`
Expected: PASS. The confinement tests at `test/capabilities.test.mjs:265-328` must be green **unchanged** — they are the proof that the fence still holds for absolute base dirs and per-call transport overrides.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/capabilities/files.mjs test/fixtures/tool-runner.mjs test/integration/ftp.test.mjs
git commit -m "feat(files): fence remote paths against the connection's effective base dir"
```

---

### Task 4: Config validation accepts `~`, refuses `~user`

**Files:**
- Modify: `src/config.mjs:222-243` (the tilde block in `validateConfig`)
- Test: `test/config.test.mjs:127-171` (the `tilde base dir` describe)

**Interfaces:**
- Consumes: nothing from earlier tasks — this is the startup gate that makes the work in Tasks 1-3 reachable.
- Produces: `validateConfig` no longer throws for `~` or `~/path`; still throws for `~user/path`.

- [ ] **Step 1: Rewrite the tests**

Replace the whole `describe("tilde base dir", ...)` block in `test/config.test.mjs` (lines 127-171, including the four-line comment above it) with:

```js
// A "~" base dir is expanded client-side once a connection exists, from the
// login directory the server reports (see src/transports/base-dir.mjs) — neither
// FTP nor SFTP expands one itself. Only the logged-in account's own home can be
// discovered that way, so "~user/..." is still refused.
describe("tilde base dir", () => {
  const both = { ...ftpOnly, ...sshOnly };

  it.each([
    ["~", "a lone tilde"],
    ["~/", "a trailing-slash tilde"],
    ["~/site", "a tilde-prefixed path"],
  ])('accepts %s as an ftp base dir (%s)', (value) => {
    const cfg = resolveConfig({ ...ftpOnly, FTP_BASE_DIR: value });
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it("accepts a tilde ssh base dir", () => {
    const cfg = resolveConfig({ ...sshOnly, SSH_BASE_DIR: "~/site" });
    expect(cfg.ssh.baseDir).toBe("~/site");
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it("folds a trailing-slash tilde to a bare one", () => {
    const cfg = resolveConfig({ ...ftpOnly, FTP_BASE_DIR: "~/" });
    expect(cfg.ftp.baseDir).toBe("~");
  });

  it("lends a tilde base across profiles, each expanding it against its own home", () => {
    // The FTP account is often chrooted where SSH sees the whole home, so the
    // borrowed "~/site" resolves differently on each transport — which is right.
    const cfg = resolveConfig({ ...both, SSH_BASE_DIR: "~/site" });
    expect(cfg.ftp.baseDir).toBe("~/site");
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it("rejects a named home and names the variable", () => {
    const cfg = resolveConfig({ ...sshOnly, SSH_BASE_DIR: "~other/site" });
    expect(() => validateConfig(cfg)).toThrow(/SSH_BASE_DIR/);
    expect(() => validateConfig(cfg)).toThrow(/only the logged-in account/);
  });

  it("names the borrowed variable when a named home is inherited", () => {
    // FTP borrows SSH's bad value, so both profiles are bad; FTP is reported first.
    const cfg = resolveConfig({ ...both, SSH_BASE_DIR: "~other/site" });
    expect(cfg.ftp.baseDir).toBe("~other/site");
    expect(() => validateConfig(cfg)).toThrow(/FTP_BASE_DIR/);
  });

  // ssh_exec expands "~" through the remote shell (quoteRemotePath), so a config
  // that never registers the file tools was never affected either way.
  it("allows a tilde when the file tools are not served", () => {
    const cfg = resolveConfig({
      ...sshOnly,
      SSH_BASE_DIR: "~/site",
      SSH_ALLOW_EXEC: "true",
      MCP_CAPABILITIES: "ssh",
    });
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it("does not reject an absolute path containing a tilde later on", () => {
    const cfg = resolveConfig({ ...ftpOnly, FTP_BASE_DIR: "/home/u/~backup" });
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/config.test.mjs`
Expected: FAIL — the accept cases throw the current "is only expanded by a shell" error, and the `~other/site` cases fail on the `only the logged-in account` message.

- [ ] **Step 3: Rewrite the validation block**

In `src/config.mjs`, replace lines 222-243 (the comment beginning "Only a shell expands" through the closing brace of the `if (servesFiles(config))` block) with:

```js
  // A "~" is expanded client-side, from the login directory the server reports
  // once a connection exists — realpath(".") over SFTP, PWD over FTP (see
  // effectiveBaseDir in transports/base-dir.mjs). Neither protocol expands one
  // itself: an OpenSSH server resolves "~" to a directory literally NAMED "~".
  //
  // That lookup can only answer for the account that logged in, so a NAMED home
  // — "~other/site" — has no way to be resolved and would be sent to the server
  // as a literal path. Refuse it by name here rather than let half the tools
  // quietly work: ssh_exec would still succeed, because a remote shell does
  // expand it (quoteRemotePath), which is exactly what makes the failure
  // confusing.
  if (servesFiles(config)) {
    for (const [name, variable, profile] of [
      ["ftp", "FTP_BASE_DIR", config.ftp],
      ["sftp", "SSH_BASE_DIR", config.ssh],
    ]) {
      if (profile && /^~[^/]/.test(profile.baseDir)) {
        throw new Error(
          `The ${name} base directory is "${profile.baseDir}", but only the logged-in ` +
            `account's own home can be resolved: "~" and "~/<dir>" are expanded from the ` +
            `login directory, a named home like "~user/<dir>" cannot be. Set ${variable} ` +
            `(or REMOTE_BASE_DIR) to "~/<dir>" or an absolute path such as ` +
            `"/home/<user>/<dir>".`
        );
      }
    }
  }
```

The regex `/^~[^/]/` matches `~user` and `~user/site` but not `~`, `~/` or `~/site`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS. This is the point at which `SSH_BASE_DIR=~/site` is both startable and correct end to end.

- [ ] **Step 6: Verify by hand against the selftest**

Run:

```bash
SSH_HOST=example.com SSH_USER=deploy SSH_PASSWORD=x SSH_BASE_DIR=~/site node bin/ftp-ssh-mcp.mjs --selftest
```

Expected: prints the `selftest OK` line (no network is touched — the base dir is only expanded when a tool connects). Then confirm the named-home case is still refused:

```bash
SSH_HOST=example.com SSH_USER=deploy SSH_PASSWORD=x SSH_BASE_DIR=~other/site node bin/ftp-ssh-mcp.mjs --selftest
```

Expected: exits with the `only the logged-in account's own home can be resolved` error naming `SSH_BASE_DIR`.

- [ ] **Step 7: Commit**

```bash
git add src/config.mjs test/config.test.mjs
git commit -m "feat(config): accept a tilde base dir, refuse only a named home"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md:198` (`REMOTE_BASE_DIR` row), `:203` (`FTP_BASE_DIR` row), `:214` (`SSH_BASE_DIR` row), and the troubleshooting table ending at `:277`
- Modify: `.env.example:7-10`
- Modify: `SECURITY.md` (the "what this does not protect against" list around line 56-62)

**Interfaces:**
- Consumes: the behaviour built in Tasks 1-4.
- Produces: nothing code-facing.

- [ ] **Step 1: Update the README variable table**

Replace the three rows (keep the surrounding table untouched):

```markdown
| `REMOTE_BASE_DIR` | — | Shared base directory that remote paths are confined to. A leading `~` is expanded to the account's login directory — see below. |
```

```markdown
| `FTP_BASE_DIR` | inherits `REMOTE_BASE_DIR`, then `SSH_BASE_DIR` | Base directory the `files` tools are confined to on this transport. Accepts `~` or `~/<dir>`. |
```

```markdown
| `SSH_BASE_DIR` | inherits `REMOTE_BASE_DIR`, then `FTP_BASE_DIR` | Required for `ssh_exec` and `mysql_query`, which both need a known working directory. Also the confinement root for `files` calls on the sftp transport. Accepts `~` or `~/<dir>`. |
```

- [ ] **Step 2: Add the explanation under the variable table**

Immediately after the variable table, add:

```markdown
#### Tilde base directories

`~` and `~/<dir>` are accepted and expanded to the account's own login directory: `realpath(".")` over SFTP, `PWD` over FTP. The lookup happens on connect, and only when there is a `~` to expand, so an absolute base directory costs nothing extra and the server still needs no network at startup.

Each profile expands its own value against its own login directory. That is deliberate: on cPanel the FTP account is often chrooted so that its `~` is `/`, while SSH sees the real `/home/<user>` — so a `~/public_html` shared through `REMOTE_BASE_DIR` lands in the right place on both.

A **named** home, `~other/site`, is refused at startup. Only the account that logged in can be located, so a named home would be sent to the server as a literal path. Use an absolute path for that case.
```

- [ ] **Step 3: Add a troubleshooting row**

Append to the troubleshooting table (after the `Uploads land somewhere unexpected` row at line 277):

```markdown
| A `~` base directory resolves somewhere unexpected | `~` is the **login** directory the server reports, not `/home/<user>` by definition. A chrooted FTP account reports `/`, so `~/public_html` is `/public_html` there while SSH resolves the same value to `/home/<user>/public_html`. Both are correct for their account; set that profile's own `*_BASE_DIR` to an absolute path if you need to override it. |
```

- [ ] **Step 4: Update `.env.example`**

Replace lines 7-10:

```
# Remote paths are confined to this directory. A profile with no base directory
# of any kind is NOT confined, so set at least one: each profile falls back to
# the other's when it has none of its own.
#
# A leading "~" is expanded to the account's login directory when it connects
# ("~/public_html" works). A named home ("~other/dir") is not supported.
REMOTE_BASE_DIR=
```

- [ ] **Step 5: Update SECURITY.md**

Add to the "does not protect against" list (after the `mysql_query` being powerful item, around line 62):

```markdown
- **A server that misreports its login directory.** When a base directory is
  written as `~`, the confinement root is whatever the host answers for
  `realpath(".")` or `PWD`, so a hostile server could widen the fence by
  reporting `/`. It could also serve any file it liked for any path, so this
  grants it nothing it did not already have. Use an absolute base directory if
  you want the root fixed client-side.
```

- [ ] **Step 6: Verify the docs match the code**

Run: `npx vitest run test/manifest.test.mjs`
Expected: PASS (it pins the manifests to `package.json`; documentation edits must not disturb it).

Re-read each edited passage against `src/config.mjs` and `src/transports/base-dir.mjs`. Every claim about what is accepted or refused must match the regex in `validateConfig` and the branch in `expandRemoteBase`.

- [ ] **Step 7: Commit**

```bash
git add README.md .env.example SECURITY.md
git commit -m "docs: document tilde base directories and their limits"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 `expandRemoteBase` | Task 1 |
| §2 Transports resolve the home | Task 2 |
| §3 `withClient` hands the effective base to the callback | Tasks 2 (produce) and 3 (consume) |
| §4 Config validation | Task 4 |
| §5 Error handling table | Task 1 (non-absolute home), Task 2 (lookup failure), Task 3 (`..` pre-connection), Task 4 (`~user`) |
| §6 Tests | Every task ends with its own |
| §7 Documentation | Task 5 |
| Accepted risk | Task 5, Step 5 |

**Ordering note:** config validation is deliberately last. The integration tests call `resolveConfig` without `validateConfig`, so Tasks 2 and 3 can exercise a tilde base before the startup gate opens — which means the feature is complete and tested at the moment the gate does open, never startable-but-broken.

**Type consistency:** `expandRemoteBase(baseDir, home)` (Task 1) is called only by `effectiveBaseDir(baseDir, variable, lookup)` (Task 2), which is called by `withFtp`/`withSftp` and returns the string passed as the callback's second argument, consumed in Task 3 as `baseDir` and defaulted in the fixture with `??`. `fileProfile(config, override)` returns `{ transport, profile }` — the fixture destructures `{ profile }`, matching `src/transports/index.mjs:14`.
