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

        // --table gives readable output. The password never touches the
        // command string: the whole command is executed as a single shell
        // string, so anything in it — an env prefix like MYSQL_PWD='…'
        // included — lands in the wrapping shell's argv, and `ps aux` on the
        // host shows argv to every co-tenant for the duration of the query.
        // On shared hosting that is a real exposure, not a theoretical one.
        // Instead the password rides the FIRST LINE of stdin: the remote
        // shell reads it into MYSQL_PWD (IFS= and -r keep it verbatim),
        // exports it, and mysql consumes the remaining stream as SQL. The
        // secret then exists only in process environments, which are
        // owner-readable — the same protection class as the mode-600
        // --defaults-extra-file approach, with no host file to create, clean
        // up, or leak on a dropped connection.
        //
        // A password is only deliverable this way if it has no line break of
        // its own; one that does would become SQL from its second line on.
        // Refuse it by name rather than send corrupted framing.
        const base = `mysql --user=${shellQuote(config.db.user)} --database=${shellQuote(dbName)} --table`;
        let command = base;
        let stdin = sql.endsWith("\n") ? sql : `${sql}\n`;
        if (config.db.password) {
          if (/[\r\n]/.test(config.db.password)) {
            throw new Error(
              "DB_PASSWORD contains a line break, which cannot be delivered over the " +
                "single-line stdin protocol mysql_query uses to keep it out of `ps`. " +
                "Use a password without CR/LF characters."
            );
          }
          command = `IFS= read -r MYSQL_PWD && export MYSQL_PWD && ${base}`;
          stdin = `${config.db.password}\n${stdin}`;
        }
        // When DB_PASSWORD is unset, no mechanism runs at all — exporting
        // MYSQL_PWD='' would be an empty-password auth attempt, which defeats
        // the host-side ~/.my.cnf fallback this capability documents.
        const result = await sshRun(config.ssh, command, { stdin });

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
