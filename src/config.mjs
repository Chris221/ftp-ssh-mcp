// Resolve every setting from the environment into a validated Config.
//
// Resolution is always <PROFILE>_<KEY> -> REMOTE_<KEY> -> default. Two profiles
// exist — FTP and SSH — and either, both, or neither may be configured.

import path from "node:path";

import { expandHome } from "./guards.mjs";

const posix = path.posix;

/** A flag is on only for the exact string "true". Anything else is off. */
function flag(value) {
  return value === "true";
}

function normalizeBase(raw) {
  if (!raw) return "";
  return posix.normalize(String(raw).replace(/\\/g, "/")).replace(/\/+$/, "");
}

/**
 * Build a reader for one profile.
 *
 * Non-secrets fall back to REMOTE_* freely. Secrets fall back ONLY when the
 * profile does not name its own user: setting a profile's user declares a
 * distinct identity, and inheriting a shared password would then send the wrong
 * secret on every connect. On cPanel that means repeated auth failures and
 * eventually a cPHulk lockout.
 */
function reader(env, prefix) {
  const ownUser = Boolean(env[`${prefix}_USER`]);
  return {
    ownUser,
    /** Non-secret: profile value, else shared value, else "". */
    open(key) {
      return env[`${prefix}_${key}`] || env[`REMOTE_${key}`] || "";
    },
    /** Secret: profile value, else shared value only when no own user. */
    secret(key) {
      const own = env[`${prefix}_${key}`];
      if (own) return own;
      return ownUser ? "" : env[`REMOTE_${key}`] || "";
    },
  };
}

function resolveFtp(env) {
  const r = reader(env, "FTP");
  const host = r.open("HOST");
  const user = r.open("USER");
  if (!host && !user) return null;
  return {
    host,
    port: Number(env.FTP_PORT) || 21,
    user,
    password: r.secret("PASSWORD"),
    baseDir: normalizeBase(r.open("BASE_DIR")),
    tlsRejectUnauthorized: env.FTP_TLS_REJECT_UNAUTHORIZED !== "false",
    timeout: Number(env.FTP_TIMEOUT_MS) || 30000,
  };
}

function resolveSsh(env) {
  const r = reader(env, "SSH");
  const host = r.open("HOST");
  const user = r.open("USER");
  if (!host && !user) return null;
  return {
    host,
    port: Number(env.SSH_PORT) || 22,
    user,
    password: r.secret("PASSWORD"),
    privateKeyPath: expandHome(r.secret("PRIVATE_KEY")),
    passphrase: r.secret("PASSPHRASE"),
    baseDir: normalizeBase(r.open("BASE_DIR")),
    activate: env.SSH_ACTIVATE || "",
    allowExec: flag(env.SSH_ALLOW_EXEC),
    allowedCommands: (env.SSH_ALLOWED_CMDS || "npm,node,mysql,mysqldump,touch,ls,cat,tail,head,df,du,pwd")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    timeout: Number(env.SSH_TIMEOUT_MS) || 120000,
    maxOutputBytes: Number(env.SSH_MAX_OUTPUT) || 100000,
  };
}

function resolveDb(env) {
  const r = reader(env, "DB");
  const user = r.open("USER");
  const name = env.DB_NAME || "";
  if (!user && !name) return null;
  return { user, password: r.secret("PASSWORD"), name };
}

export function resolveConfig(env = process.env) {
  const ftp = resolveFtp(env);
  const ssh = resolveSsh(env);

  const requested = env.MCP_CAPABILITIES
    ? env.MCP_CAPABILITIES.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const transport = env.FILE_TRANSPORT || (ftp ? "ftp" : ssh ? "sftp" : "ftp");

  return {
    ftp,
    ssh,
    db: resolveDb(env),
    files: {
      transport,
      readOnly: flag(env.FTP_READONLY),
      allowDelete: flag(env.FTP_ALLOW_DELETE),
    },
    // basic-ftp's TLS mode. Replaces the old FTP_PROTOCOL, which conflated the
    // TLS setting with transport selection by also accepting "sftp".
    ftpSecurity: (env.FTP_SECURITY || "ftps").toLowerCase(),
    requestedCapabilities: requested,
  };
}

/** Throw with the name of the variable that needs setting. */
export function validateConfig(config) {
  if (!config.ftp && !config.ssh) {
    throw new Error(
      "No connection profile configured. Set REMOTE_HOST and REMOTE_USER (plus a secret), " +
        "or the FTP_* / SSH_* equivalents."
    );
  }

  for (const [prefix, profile] of [["FTP", config.ftp], ["SSH", config.ssh]]) {
    if (!profile) continue;
    if (!profile.host) throw new Error(`${prefix}_HOST (or REMOTE_HOST) is not set.`);
    if (!profile.user) throw new Error(`${prefix}_USER (or REMOTE_USER) is not set.`);
    const hasSecret = profile.password || profile.privateKeyPath;
    if (!hasSecret) {
      throw new Error(
        `${prefix}_PASSWORD is not set. ${prefix}_USER names its own identity, so its ` +
          `secret must be set explicitly rather than inherited from REMOTE_PASSWORD.`
      );
    }
  }

  const { transport } = config.files;
  if (transport !== "ftp" && transport !== "sftp") {
    throw new Error(`Invalid FILE_TRANSPORT "${transport}". Use "ftp" or "sftp".`);
  }
  if (transport === "ftp" && !config.ftp) {
    throw new Error('FILE_TRANSPORT is "ftp" but no FTP profile is configured. Set FTP_HOST.');
  }
  if (transport === "sftp" && !config.ssh) {
    throw new Error('FILE_TRANSPORT is "sftp" but no SSH profile is configured. Set SSH_HOST.');
  }

  const modes = ["ftps", "ftp", "ftps-implicit"];
  if (!modes.includes(config.ftpSecurity)) {
    throw new Error(`Invalid FTP_SECURITY "${config.ftpSecurity}". Use one of: ${modes.join(", ")}.`);
  }
}
