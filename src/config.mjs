// Resolve every setting from the environment into a validated Config.
//
// Resolution is always <PROFILE>_<KEY> -> REMOTE_<KEY> -> default. Two profiles
// exist — FTP and SSH — and either, both, or neither may be configured.

import path from "node:path";

import { expandHome, normalizeFingerprint } from "./guards.mjs";

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
    // A host key fingerprint is a public value — it is what you would paste
    // into a chat message to ask "is this the right host?" — so it inherits
    // through open(), not secret(). Kept in its configured rendering here;
    // normalizeFingerprint (guards.mjs) is the single place that parses it.
    hostFingerprint: r.open("HOST_FINGERPRINT").trim(),
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

  // Cross-profile base-directory fallback, applied after the own -> REMOTE_
  // chain, so the full precedence is: own -> REMOTE_BASE_DIR -> the other
  // profile's -> "".
  //
  // An empty baseDir means NO path confinement, and the two profiles are
  // configured independently, so the documented "required for ssh_exec" advice
  // used to leave a user with SSH_BASE_DIR set, FTP_BASE_DIR unset, and
  // completely unconfined file tools on the default (ftp) transport. Confinement
  // is stated as a guarantee in the README; borrowing the other profile's root
  // is what keeps that true. It is a fallback, never an override — a profile
  // that sets its own root always keeps it, because on cPanel the FTP account is
  // often chrooted where SSH sees the whole home.
  if (ftp && !ftp.baseDir && ssh && ssh.baseDir) ftp.baseDir = ssh.baseDir;
  if (ssh && !ssh.baseDir && ftp && ftp.baseDir) ssh.baseDir = ftp.baseDir;

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

  // A fingerprint that does not parse must not be treated as "unset": the user
  // asked for pinning, and silently connecting to an unverified host instead is
  // exactly the outcome the setting exists to prevent.
  if (config.ssh && config.ssh.hostFingerprint && !normalizeFingerprint(config.ssh.hostFingerprint)) {
    throw new Error(
      `SSH_HOST_FINGERPRINT is not a SHA-256 fingerprint: "${config.ssh.hostFingerprint}". ` +
        'Use the "SHA256:<base64>" form printed by ' +
        '"ssh-keyscan -t rsa <host> | ssh-keygen -lf -", or a 64-character hex digest.'
    );
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

/**
 * Non-fatal configuration observations, returned as plain strings.
 *
 * Pure: writes nothing, just returns warnings for the caller to print.
 *
 * A DB_USER with no resolvable password is not necessarily broken: mysql_query
 * runs the mysql client on the remote host over SSH, and that host may supply
 * credentials itself via ~/.my.cnf or a trusted local socket. Refusing to start
 * over this would reject a configuration that works, so it is a warning rather
 * than a validateConfig throw.
 */
export function configWarnings(config) {
  const warnings = [];

  // ssh2 accepts any host key unless a hostVerifier is supplied, so without a
  // pinned fingerprint the SSH side is strictly less careful than the FTPS side
  // (which rejects an unverifiable certificate by default). Say so out loud.
  if (config.ssh && !config.ssh.hostFingerprint) {
    warnings.push(
      "SSH_HOST_FINGERPRINT is not set, so the host key is accepted without verification " +
        "and a machine on the path could impersonate the host. Pin it with the output of " +
        '"ssh-keyscan -t rsa <host> | ssh-keygen -lf -".'
    );
  }

  // resolveRemotePath treats an empty baseDir as "no confinement", and the file
  // tools can be pointed at either profile per call, so any configured profile
  // without a base directory is an unconfined one. Say which transport it is.
  const servesFiles =
    !config.requestedCapabilities || config.requestedCapabilities.includes("files");
  if (servesFiles) {
    for (const [name, variable, profile] of [
      ["ftp", "FTP_BASE_DIR", config.ftp],
      ["sftp", "SSH_BASE_DIR", config.ssh],
    ]) {
      if (profile && !profile.baseDir) {
        warnings.push(
          `No base directory resolved for the ${name} transport, so path confinement is ` +
            `disabled there: the file tools can reach any path the account can. Set ` +
            `${variable} (or REMOTE_BASE_DIR).`
        );
      }
    }
  }

  if (config.db && config.db.user && !config.db.password) {
    warnings.push(
      "DB_PASSWORD is not set. The mysql client will rely on host-side credentials " +
        "such as ~/.my.cnf (fine if the remote host is configured that way, otherwise " +
        "connections will fail)."
    );
  }

  return warnings;
}
