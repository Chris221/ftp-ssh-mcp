// Resolve every setting from the environment into a validated Config.
//
// Resolution is always <PROFILE>_<KEY> -> REMOTE_<KEY> -> default. Two profiles
// exist — FTP and SSH — and either, both, or neither may be configured.

import path from "node:path";

import { ALL, selectCapabilities } from "./capabilities/index.mjs";
import { expandHome, isHomeRelative, normalizeFingerprint } from "./guards.mjs";

const posix = path.posix;

/** A flag is on only for the exact string "true". Anything else is off. */
function flag(value) {
  return value === "true";
}

/**
 * Parse an integer setting; unset or blank means the default.
 *
 * Anything else must be a whole number in range. The old `Number(raw) || def`
 * shape turned garbage into the default silently — Number("2l") is NaN, and
 * `NaN || 21` is 21 — so a typo'd FTP_PORT connected to port 21 as if nothing
 * were wrong. An explicitly set value that cannot be honoured is an error
 * naming the variable, like every other bad setting.
 */
function integer(env, name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = String(env[name] ?? "").trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) {
    const range =
      max === Number.MAX_SAFE_INTEGER
        ? "a whole number (1 or more)"
        : `a whole number between 1 and ${max}`;
    throw new Error(
      `${name} is "${env[name]}", but must be ${range}. Unset it to use the default (${fallback}).`
    );
  }
  return Number(raw);
}

function normalizeBase(raw) {
  if (!raw) return "";
  const normalized = posix.normalize(String(raw).replace(/\\/g, "/"));
  // Keep a lone "/". Stripping it to "" makes an explicitly configured root
  // indistinguishable from an unset one, and the cross-profile fallback below
  // then lends this profile the OTHER profile's absolute path. That silently
  // breaks the common cPanel shape: an FTP account chrooted to its own home has
  // "/" as its real, correct base, and borrowing SSH's "/home/u/site" points
  // every file call at a path that does not exist inside the chroot — where the
  // server answers with an empty listing rather than an error.
  if (normalized === "/") return "/";
  return normalized.replace(/\/+$/, "");
}

/**
 * Does this config serve the file tools?
 *
 * Mirrors the gate in selectCapabilities. A base directory only has to survive
 * a bare protocol path when the file tools are actually registered.
 */
function servesFiles(config) {
  return !config.requestedCapabilities || config.requestedCapabilities.includes("files");
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
    port: integer(env, "FTP_PORT", 21, 65535),
    user,
    password: r.secret("PASSWORD"),
    baseDir: normalizeBase(r.open("BASE_DIR")),
    tlsRejectUnauthorized: env.FTP_TLS_REJECT_UNAUTHORIZED !== "false",
    timeout: integer(env, "FTP_TIMEOUT_MS", 30000),
  };
}

function resolveSsh(env) {
  const r = reader(env, "SSH");
  const host = r.open("HOST");
  const user = r.open("USER");
  if (!host && !user) return null;
  return {
    host,
    port: integer(env, "SSH_PORT", 22, 65535),
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
    timeout: integer(env, "SSH_TIMEOUT_MS", 120000),
    maxOutputBytes: integer(env, "SSH_MAX_OUTPUT", 100000),
  };
}

