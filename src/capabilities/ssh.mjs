// Remote command execution. Off unless SSH_ALLOW_EXEC=true, because running
// commands is a different risk class from moving files.

import { z } from "zod";

import { validateCommand } from "../guards.mjs";
import { assertSshUsable, formatResult, sshRun } from "../ssh.mjs";

export default {
  name: "ssh",

  isConfigured(config) {
    return Boolean(config.ssh && config.ssh.allowExec && config.ssh.baseDir);
  },

  register(ctx) {
    const { config, register, text } = ctx;

    register(
      "ssh_exec",
      {
        title: "Run a command on the host",
        description:
          "Run a single command on the remote host over SSH, with SSH_BASE_DIR as the working " +
          "directory. Only programs in SSH_ALLOWED_CMDS may be invoked, and shell metacharacters " +
          "are rejected, so each call runs exactly one program — but path ARGUMENTS are not " +
          "confined: an absolute path reaches whatever the account can. Disabled unless " +
          "SSH_ALLOW_EXEC=true.",
        inputSchema: {
          command: z
            .string()
            .describe("The command to run, e.g. 'npm install --omit=dev'. No pipes, redirects or chaining."),
        },
      },
      async ({ command }) => {
        assertSshUsable(config.ssh);
        if (config.files.readOnly) {
          throw new Error("Server is in read-only mode (REMOTE_READONLY=true).");
        }
        const safe = validateCommand(command, config.ssh.allowedCommands);
        const result = await sshRun(config.ssh, safe);
        return text(formatResult(safe, result, config.ssh.maxOutputBytes));
      }
    );
  },
};
