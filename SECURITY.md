# Security policy

`ftp-ssh-mcp` hands an AI assistant file access, and optionally shell execution
and database queries, against a real remote host. A bug here can cost someone
their production site, so please report problems privately rather than opening
a public issue.

## Supported versions

This is a single-maintainer package with one supported line: **the latest
published version**. Fixes are released as a new version; older versions are not
patched in place.

| Version | Supported |
| --- | --- |
| latest release | yes |
| anything older | no — upgrade |

## Reporting a vulnerability

Use GitHub's private reporting form:
[**Report a vulnerability**](https://github.com/Chris221/ftp-ssh-mcp/security/advisories/new).
It is private to the maintainer until an advisory is published.

If that is not available to you, open a public issue that says only that you
have a security report and asks for a contact — no details — and you will get a
way to send them privately.

Please include, as far as you can:

- what an attacker can do, and what they need in order to do it (network
  position, a configured profile, a hostile MCP client, an untrusted file name);
- the affected version and the relevant configuration, **with credentials,
  hostnames and paths redacted**;
- steps to reproduce, ideally against a local test server rather than a real
  host.

## What to expect

This is maintained by one person in their own time, so these are honest
expectations rather than a guaranteed SLA:

- **Acknowledgement within 7 days.** If you have heard nothing after that,
  assume the report was missed and ping the same thread.
- An assessment — whether it is accepted, and roughly how severe — within
  30 days of acknowledgement.
- For an accepted report, a fix in a new release, with credit in the advisory
  unless you ask otherwise.

Please give a reasonable window before disclosing publicly, and say up front if
you have a disclosure deadline so it can be planned around.

## Out of scope

These are documented behaviours, not vulnerabilities:

- **An allowed command doing what that command can do.** `ssh_exec` constrains
  the *shape* of a call — one program, from `SSH_ALLOWED_CMDS`, no shell
  metacharacters, inside `SSH_BASE_DIR`. It does not sandbox the program itself.
- **`mysql_query` being powerful.** It runs arbitrary SQL, and the `mysql`
  client's `\!` is a shell escape. It is documented as being at least as
  dangerous as `ssh_exec`.
- **`DB_PASSWORD` appearing in the host's process list** while a query runs. It
  is passed as a shell environment assignment; the README says so, and improving
  it is tracked as a normal enhancement.
- **Anything requiring an attacker who already controls the configured account,
  the `.env` file, or the machine the server runs on.**

Reports about the host being reachable at all, or about a configuration the
operator chose (`FTP_SECURITY=ftp`, `FTP_TLS_REJECT_UNAUTHORIZED=false`,
`SSH_HOST_FINGERPRINT` left unset), are also out of scope — though a case where
the documentation *understates* the risk of one of those is very much in scope,
and welcome.