function resolveDb(env) {
  const r = reader(env, "DB");
  // DB_USER deliberately does NOT inherit REMOTE_USER, unlike every other
  // non-secret. mysql_query is at least as powerful as ssh_exec (arbitrary SQL
  // on a production database, plus a shell escape via the client's `\!`), and
  // ssh_exec requires an explicit SSH_ALLOW_EXEC. Inheriting the shared user
  // would let the capability switch itself on from DB_NAME alone, with no
  // equivalent opt-in anywhere. DB_PASSWORD keeps the normal secret rules.
  const user = env.DB_USER || "";
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
      // Name every secret that would satisfy the profile. Saying "SSH_PASSWORD
      // is not set" to someone setting up key auth is wrong advice on the most
      // common SSH configuration there is.
      const options =
        prefix === "SSH" ? `${prefix}_PASSWORD or ${prefix}_PRIVATE_KEY` : `${prefix}_PASSWORD`;
      throw new Error(
        `${options} is not set. ${prefix}_USER names its own identity, so its ` +
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

  // A "~" is expanded client-side, from the login directory the server reports
  // once a connection exists — realpath(".") over SFTP, PWD over FTP (see
  // effectiveBaseDir in transports/base-dir.mjs). Neither protocol expands one
  // itself: an OpenSSH server resolves "~" to a directory literally NAMED "~".
  //
  // That lookup can only answer for the account that logged in, so a NAMED home
  // — "~other/site" — has no way to be resolved and would be sent to the server
  // as a literal path. Refuse it by name here rather than let half the tools
  // quietly work: ssh_exec would still succeed, because a remote shell does
  // expand it (quoteRemotePath), which is exactly what makes the failure
  // confusing.
  if (servesFiles(config)) {
    for (const [name, variable, profile] of [
      ["ftp", "FTP_BASE_DIR", config.ftp],
      ["sftp", "SSH_BASE_DIR", config.ssh],
    ]) {
      if (profile && /^~[^/]/.test(profile.baseDir)) {
        throw new Error(
          `The ${name} base directory is "${profile.baseDir}", but only the logged-in ` +
            `account's own home can be resolved: "~" and "~/<dir>" are expanded from the ` +
            `login directory, a named home like "~user/<dir>" cannot be. Set ${variable} ` +
            `(or REMOTE_BASE_DIR) to "~/<dir>" or an absolute path such as ` +
            `"/home/<user>/<dir>".`
        );
      }
    }
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
 *
 * `quiet` drops the informational warnings and keeps the ones that describe a
 * weakened security posture. The asymmetry is the point: --quiet is set once in
 * a client's JSON config and then never looked at again, so it must not be able
 * to permanently hide an unverified host key or switched-off path confinement.
 * Those two are silenced by FIXING them, which is the only silence worth having.
 */
export function configWarnings(config, { quiet = false } = {}) {
  const warnings = [];

  /** Record a warning. `security: true` means it survives `quiet`. */
  const warn = (message, { security = false } = {}) => {
    if (quiet && !security) return;
    warnings.push(message);
  };

  // ssh2 accepts any host key unless a hostVerifier is supplied, so without a
  // pinned fingerprint the SSH side is strictly less careful than the FTPS side
  // (which rejects an unverifiable certificate by default). Say so out loud.
  if (config.ssh && !config.ssh.hostFingerprint) {
    warn(
      "SSH_HOST_FINGERPRINT is not set, so the host key is accepted without verification " +
        "and a machine on the path could impersonate the host. Pin it with the output of " +
        '"ssh-keyscan -t rsa <host> | ssh-keygen -lf -".',
      { security: true }
    );
  }

  // resolveRemotePath treats an empty baseDir as "no confinement", and the file
  // tools can be pointed at either profile per call, so any configured profile
  // without a base directory is an unconfined one. Say which transport it is.
  if (servesFiles(config)) {
    for (const [name, variable, profile] of [
      ["ftp", "FTP_BASE_DIR", config.ftp],
      ["sftp", "SSH_BASE_DIR", config.ssh],
    ]) {
      if (profile && !profile.baseDir) {
        warn(
          `No base directory resolved for the ${name} transport, so path confinement is ` +
            `disabled there: the file tools can reach any path the account can. Set ` +
            `${variable} (or REMOTE_BASE_DIR).`,
          { security: true }
        );
        continue;
      }
      // A base that is neither absolute nor "~"-relative still reaches the
      // transport — as a relative path, which the SERVER resolves against the
      // session's working directory. That is usually the login directory, so
      // "./site" often lands exactly where "~/site" would and looks correct;
      // this is a warning rather than an error for that reason. It is not the
      // same guarantee, though: the root becomes the server's opinion instead of
      // a value pinned at connect, and the ftp adapter moves the working
      // directory during an upload (see ensureDir in transports/ftp.mjs) and
      // swallows a failed restore, which would relocate every later relative
      // path in that session. A missing leading slash is the likeliest way to
      // write one by accident, and nothing else in the config would mention it.
      if (profile && !profile.baseDir.startsWith("/") && !isHomeRelative(profile.baseDir)) {
        warn(
          `The ${name} base directory "${profile.baseDir}" is relative, so the server ` +
            `resolves it against whatever directory the session starts in rather than a root ` +
            `pinned here. Set ${variable} (or REMOTE_BASE_DIR) to "~/<dir>" for the account's ` +
            `own home, or to an absolute path.`
        );
      }
    }
  }

  // DB_USER is the mysql capability's deliberate opt-in (it does not inherit
  // REMOTE_USER, precisely so the capability cannot switch itself on), but
  // the capability reaches the database over SSH — and without an SSH profile
  // it registers nothing, silently. Same shape as the exec case below.
  if (config.db && config.db.user && config.db.name && !config.ssh) {
    warn(
      "DB_USER and DB_NAME are set, but mysql_query was not registered: the mysql " +
        "capability reaches the database over SSH, so it also requires an SSH profile. " +
        "Set SSH_HOST (or REMOTE_HOST) and its credentials."
    );
  }

  // SSH_ALLOW_EXEC=true is a deliberate opt-in, but the ssh capability also
  // needs a base directory (see isConfigured in capabilities/ssh.mjs), and
  // without one it registers nothing. The MCP_CAPABILITIES check below only
  // speaks when that allowlist is set, so this is the only place the common
  // "opted into exec, forgot the base dir" configuration gets a diagnostic.
  // Informational rather than security: nothing is weaker than intended, a
  // requested tool is just absent.
  if (config.ssh && config.ssh.allowExec && !config.ssh.baseDir) {
    warn(
      'SSH_ALLOW_EXEC is "true", but ssh_exec was not registered: it also requires ' +
        "SSH_BASE_DIR (or REMOTE_BASE_DIR), so commands run inside a known directory."
    );
  }

  // An allowlist naming a capability that never activates is silent otherwise:
  // MCP_CAPABILITIES=ssh with SSH_ALLOW_EXEC unset starts a server with no
  // tools at all and says nothing about why. Unknown NAMES are a startup error
  // (see unknownCapabilities), so only known-but-inactive ones are listed here.
  if (config.requestedCapabilities) {
    const known = new Set(ALL.map((capability) => capability.name));
    const active = new Set(selectCapabilities(config).map((capability) => capability.name));
    const inactive = config.requestedCapabilities.filter(
      (name) => known.has(name) && !active.has(name)
    );
    if (inactive.length > 0) {
      warn(
        "MCP_CAPABILITIES names capabilities that are not configured, so they registered no " +
          `tools: ${inactive.join(", ")}. See the Capabilities table in the README for what ` +
          "each one requires." +
          (active.size === 0 ? " No capability is active at all: this server exposes no tools." : "")
      );
    }
  }

  if (config.db && config.db.user && !config.db.password) {
    warn(
      "DB_PASSWORD is not set. The mysql client will rely on host-side credentials " +
        "such as ~/.my.cnf (fine if the remote host is configured that way, otherwise " +
        "connections will fail)."
    );
  }

  return warnings;
}
