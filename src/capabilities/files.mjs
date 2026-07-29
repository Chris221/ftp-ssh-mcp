// The six transport-neutral file tools. The transport is chosen by config; when
// both profiles are configured a call may override it per-invocation, because
// the FTP account and the SSH account often see different roots.

import { stat } from "node:fs/promises";
import { z } from "zod";

import { resolveRemotePath } from "../guards.mjs";

const transportArg = z
  .enum(["ftp", "sftp"])
  .optional()
  .describe("Override the configured transport for this call. Only when both profiles are set.");

async function assertLocalFile(localPath) {
  const info = await stat(localPath).catch(() => null);
  if (!info) throw new Error(`Local path not found: ${localPath}`);
  return info;
}

export default {
  name: "files",

  isConfigured(config) {
    return Boolean(config.ftp || config.ssh);
  },

  register(ctx) {
    const { config, register, text, withClient } = ctx;

    // Reject "..", an empty path and the like BEFORE opening a connection: that
    // check needs no base directory, and a traversal attempt should not cost a
    // network round trip. The fence check — the part that needs the base — has
    // to wait, because a "~" base is only expanded once the server has reported
    // the account's login directory.
    //
    // Running this before withClient also means a call with both a ".." path
    // and an unconfigured override transport now reports the ".." error rather
    // than the missing-profile error it used to. That is deliberate: a
    // traversal attempt should not be masked by a config error.
    const precheck = (input) => resolveRemotePath(input, "");

    const assertWritable = () => {
      if (config.files.readOnly) {
        throw new Error("Server is in read-only mode (FTP_READONLY=true).");
      }
    };
    const assertDeletable = () => {
      assertWritable();
      if (!config.files.allowDelete) {
        throw new Error("Deletion is disabled. Set FTP_ALLOW_DELETE=true to enable it.");
      }
    };

    register(
      "file_list",
      {
        title: "List a remote directory",
        description:
          "List the contents of a directory on the remote host. Returns each entry's name, type and size.",
        inputSchema: {
          remotePath: z
            .string()
            .default(".")
            .describe("Remote directory to list. Relative to the profile's base directory."),
          transport: transportArg,
        },
      },
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
    );

    register(
      "file_upload",
      {
        title: "Upload a file",
        description:
          "Upload a single local file to the remote host, creating parent directories as needed.",
        inputSchema: {
          localPath: z.string().describe("Absolute path to the local file to upload."),
          remotePath: z.string().describe("Destination path on the remote host, including filename."),
          transport: transportArg,
        },
      },
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
    );

    register(
      "file_upload_dir",
      {
        title: "Upload a directory (recursive)",
        description: "Recursively upload a local directory's contents into a remote directory.",
        inputSchema: {
          localDir: z.string().describe("Absolute path to the local directory to upload."),
          remoteDir: z.string().describe("Destination directory on the remote host."),
          transport: transportArg,
        },
      },
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
    );

    register(
      "file_download",
      {
        title: "Download a file",
        description: "Download a single file from the remote host to a local path.",
        inputSchema: {
          remotePath: z.string().describe("Path to the file on the remote host."),
          localPath: z.string().describe("Absolute local destination path, including filename."),
          transport: transportArg,
        },
      },
      async ({ remotePath, localPath, transport }) => {
        precheck(remotePath);
        const remote = await withClient(async (client, baseDir) => {
          const target = resolveRemotePath(remotePath, baseDir);
          await client.download(target, localPath);
          return target;
        }, transport);
        return text(`Downloaded ${remote} -> ${localPath}`);
      }
    );

    register(
      "file_mkdir",
      {
        title: "Create a remote directory",
        description: "Create a directory, and any missing parents, on the remote host.",
        inputSchema: {
          remotePath: z.string().describe("Remote directory to create."),
          transport: transportArg,
        },
      },
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
    );

    register(
      "file_delete",
      {
        title: "Delete a remote file or directory",
        description:
          "Delete a file, or recursively delete a directory, on the remote host. " +
          "Disabled unless FTP_ALLOW_DELETE=true.",
        inputSchema: {
          remotePath: z.string().describe("Remote path to delete."),
          isDirectory: z.boolean().default(false).describe("Set true to recursively remove a directory."),
          transport: transportArg,
        },
      },
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
    );
  },
};
