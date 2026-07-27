// Query the host's MySQL database by piping SQL to the mysql client over SSH.
//
// THIS IS AT LEAST AS POWERFUL AS ssh_exec. It runs arbitrary SQL against a
// production database, and the mysql client's `\!` command is a shell escape
// that is honoured on piped input — so `\! curl … | sh` runs a shell regardless
// of SSH_ALLOW_EXEC or SSH_ALLOWED_CMDS. It is gated by its own DB_*
// configuration rather than by SSH_ALLOW_EXEC because the two are separate
// switches, NOT because it is the milder of the two: DB_USER must be set
// explicitly (it does not inherit REMOTE_USER) precisely so that turning this
// on is a deliberate act, and FTP_READONLY blocks it exactly as it blocks
// ssh_exec.

import { z } from "zod";

import { shellQuote } from "../guards.mjs";
import { formatResult, sshRun } from "../ssh.mjs";

export default {
  name: "mysql",

  isConfigured(config) {
    return Boolean(config.ssh && config.db && config.db.user && config.db.name);
  },

  register(ctx) {
    const { config, register, text } = ctx;

    register(
      "mysql_query",
      {
        title: "Run SQL on the host database",
        description:
          "Run SQL against the host's MySQL database by piping it to the mysql client over SSH. " +
          "Most shared hosts only accept database connections from the host itself, so this avoids " +
          "needing a tunnel. SQL is sent over stdin, never interpolated into a shell command.",
        inputSchema: {
          sql: z.string().describe("SQL to execute. Multiple statements may be separated by ';'."),
          database: z.string().optional().describe("Database to run against. Defaults to DB_NAME."),
        },
      },
      async ({ sql, database }) => {
        // Same clamp, and the same message, as ssh_exec: a read-only server
        // that refuses `touch` but runs DROP TABLE is not read-only.
        if (config.files.readOnly) {
          throw new Error("Server is in read-only mode (FTP_READONLY=true).");
        }
        if (!config.ssh.baseDir) {
          throw new Error("SSH_BASE_DIR is not set. Commands must run inside a known directory.");
        }
        if (typeof sql !== "string" || sql.trim() === "") throw new Error("sql is required.");

        const dbName = database || config.db.name;
        if (!config.db.user) throw new Error("DB_USER is not set.");
        if (!dbName) throw new Error("No database given and DB_NAME is not set.");

        // --table gives readable output. The password is passed as MYSQL_PWD so
        // it is not in the mysql client's own argv — but the whole command is
        // executed as a single shell string, so the WRAPPING SHELL's argv does
        // contain it, and `ps aux` on the host will show it for the duration of
        // the query. On shared hosting that is a real exposure to co-tenants,
        // not a theoretical one. Writing a mode-600 --defaults-extra-file on the
        // host would close it; that is tracked separately, not done here.
        const command = `mysql --user=${shellQuote(config.db.user)} --database=${shellQuote(dbName)} --table`;
        const result = await sshRun(config.ssh, command, {
          stdin: sql.endsWith("\n") ? sql : `${sql}\n`,
          env: { MYSQL_PWD: config.db.password },
        });

        if (result.code !== 0) {
          const base = result.stderr.trim() || `mysql exited ${result.code}`;
          // A missing DB_PASSWORD is not necessarily a misconfiguration — the
          // host may supply credentials itself via ~/.my.cnf or a trusted local
          // socket (see configWarnings in config.mjs). But that warning goes to
          // stderr at startup, which is easy to miss in an MCP client, so name
          // it again here where the failure is actually visible.
          if (!config.db.password) {
            throw new Error(
              `${base} DB_PASSWORD is not set; the mysql client relied on host-side credentials ` +
                "such as ~/.my.cnf."
            );
          }
          throw new Error(base);
        }
        return text(formatResult("mysql", result, config.ssh.maxOutputBytes));
      }
    );
  },
};
