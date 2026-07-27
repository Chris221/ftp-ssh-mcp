// Query the host's MySQL database by piping SQL to the mysql client over SSH.
//
// It needs an SSH profile because that is how the client is reached, but it is
// gated by its own DB_* configuration rather than SSH_ALLOW_EXEC: enabling
// database access should not require enabling arbitrary shell commands.

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
        if (!config.ssh.baseDir) {
          throw new Error("SSH_BASE_DIR is not set. Commands must run inside a known directory.");
        }
        if (typeof sql !== "string" || sql.trim() === "") throw new Error("sql is required.");

        const dbName = database || config.db.name;
        if (!config.db.user) throw new Error("DB_USER is not set.");
        if (!dbName) throw new Error("No database given and DB_NAME is not set.");

        // --table gives readable output. The password goes through the
        // environment rather than argv so it never appears in the host's
        // process list.
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
