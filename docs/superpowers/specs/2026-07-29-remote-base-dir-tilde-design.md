# Tilde support for the base directory

Date: 2026-07-29
Status: approved, not yet implemented

## Problem

`SSH_BASE_DIR=~/site` is refused at startup. `validateConfig` (`src/config.mjs`)
throws whenever a base directory begins with `~` and the `files` capability is
served, because FTP and SFTP speak their protocols directly and nothing expands
a tilde there — an OpenSSH server resolves `~` to a directory literally *named*
`~` under the home directory.

The refusal is correct about the mechanism and wrong about the remedy. `~/site`
is the natural way to write a base directory, it is what `ssh_exec` already
accepts, and a user who writes it is told to go find their absolute home path by
hand.

`ssh_exec` and `mysql_query` are unaffected: `quoteRemotePath` (`src/guards.mjs`)
rewrites `~/site` to `"$HOME"/'site'` and a shell expands it. This spec covers
only the six file tools.

## Approach

Expand the tilde at connect time, from the account's own login directory:
`realPath(".")` over SFTP, `PWD` after login over FTP. This is correct on every
host layout — a shared host with a chrooted FTP account whose home is `/`, `/home2/...`
boxes, jailed shells — because the server is the one answering.

Two alternatives were rejected. Probing once at startup would make a stdio MCP
server require the network to launch, and would refuse to start whenever the
host is briefly unreachable. Assuming `/home/<user>` needs no round trip but is
silently wrong on exactly the hosts where a user reaches for `~`.

## Design

### 1. `expandRemoteBase(baseDir, home)` — `src/guards.mjs`

Pure, so it is testable with no network.

- No leading `~`: return `baseDir` unchanged. This is the fast path and keeps
  every existing absolute configuration bit-identical.
- `~` or `~/`: return `home`.
- `~/rest`: return `posix.normalize(posix.join(home, rest))`.
- `home` is not absolute: throw. A relative base directory silently disables
  confinement, which is the one outcome this must not produce.

`~user/rest` never reaches this helper — it is refused in config validation
(§4).

### 2. Transports resolve the home — `src/transports/sftp.mjs`, `ftp.mjs`

Each `with*` wrapper computes the effective base directory for the profile after
the connection is up:

- SFTP: `await sftp.realPath(".")`. The SFTP session starts in the login
  directory.
- FTP: `await client.pwd()`. The login directory, which is `/` inside a chroot.

The lookup runs **only** when `profile.baseDir` starts with `~`, so an absolute
configuration pays nothing. A failure throws with a message naming
`SSH_BASE_DIR` or `FTP_BASE_DIR`, not a bare protocol error.

### 3. `withClient` hands the effective base to the callback

`withClient(config, fn, override)` calls `fn(client, baseDir)` where `baseDir`
is the expanded value from §2.

`src/capabilities/files.mjs` moves its `resolveRemotePath` call inside the
callback and returns the resolved path, so the response text can still name it:

```js
const remote = await withClient(async (c, base) => {
  const target = resolveRemotePath(remotePath, base);
  await c.upload(localPath, target);
  return target;
}, transport);
return text(`Uploaded ${localPath} -> ${remote}`);
```

**Fail-fast is preserved.** Each tool still calls `resolveRemotePath(input, "")`
before connecting, which performs the `..` rejection and the empty-input
rejection. A traversal attempt is refused without touching the network, exactly
as today. Only the fence check — the part that needs a base directory — moves
inside the connection.

Ordering within each tool is unchanged otherwise: `assertWritable`,
`assertDeletable` and `assertLocalFile` still run before any connection.

### 4. Config validation — `src/config.mjs`

`validateConfig` stops refusing `~` and `~/rest`. It keeps refusing `~user/rest`
by name: only the login account's own home is discoverable, so a named home
would resolve somewhere the user did not ask for. The comment block explaining
the old refusal is rewritten to explain the new mechanism.

`normalizeBase` needs no change — `posix.normalize` leaves `~` alone and the
existing trailing-slash strip already folds `~/` to `~`.

The cross-profile fallback is unaffected. If FTP borrows SSH's `~/site`, each
profile expands it against **its own** login directory, which is the right
answer precisely when the FTP account is chrooted and SSH is not.

### 5. Error handling

| Situation | Behaviour |
| --- | --- |
| `~user/site` configured | Startup throws, naming the variable and the limitation |
| Home lookup fails on connect | Throws naming the variable, wrapped around the protocol error |
| Home lookup returns a relative path | Throws from `expandRemoteBase` |
| `..` in a caller's `remotePath` | Refused before connecting, as today |
| Caller path escapes the expanded base | Refused by the existing fence in `resolveRemotePath` |

### 6. Tests

- `test/guards.test.mjs` — `expandRemoteBase` unit cases: absolute passthrough,
  `~`, `~/`, `~/site`, a home of `/`, and the non-absolute-home throw.
- `test/config.test.mjs` — the `tilde base dir` block inverts: `~`, `~/` and
  `~/site` are accepted for both profiles and through the cross-profile
  fallback; `~user/site` is still rejected and names the variable.
- `test/integration/sftp.test.mjs`, `test/integration/ftp.test.mjs` — real
  expansion against the existing fixture servers: with base `~/site`, a tool
  call reaches `<login dir>/site`, and `../` still cannot escape it.
- `test/fixtures/tool-runner.mjs` — supplies the configured base directory to
  the callback so the existing confinement tests in `test/capabilities.test.mjs`
  keep working unchanged.

### 7. Documentation

- README: the `REMOTE_BASE_DIR`, `FTP_BASE_DIR` and `SSH_BASE_DIR` rows gain a
  sentence that a leading `~` is expanded to the account's login directory, with
  the `~user` limitation stated; a troubleshooting row covers a tilde base that
  resolves somewhere unexpected inside a chroot.
- `.env.example`: a comment on the base directory line.
- SECURITY.md: the confinement root can now come from the server's reported
  login directory.

## Accepted risk

With a tilde, the confinement root is whatever the server reports at login, so a
hostile server could report `/` and widen the fence. A hostile server already
controls every file the tools would reach, so this weakens nothing real. It is
documented in SECURITY.md rather than guarded against.

## Out of scope

- `~user/...` expansion.
- Caching the resolved home across connections. The server opens a connection
  per operation by design; one extra cheap round trip on tilde configurations
  only is not worth the stale-state surface.
- Any change to `ssh_exec` or `mysql_query`, which already handle `~`.
