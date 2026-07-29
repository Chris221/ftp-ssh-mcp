# ftp-ssh-mcp

[![npm version](https://img.shields.io/npm/v/ftp-ssh-mcp.svg)](https://www.npmjs.com/package/ftp-ssh-mcp)
[![npm downloads](https://img.shields.io/npm/dm/ftp-ssh-mcp.svg)](https://www.npmjs.com/package/ftp-ssh-mcp)
[![CI](https://github.com/Chris221/ftp-ssh-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Chris221/ftp-ssh-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/ftp-ssh-mcp.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/ftp-ssh-mcp.svg)](./LICENSE)

An MCP server for working with a single remote host over FTP, FTPS, SFTP, and SSH — the kind of host a typical shared-hosting plan or a plain VPS gives you, not a cloud provider's API. It groups its tools into three capability classes: file transfer (list, upload, download, mkdir, delete), shell execution over SSH, and a MySQL query wrapper that also runs over SSH. File transfer is the only capability enabled by default — shell execution and database access are both opt-in and stay off until you explicitly turn them on. Treat those two as equally dangerous: `mysql_query` runs arbitrary SQL on a production database and can escape to a shell, so it is not the milder of the pair.

## Install

Published to npm and run with `npx` — there is nothing to clone or build. Requires Node 20 or newer. Works on Windows, macOS and Linux.

### 1. Add it to your MCP client

> **On Windows, use the `cmd /c` form shown for each client below.** Most clients spawn `command` directly rather than through a shell, and `npx` on Windows is a `.cmd` shim that cannot be executed that way — the server simply fails to start, usually with no useful error. Treat this as the rule on Windows, not an edge case.

<details open>
<summary><b>Claude Code</b> — <code>.mcp.json</code> in the project root</summary>

```json
{
  "mcpServers": {
    "remote": { "command": "npx", "args": ["-y", "ftp-ssh-mcp@1"] }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "remote": { "command": "cmd", "args": ["/c", "npx", "-y", "ftp-ssh-mcp@1"] }
  }
}
```

</details>

<details>
<summary><b>Claude Desktop</b> — <code>claude_desktop_config.json</code></summary>

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Same `mcpServers` shape as Claude Code. Claude Desktop has no project directory, so set `MCP_ENV_FILE` to an absolute path — see step 2.

</details>

<details>
<summary><b>Cursor</b> — <code>.cursor/mcp.json</code> (project) or <code>~/.cursor/mcp.json</code> (global)</summary>

Same `mcpServers` shape as Claude Code.

</details>

<details>
<summary><b>VS Code</b> — <code>.vscode/mcp.json</code> (workspace), or <b>MCP: Open User Configuration</b> for global</summary>

VS Code uses `servers`, **not** `mcpServers`:

```json
{
  "servers": {
    "remote": { "command": "npx", "args": ["-y", "ftp-ssh-mcp@1"] }
  }
}
```

</details>

<details>
<summary><b>Codex CLI</b> — <code>~/.codex/config.toml</code>, or <code>.codex/config.toml</code> in a trusted project</summary>

Codex uses TOML with a snake_case `mcp_servers` table:

```toml
[mcp_servers.remote]
command = "npx"
args = ["-y", "ftp-ssh-mcp@1"]
```

Windows:

```toml
[mcp_servers.remote]
command = "cmd"
args = ["/c", "npx", "-y", "ftp-ssh-mcp@1"]
```

Or add it from the shell: `codex mcp add remote -- npx -y ftp-ssh-mcp@1`

</details>

### 2. Point it at a host

Create a `.env` file in your project root. The server reads it from the working directory, which is the project root for project-scoped clients:

```
REMOTE_HOST=ftp.example.com
REMOTE_USER=deploy
REMOTE_PASSWORD=your-password
REMOTE_BASE_DIR=/home/deploy/public_html
```

That is enough for the six file tools over FTPS. **Keep this file out of version control** — add `.env` and `.env.*` to `.gitignore`. Getting credentials out of a tracked config file is the reason the server reads `.env` at all.

If your client has no project directory (Claude Desktop), or you want several servers against different accounts, point each at its own file instead:

```json
{
  "mcpServers": {
    "prod": {
      "command": "npx",
      "args": ["-y", "ftp-ssh-mcp@1"],
      "env": { "MCP_ENV_FILE": "/absolute/path/to/.env.prod" }
    }
  }
}
```

A fuller setup, adding shell execution and database access — both off unless you opt in:

```
REMOTE_HOST=example.com
REMOTE_USER=deploy
REMOTE_PASSWORD=your-password
REMOTE_BASE_DIR=/home/deploy/public_html

# Pin the host key. Without this, any host key is accepted — see Security.
SSH_HOST_FINGERPRINT=SHA256:your-fingerprint-here
SSH_PORT=22
SSH_BASE_DIR=/home/deploy
SSH_ALLOW_EXEC=true
SSH_ALLOWED_CMDS=@basic,@node

# Runs the mysql client on the host over SSH. At least as dangerous as
# SSH_ALLOW_EXEC — read the Security section before enabling.
DB_USER=deploy_dbuser
DB_PASSWORD=your-db-password
DB_NAME=deploy_db

# Off by default; required for file_delete.
REMOTE_ALLOW_DELETE=true
```

See [`.env.example`](./.env.example) for every variable and Configuration below for what each does.

### 3. Check it before you rely on it

```bash
npx -y ftp-ssh-mcp@1 --selftest
```

Run it from the directory holding your `.env`. It resolves configuration, registers tools and prints a one-line summary — **without opening a connection** — then exits. Use it to confirm the right capabilities came up before wiring the server into a client:

```
ftp-ssh-mcp 1.0.1 selftest OK. env=.env, transport=ftp, host=example.com,
capabilities=[files, ssh, mysql], tools=[file_list, file_upload, ...]
```

It exits non-zero with a message naming the missing variable if configuration is incomplete. See Troubleshooting.

### Options

| Option | Does |
| --- | --- |
| `--selftest` | Resolve the configuration, print the tools it would register, and exit. Opens no connection. |
| `-q`, `--quiet` | Drop the informational startup warnings. |
| `-v`, `--version` | Print the version and exit. |
| `-h`, `--help` | Print usage and exit. |

`--version` and `--help` answer before any configuration is read, so they work on a machine with nothing set up yet. Both print to stdout; everything else the server says goes to stderr, because stdout is the JSON-RPC channel.

`--quiet` silences the warnings about a missing `DB_PASSWORD`, an `MCP_CAPABILITIES` entry that registered no tools, and a relative base directory. It deliberately does **not** silence the two that say your security posture is weaker than you might assume — an unverified host key, or path confinement switched off. A flag set once in a client's config file is never looked at again, so those stay visible until you fix them, which is the only silence worth having.

## Capabilities

A capability's tools are only registered when it is both configured (its required variables are set) and, if `MCP_CAPABILITIES` restricts the set, named in that list.

| Capability | Tools | Enabled when |
| --- | --- | --- |
| `files` | `file_list`, `file_upload`, `file_upload_dir`, `file_download`, `file_mkdir`, `file_delete` | An FTP or SSH profile is configured. `file_delete` additionally requires `REMOTE_ALLOW_DELETE=true`; all writes require `REMOTE_READONLY` to be unset or `false`. |
| `ssh` | `ssh_exec` | An SSH profile is configured with `SSH_BASE_DIR` set and `SSH_ALLOW_EXEC=true`. |
| `mysql` | `mysql_query` | An SSH profile is configured, and `DB_USER` and `DB_NAME` are both set. `DB_USER` must be set explicitly — it does not inherit `REMOTE_USER` — so the capability cannot switch itself on. Blocked entirely by `REMOTE_READONLY=true`. `DB_PASSWORD` is not required — see below. |

The `files` tools are transport-neutral: they work over whichever transport `FILE_TRANSPORT` selects (`ftp` or `sftp`), and each call can override the transport for that one call if both profiles are configured. `mysql_query` is a convenience wrapper, not a database driver — it pipes SQL over SSH to the `mysql` client already installed on the host (`mysql --user=... --database=... --table`, with the SQL sent on stdin), then parses the CLI's table output. There is no connection pooling and no parameterised-query support. It exists because most shared hosts will not accept a database connection from outside the host itself; if you need a real client-side database integration, use one instead of `mysql_query`. **Enable it with the same caution as `ssh_exec`, not less** — see Security.

## Configuration

Every setting is resolved from environment variables in this order: a profile-specific variable (`FTP_*` or `SSH_*`) first, then the shared `REMOTE_*` fallback, then a built-in default. Two independent profiles exist — FTP and SSH — and you may configure either, both, or neither in isolation (though at least one is required to start).

Variables are normally read from process environment, but the server also loads a `.env` file from the current working directory before resolving configuration, so credentials can live outside the MCP client's own (often tracked) config file. A real environment variable already set takes precedence over the `.env` file. Point at a different file with `MCP_ENV_FILE` — a leading `~` is expanded to your home directory, a relative value is resolved against the working directory, and a set-but-unreadable one **fails startup** rather than silently falling back to `.env` and loading different credentials than the ones you named. **The `.env` parser does not support inline comments** — `KEY=value # note` treats everything after `=` as the value, including ` # note`, so keep comments on their own line.

### Secret inheritance

Non-secret settings (`HOST`, `USER`, `BASE_DIR`) fall back to `REMOTE_*` freely. Secrets (`PASSWORD`, `PRIVATE_KEY`, `PASSPHRASE`) fall back to `REMOTE_PASSWORD` **only when the profile does not set its own `*_USER`**. A profile that names its own user is declaring a distinct identity, and sending that identity a password meant for a different account causes repeated authentication failures — on many shared hosts, enough failures trip brute-force protection and lock the account out at the host level. If `FTP_USER` (or `SSH_USER`) is set, its password must be set explicitly too.

### Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `REMOTE_HOST` | — | Shared host, used when a profile does not set its own. |
| `REMOTE_USER` | — | Shared user. |
| `REMOTE_PASSWORD` | — | Shared secret. Only inherited by a profile with no `*_USER` of its own. |
| `REMOTE_BASE_DIR` | — | Shared base directory that remote paths are confined to. A leading `~` is expanded to the account's login directory — see below. |
| `FTP_HOST` | inherits `REMOTE_HOST` | |
| `FTP_PORT` | `21` | |
| `FTP_USER` | inherits `REMOTE_USER` | |
| `FTP_PASSWORD` | see secret inheritance | |
| `FTP_BASE_DIR` | inherits `REMOTE_BASE_DIR`, then `SSH_BASE_DIR` | Base directory the `files` tools are confined to on this transport. Accepts `~` or `~/<dir>`. |
| `FTP_SECURITY` | `ftps` | `ftps` (explicit TLS), `ftp` (plaintext), or `ftps-implicit`. |
| `FTP_TLS_REJECT_UNAUTHORIZED` | `true` | Set `false` to accept a self-signed or otherwise unverifiable certificate. |
| `FTP_TIMEOUT_MS` | `30000` | |
| `SSH_HOST` | inherits `REMOTE_HOST` | |
| `SSH_PORT` | `22` | |
| `SSH_USER` | inherits `REMOTE_USER` | |
| `SSH_PASSWORD` | see secret inheritance | Password auth. Can be combined with a key; the server will try both. |
| `SSH_PRIVATE_KEY` | see secret inheritance | Local path to a private key. A leading `~` is expanded. |
| `SSH_PASSPHRASE` | see secret inheritance | Passphrase for `SSH_PRIVATE_KEY`. |
| `SSH_HOST_FINGERPRINT` | inherits `REMOTE_HOST_FINGERPRINT` | SHA-256 host key fingerprint to pin. Accepts the `SHA256:<base64>` form or a bare hex digest. Not a secret, so it inherits freely. Unset means any host key is accepted, and the server warns at startup. See Security below. |
| `SSH_BASE_DIR` | inherits `REMOTE_BASE_DIR`, then `FTP_BASE_DIR` | Required for `ssh_exec` and `mysql_query`, which both need a known working directory. Also the confinement root for `files` calls on the sftp transport. Accepts `~` or `~/<dir>`. |
| `SSH_ACTIVATE` | — | Remote path to a script (e.g. a Node virtualenv's `activate`) sourced before every command. Missing file is non-fatal — the command still runs. |
| `SSH_TIMEOUT_MS` | `120000` | Connection and per-command timeout. |
| `SSH_MAX_OUTPUT` | `100000` | Combined stdout+stderr byte cap per command; output beyond this is truncated, not buffered. |
| `SSH_ALLOWED_CMDS` | `@basic,@node,@mysql` | Comma-separated allowlist of program names `ssh_exec` may invoke. Entries starting with `@` are presets — see the table below. The default expands to the same twelve commands the old literal default listed. |
| `DB_USER` | — | Must be set explicitly. Unlike other non-secrets it does **not** inherit `REMOTE_USER`, so `DB_NAME` alone cannot activate `mysql_query`. |
| `DB_PASSWORD` | see secret inheritance | See below — not required. |
| `DB_NAME` | — | Default database for `mysql_query`; can be overridden per call. |
| `FILE_TRANSPORT` | `ftp` if an FTP profile is configured, else `sftp` if an SSH profile is configured, else `ftp` | Which profile serves the `files` tools. |
| `MCP_CAPABILITIES` | all configured capabilities | Comma-separated allowlist restricting which capabilities register tools (`files`, `ssh`, `mysql`). An unrecognised name fails startup. |
| `REMOTE_READONLY` | `false` | When `true`, blocks every write across file transfer, `ssh_exec` and `mysql_query` (uploads, deletes, mkdir, shell commands and SQL alike). `FTP_READONLY`, the pre-1.0 name, still works; a set `REMOTE_READONLY` wins. |
| `REMOTE_ALLOW_DELETE` | `false` | Must be `true` for `file_delete` to work. `FTP_ALLOW_DELETE`, the pre-1.0 name, still works; a set `REMOTE_ALLOW_DELETE` wins. |
| `SSH_ALLOW_EXEC` | `false` | Must be `true` for `ssh_exec` to be registered at all. |

#### Command presets

`SSH_ALLOWED_CMDS` entries starting with `@` expand to a named group; presets and literal command names mix freely (`SSH_ALLOWED_CMDS=@basic,@php,rsync`). An unknown preset name fails startup. Presets are named after stacks, not hosting products, and expand as follows:

| Preset | Commands |
| --- | --- |
| `@basic` | `ls`, `cat`, `tail`, `head`, `df`, `du`, `pwd`, `touch` |
| `@node` | `node`, `npm` |
| `@php` | `php`, `composer` |
| `@mysql` | `mysql`, `mysqldump` |

A `DB_USER` with no resolvable `DB_PASSWORD` is not treated as an error: the remote `mysql` client can legitimately get credentials from `~/.my.cnf` or a trusted local socket instead of a password on the connection. The server prints a warning to stderr at startup rather than refusing to run, and if a query then fails to authenticate, `mysql_query`'s error message names `DB_PASSWORD` again so the cause is visible from inside the MCP client, not just in a startup log you may not have seen.

#### Tilde base directories

`~` and `~/<dir>` are accepted and expanded to the account's own login directory: `realpath(".")` over SFTP, `PWD` over FTP, for the `files` tools. That lookup happens on connect, and only when there is a `~` to expand, so an absolute base directory costs nothing extra and the server still needs no network at startup.

`ssh_exec` and `mysql_query` resolve the same setting a different way: the raw `~` is handed to the remote login shell, which expands `$HOME` itself on every command, so there is no connect-time lookup on that path at all. The two mechanisms agree in practice, since they resolve against the same logged-in account — only *when* and *how* the expansion happens differ.

Each profile expands its own value against its own login directory. That is deliberate: on many shared hosts the FTP account is chrooted so that its `~` is `/`, while SSH sees the real `/home/<user>` — so a `~/public_html` shared through `REMOTE_BASE_DIR` lands in the right place on both.

A **named** home, `~other/site`, is refused at startup — but only when the `files` tools are registered; a config that excludes them (e.g. `MCP_CAPABILITIES=ssh`) starts fine and only fails later, the first time `ssh_exec` or `mysql_query` tries to `cd` there. Only the account that logged in can be located, so a named home would be sent to the server as a literal path. Use an absolute path for that case.

## Security

- `ssh_exec` only runs a program named in `SSH_ALLOWED_CMDS`, checked against the first whitespace-delimited token of the command — not a policy over arguments.
- Before that check, the command is rejected outright if it contains any of a fourteen-character shell metacharacter class (`; & | ` `$` `(` `)` `{` `}` `<` `>` `\` and newline/carriage return), so a call can only ever be a single plain invocation — no chaining, redirection, or substitution.
- Remote paths passed to the `files` tools and to `SSH_BASE_DIR`/`FTP_BASE_DIR` are resolved and confined to the profile's configured base directory; `..` segments are rejected outright. Confinement is per profile, and a per-call `transport` override is confined to the profile it selects, not to the default one. **A profile with no base directory at all is not confined** — there is nothing to confine it to — so each profile falls back to the other's base directory when it has none of its own, and the server warns on stderr at startup for any transport that still ends up without one.
- Deletes (`REMOTE_ALLOW_DELETE`) and shell execution (`SSH_ALLOW_EXEC`) are both off by default and must be turned on explicitly.
- **Pin the SSH host key with `SSH_HOST_FINGERPRINT`.** Unless it is set, the SSH and SFTP connections accept whatever host key they are offered — there is no `known_hosts` to fall back on — so anything on the network path can present its own key and be handed the account's password. When the variable is set, a mismatched key aborts the connection with an error naming both the expected and the received fingerprint; when it is unset, the server says so in a startup warning on stderr. Get the value from the host you trust with:

  ```bash
  ssh-keyscan -t rsa your-host.example.com | ssh-keygen -lf -
  ```

  and copy the `SHA256:…` field (a bare hex digest is also accepted). A fingerprint that cannot be parsed is a startup error rather than a silent fallback to "no verification".
- `mysql_query` never builds a shell string from your SQL — the query is written to the `mysql` client's stdin, so it is never interpolated into a command line.
- **`DB_PASSWORD` never appears in the host's process list.** It is delivered as the first line of the command's stdin, read into `MYSQL_PWD` by the remote shell and exported to the `mysql` process — so no argv anywhere carries it, and `ps aux` shows only the harmless command text. The secret exists only in process environments, which are owner-readable. One constraint follows from the framing: a password containing a line break is refused with an explicit error. When `DB_PASSWORD` is unset, no password mechanism runs at all, so host-side credentials such as `~/.my.cnf` genuinely take over.
- **`mysql_query` is at least as powerful as `ssh_exec`, not a lesser grant.** It runs arbitrary SQL against a production database, and the `mysql` client's `\!` command is a shell escape that is honoured on piped input — so `\! curl … | sh` reaches a shell regardless of `SSH_ALLOW_EXEC` and `SSH_ALLOWED_CMDS`. The two capabilities are separate switches because they are separate features, not because one is safer; enable `mysql` with the same care as `ssh`.

None of this makes the remote host a sandbox. An allowed command still runs with the full privileges of whichever account is configured, and there is no isolation between what `ssh_exec` can do and what that account could do logged in directly. The guards constrain the *shape* of a single call — one program, no shell tricks, paths that stay inside a base directory — they do not constrain what an allowed program itself is capable of once it runs.

Found a security problem? Please report it privately — see [SECURITY.md](./SECURITY.md).

### Known advisories

`npm install ftp-ssh-mcp` currently reports **two moderate advisories** for
`@hono/node-server`, pulled in transitively by `@modelcontextprotocol/sdk`. They
concern path traversal in that package's static-file server on Windows. This
server talks JSON-RPC over stdio and never starts an HTTP listener, so that code
path is not reachable here, and the only "fix" npm offers is a breaking downgrade
of the SDK. CI runs `npm audit --omit=dev --audit-level=high`, which passes today
while still failing the build on anything high or critical. The advisories will
clear when the SDK updates its dependency.

## Troubleshooting

Start with `npx -y ftp-ssh-mcp@1 --selftest` from the directory holding your `.env`. It reproduces everything the server does at startup except connecting, so it separates a configuration problem from a network or credentials one.

| Symptom | Cause |
| --- | --- |
| Server never starts, no error in the client | On Windows, `command` is `npx`. Use the `cmd /c` form — see Install. |
| `No connection profile configured` | No host or user resolved. Set `REMOTE_HOST` and `REMOTE_USER`, or the `FTP_*`/`SSH_*` equivalents. |
| `env=<none>` in the selftest output | No `.env` file was found and `MCP_ENV_FILE` is unset. `.env` is resolved from the **working directory**, not from the config file's location or the package's. Set `MCP_ENV_FILE` to an absolute path if your client has no project directory. |
| `MCP_ENV_FILE is "…", but that file could not be read` | The explicitly named env file does not exist or is not readable at that path (resolved against the working directory when relative). This fails startup deliberately — a typo'd path must not silently start the server on whatever `.env` happens to be in the working directory. |
| `<PREFIX>_PASSWORD is not set` even though `REMOTE_PASSWORD` is | The profile sets its own `*_USER`, so it is treated as a distinct identity and does not inherit the shared secret. Set its password explicitly — see Secret inheritance. |
| A tool you expected is missing | Its capability is not enabled. `ssh_exec` needs `SSH_ALLOW_EXEC=true` **and** `SSH_BASE_DIR`; `mysql_query` needs `DB_USER` **and** `DB_NAME`, with `DB_USER` set explicitly. Check `capabilities=[…]` in the selftest line. |
| Selftest says `capabilities=[]` | `MCP_CAPABILITIES` names capabilities that are not configured. It can only narrow what is already configured, never enable anything. |
| Value from `.env` has a trailing comment in it | The parser has no inline-comment support. Put comments on their own line. |
| Warning about an unverified host key | `SSH_HOST_FINGERPRINT` is unset. Expected until you pin it, and not a failure — see Security. |
| Warning that path confinement is disabled | The transport's profile has no base directory and neither does the other one. Set `REMOTE_BASE_DIR`. |
| Warning that the base directory is relative | The value has no leading `/` and is not `~`-relative — often a dropped leading slash, as in `home/u/site`. It still works, because the server resolves it against wherever the session starts, but the root is then the server's choice rather than one pinned at connect. Write `~/site` for the account's own home, or an absolute path. |
| Uploads land somewhere unexpected | Remote paths are relative to the profile's base directory, and each profile has its own. A per-call `transport` override resolves against *that* profile's base directory, not the default one. |
| A `~` base directory resolves somewhere unexpected | `~` is the **login** directory the server reports, not `/home/<user>` by definition. A chrooted FTP account reports `/`, so `~/public_html` is `/public_html` there while SSH resolves the same value to `/home/<user>/public_html`. Both are correct for their account; set that profile's own `*_BASE_DIR` to an absolute path if you need to override it. |

## Development

```bash
git clone https://github.com/Chris221/ftp-ssh-mcp.git
cd ftp-ssh-mcp
npm install
npm test
npm run selftest
```

`npm test` runs the Vitest suite, including capability-registration and transport tests against an in-process FTP server. `npm run selftest` resolves configuration from the environment (and `.env`, if present), registers tools, and prints a one-line summary — including the resolved transport and which capabilities registered — without opening a connection or starting the stdio transport.
