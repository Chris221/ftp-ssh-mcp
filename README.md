# ftp-ssh-mcp

[![npm version](https://img.shields.io/npm/v/ftp-ssh-mcp.svg)](https://www.npmjs.com/package/ftp-ssh-mcp)
[![npm downloads](https://img.shields.io/npm/dm/ftp-ssh-mcp.svg)](https://www.npmjs.com/package/ftp-ssh-mcp)
[![CI](https://github.com/Chris221/ftp-ssh-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Chris221/ftp-ssh-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/ftp-ssh-mcp.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/ftp-ssh-mcp.svg)](./LICENSE)

An MCP server for working with a single remote host over FTP, FTPS, SFTP, and SSH — the kind of host a typical shared-hosting or cPanel deployment gives you, not a cloud provider's API. It groups its tools into three capability classes: file transfer (list, upload, download, mkdir, delete), shell execution over SSH, and a MySQL query wrapper that also runs over SSH. File transfer is the only capability enabled by default — shell execution and database access are both opt-in and stay off until you explicitly turn them on.

## Quickstart

Add the server to your MCP client's configuration:

```json
{
  "mcpServers": {
    "remote": { "command": "npx", "args": ["-y", "ftp-ssh-mcp@1"] }
  }
}
```

On Windows, some clients need the command spelled out:

```json
{
  "mcpServers": {
    "remote": { "command": "cmd", "args": ["/c", "npx", "-y", "ftp-ssh-mcp@1"] }
  }
}
```

Then create a `.env` file in your project root (the server discovers it relative to the MCP client's working directory) with at least a host, a user, and a secret:

```
REMOTE_HOST=ftp.example.com
REMOTE_USER=deploy
REMOTE_PASSWORD=your-password
REMOTE_BASE_DIR=/home/deploy/public_html
```

See [`.env.example`](./.env.example) for every variable, and the Configuration section below for what each one does.

## Capabilities

A capability's tools are only registered when it is both configured (its required variables are set) and, if `MCP_CAPABILITIES` restricts the set, named in that list.

| Capability | Tools | Enabled when |
| --- | --- | --- |
| `files` | `file_list`, `file_upload`, `file_upload_dir`, `file_download`, `file_mkdir`, `file_delete` | An FTP or SSH profile is configured. `file_delete` additionally requires `FTP_ALLOW_DELETE=true`; all writes require `FTP_READONLY` to be unset or `false`. |
| `ssh` | `ssh_exec` | An SSH profile is configured with `SSH_BASE_DIR` set and `SSH_ALLOW_EXEC=true`. |
| `mysql` | `mysql_query` | An SSH profile is configured, and `DB_USER` and `DB_NAME` are both set. `DB_PASSWORD` is not required — see below. |

The `files` tools are transport-neutral: they work over whichever transport `FILE_TRANSPORT` selects (`ftp` or `sftp`), and each call can override the transport for that one call if both profiles are configured. `mysql_query` is a convenience wrapper, not a database driver — it pipes SQL over SSH to the `mysql` client already installed on the host (`mysql --user=... --database=... --table`, with the SQL sent on stdin), then parses the CLI's table output. There is no connection pooling and no parameterised-query support. It exists because most shared hosts will not accept a database connection from outside the host itself; if you need a real client-side database integration, use one instead of `mysql_query`.

## Configuration

Every setting is resolved from environment variables in this order: a profile-specific variable (`FTP_*` or `SSH_*`) first, then the shared `REMOTE_*` fallback, then a built-in default. Two independent profiles exist — FTP and SSH — and you may configure either, both, or neither in isolation (though at least one is required to start).

Variables are normally read from process environment, but the server also loads a `.env` file from the current working directory before resolving configuration, so credentials can live outside the MCP client's own (often tracked) config file. A real environment variable already set takes precedence over the `.env` file. Point at a different file with `MCP_ENV_FILE`. **The `.env` parser does not support inline comments** — `KEY=value # note` treats everything after `=` as the value, including ` # note`, so keep comments on their own line.

### Secret inheritance

Non-secret settings (`HOST`, `USER`, `BASE_DIR`) fall back to `REMOTE_*` freely. Secrets (`PASSWORD`, `PRIVATE_KEY`, `PASSPHRASE`) fall back to `REMOTE_PASSWORD` **only when the profile does not set its own `*_USER`**. A profile that names its own user is declaring a distinct identity, and sending that identity a password meant for a different account causes repeated authentication failures — on cPanel specifically, enough failures trip cPHulk and lock the account out at the host level. If `FTP_USER` (or `SSH_USER`) is set, its password must be set explicitly too.

### Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `REMOTE_HOST` | — | Shared host, used when a profile does not set its own. |
| `REMOTE_USER` | — | Shared user. |
| `REMOTE_PASSWORD` | — | Shared secret. Only inherited by a profile with no `*_USER` of its own. |
| `REMOTE_BASE_DIR` | — | Shared base directory that remote paths are confined to. |
| `FTP_HOST` | inherits `REMOTE_HOST` | |
| `FTP_PORT` | `21` | |
| `FTP_USER` | inherits `REMOTE_USER` | |
| `FTP_PASSWORD` | see secret inheritance | |
| `FTP_BASE_DIR` | inherits `REMOTE_BASE_DIR` | |
| `FTP_SECURITY` | `ftps` | `ftps` (explicit TLS), `ftp` (plaintext), or `ftps-implicit`. |
| `FTP_TLS_REJECT_UNAUTHORIZED` | `true` | Set `false` to accept a self-signed or otherwise unverifiable certificate. |
| `FTP_TIMEOUT_MS` | `30000` | |
| `SSH_HOST` | inherits `REMOTE_HOST` | |
| `SSH_PORT` | `22` | |
| `SSH_USER` | inherits `REMOTE_USER` | |
| `SSH_PASSWORD` | see secret inheritance | Password auth. Can be combined with a key; the server will try both. |
| `SSH_PRIVATE_KEY` | see secret inheritance | Local path to a private key. A leading `~` is expanded. |
| `SSH_PASSPHRASE` | see secret inheritance | Passphrase for `SSH_PRIVATE_KEY`. |
| `SSH_BASE_DIR` | inherits `REMOTE_BASE_DIR` | Required for `ssh_exec` and `mysql_query`, which both need a known working directory. |
| `SSH_ACTIVATE` | — | Remote path to a script (e.g. a Node virtualenv's `activate`) sourced before every command. Missing file is non-fatal — the command still runs. |
| `SSH_TIMEOUT_MS` | `120000` | Connection and per-command timeout. |
| `SSH_MAX_OUTPUT` | `100000` | Combined stdout+stderr byte cap per command; output beyond this is truncated, not buffered. |
| `SSH_ALLOWED_CMDS` | `npm,node,mysql,mysqldump,touch,ls,cat,tail,head,df,du,pwd` | Comma-separated allowlist of program names `ssh_exec` may invoke. |
| `DB_USER` | inherits `REMOTE_USER` | |
| `DB_PASSWORD` | see secret inheritance | See below — not required. |
| `DB_NAME` | — | Default database for `mysql_query`; can be overridden per call. |
| `FILE_TRANSPORT` | `ftp` if an FTP profile is configured, else `sftp` if an SSH profile is configured, else `ftp` | Which profile serves the `files` tools. |
| `MCP_CAPABILITIES` | all configured capabilities | Comma-separated allowlist restricting which capabilities register tools (`files`, `ssh`, `mysql`). An unrecognised name fails startup. |
| `FTP_READONLY` | `false` | When `true`, blocks every write across both file transfer and `ssh_exec` (uploads, deletes, mkdir, and shell commands alike). |
| `FTP_ALLOW_DELETE` | `false` | Must be `true` for `file_delete` to work. |
| `SSH_ALLOW_EXEC` | `false` | Must be `true` for `ssh_exec` to be registered at all. |

A `DB_USER` with no resolvable `DB_PASSWORD` is not treated as an error: the remote `mysql` client can legitimately get credentials from `~/.my.cnf` or a trusted local socket instead of a password on the connection. The server prints a warning to stderr at startup rather than refusing to run, and if a query then fails to authenticate, `mysql_query`'s error message names `DB_PASSWORD` again so the cause is visible from inside the MCP client, not just in a startup log you may not have seen.

## Security

- `ssh_exec` only runs a program named in `SSH_ALLOWED_CMDS`, checked against the first whitespace-delimited token of the command — not a policy over arguments.
- Before that check, the command is rejected outright if it contains any of a fourteen-character shell metacharacter class (`; & | ` `$` `(` `)` `{` `}` `<` `>` `\` and newline/carriage return), so a call can only ever be a single plain invocation — no chaining, redirection, or substitution.
- Remote paths passed to the `files` tools and to `SSH_BASE_DIR`/`FTP_BASE_DIR` are resolved and confined to the profile's configured base directory; `..` segments are rejected outright.
- Deletes (`FTP_ALLOW_DELETE`) and shell execution (`SSH_ALLOW_EXEC`) are both off by default and must be turned on explicitly.
- `mysql_query` never builds a shell string from your SQL — the query is written to the `mysql` client's stdin, and the password is passed via the `MYSQL_PWD` environment variable rather than argv, so it does not appear in the host's process list.

None of this makes the remote host a sandbox. An allowed command still runs with the full privileges of whichever account is configured, and there is no isolation between what `ssh_exec` can do and what that account could do logged in directly. The guards constrain the *shape* of a single call — one program, no shell tricks, paths that stay inside a base directory — they do not constrain what an allowed program itself is capable of once it runs.

## Development

```bash
git clone https://github.com/Chris221/ftp-ssh-mcp.git
cd ftp-ssh-mcp
npm install
npm test
npm run selftest
```

`npm test` runs the Vitest suite, including capability-registration and transport tests against an in-process FTP server. `npm run selftest` resolves configuration from the environment (and `.env`, if present), registers tools, and prints a one-line summary — including the resolved transport and which capabilities registered — without opening a connection or starting the stdio transport.
