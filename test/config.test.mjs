import { describe, expect, it } from "vitest";
import { configWarnings, resolveConfig, validateConfig } from "../src/config.mjs";

const ftpOnly = { FTP_HOST: "h", FTP_USER: "u", FTP_PASSWORD: "p" };
const sshOnly = { SSH_HOST: "h", SSH_USER: "u", SSH_PASSWORD: "p" };

describe("profile detection", () => {
  it("returns no ftp profile when nothing is set", () => {
    expect(resolveConfig({}).ftp).toBe(null);
  });

  it("builds an ftp profile from FTP_* values", () => {
    const cfg = resolveConfig(ftpOnly);
    expect(cfg.ftp).toStrictEqual({
      host: "h",
      port: 21,
      user: "u",
      password: "p",
      baseDir: "",
      tlsRejectUnauthorized: true,
      timeout: 30000,
    });
  });

  it("builds an ssh profile from SSH_* values", () => {
    const cfg = resolveConfig(sshOnly);
    expect(cfg.ssh.host).toBe("h");
    expect(cfg.ssh.port).toBe(22);
    expect(cfg.ssh.allowExec).toBe(false);
  });
});

describe("REMOTE_* fallback", () => {
  it("inherits host from REMOTE_HOST", () => {
    const cfg = resolveConfig({ REMOTE_HOST: "shared", FTP_USER: "u", FTP_PASSWORD: "p" });
    expect(cfg.ftp.host).toBe("shared");
  });

  it("prefers the profile value over the shared one", () => {
    const cfg = resolveConfig({ REMOTE_HOST: "shared", FTP_HOST: "own", FTP_USER: "u", FTP_PASSWORD: "p" });
    expect(cfg.ftp.host).toBe("own");
  });

  it("inherits base dir from REMOTE_BASE_DIR", () => {
    const cfg = resolveConfig({ ...ftpOnly, REMOTE_BASE_DIR: "/home/site" });
    expect(cfg.ftp.baseDir).toBe("/home/site");
  });

  it("normalizes a base dir, stripping the trailing slash", () => {
    const cfg = resolveConfig({ ...ftpOnly, FTP_BASE_DIR: "/home/site/" });
    expect(cfg.ftp.baseDir).toBe("/home/site");
  });
});

describe("secret-inheritance rule", () => {
  it("inherits the shared password when the profile sets no user", () => {
    const cfg = resolveConfig({ REMOTE_HOST: "h", REMOTE_USER: "shared", REMOTE_PASSWORD: "sekrit" });
    expect(cfg.ftp.user).toBe("shared");
    expect(cfg.ftp.password).toBe("sekrit");
  });

  it("does NOT inherit the shared password when the profile sets its own user", () => {
    const cfg = resolveConfig({
      REMOTE_HOST: "h",
      REMOTE_USER: "shared",
      REMOTE_PASSWORD: "sekrit",
      FTP_USER: "chrooted",
    });
    expect(cfg.ftp.user).toBe("chrooted");
    expect(cfg.ftp.password).toBe("");
  });

  it("uses the profile's own password when it sets both user and password", () => {
    const cfg = resolveConfig({
      REMOTE_HOST: "h",
      REMOTE_USER: "shared",
      REMOTE_PASSWORD: "sekrit",
      FTP_USER: "chrooted",
      FTP_PASSWORD: "own",
    });
    expect(cfg.ftp.password).toBe("own");
  });

  it("applies the same rule to the ssh profile's key and passphrase", () => {
    const cfg = resolveConfig({
      REMOTE_HOST: "h",
      REMOTE_USER: "shared",
      REMOTE_PASSWORD: "sekrit",
      SSH_USER: "cpanel",
    });
    expect(cfg.ssh.password).toBe("");
    expect(cfg.ssh.privateKeyPath).toBe("");
    expect(cfg.ssh.passphrase).toBe("");
  });

  it("inherits the shared key and passphrase when the ssh profile sets no user", () => {
    const cfg = resolveConfig({
      REMOTE_HOST: "h",
      REMOTE_USER: "shared",
      REMOTE_PRIVATE_KEY: "id_rsa_shared",
      REMOTE_PASSPHRASE: "sharedphrase",
    });
    expect(cfg.ssh.privateKeyPath).toBe("id_rsa_shared");
    expect(cfg.ssh.passphrase).toBe("sharedphrase");
  });

  it("still inherits non-secrets when the profile sets its own user", () => {
    const cfg = resolveConfig({
      REMOTE_HOST: "shared-host",
      REMOTE_BASE_DIR: "/shared",
      REMOTE_USER: "shared",
      REMOTE_PASSWORD: "sekrit",
      FTP_USER: "chrooted",
      FTP_PASSWORD: "own",
    });
    expect(cfg.ftp.host).toBe("shared-host");
    expect(cfg.ftp.baseDir).toBe("/shared");
  });
});

describe("db profile", () => {
  it("inherits the shared password when the profile sets no user", () => {
    const cfg = resolveConfig({
      REMOTE_USER: "shared",
      REMOTE_PASSWORD: "sekrit",
      DB_NAME: "site_db",
    });
    expect(cfg.db.password).toBe("sekrit");
  });

  it("does NOT inherit the shared password when the profile sets its own user", () => {
    const cfg = resolveConfig({
      REMOTE_USER: "shared",
      REMOTE_PASSWORD: "sekrit",
      DB_USER: "dbuser",
    });
    expect(cfg.db.password).toBe("");
  });

  it("uses the profile's own password when it sets both user and password", () => {
    const cfg = resolveConfig({
      REMOTE_USER: "shared",
      REMOTE_PASSWORD: "sekrit",
      DB_USER: "dbuser",
      DB_PASSWORD: "owndbpass",
    });
    expect(cfg.db.password).toBe("owndbpass");
  });

  it("is null when neither DB_USER nor DB_NAME is set", () => {
    expect(resolveConfig({}).db).toBe(null);
  });
});

describe("file transport selection", () => {
  it("defaults to ftp when only an ftp profile exists", () => {
    expect(resolveConfig(ftpOnly).files.transport).toBe("ftp");
  });

  it("defaults to sftp when only an ssh profile exists", () => {
    expect(resolveConfig(sshOnly).files.transport).toBe("sftp");
  });

  it("defaults to ftp when both exist", () => {
    expect(resolveConfig({ ...ftpOnly, ...sshOnly }).files.transport).toBe("ftp");
  });

  it("honours an explicit FILE_TRANSPORT", () => {
    const cfg = resolveConfig({ ...ftpOnly, ...sshOnly, FILE_TRANSPORT: "sftp" });
    expect(cfg.files.transport).toBe("sftp");
  });
});

describe("flags", () => {
  it("defaults allowDelete and readOnly to false and allowExec to false", () => {
    const cfg = resolveConfig({ ...ftpOnly, ...sshOnly });
    expect(cfg.files.allowDelete).toBe(false);
    expect(cfg.files.readOnly).toBe(false);
    expect(cfg.ssh.allowExec).toBe(false);
  });

  it("enables each flag only on the exact string 'true'", () => {
    const cfg = resolveConfig({ ...ftpOnly, ...sshOnly, FTP_ALLOW_DELETE: "TRUE", SSH_ALLOW_EXEC: "1" });
    expect(cfg.files.allowDelete).toBe(false);
    expect(cfg.ssh.allowExec).toBe(false);
  });

  it("parses MCP_CAPABILITIES into a trimmed list", () => {
    const cfg = resolveConfig({ ...ftpOnly, MCP_CAPABILITIES: "files, ssh" });
    expect(cfg.requestedCapabilities).toStrictEqual(["files", "ssh"]);
  });

  it("leaves requestedCapabilities null when unset", () => {
    expect(resolveConfig(ftpOnly).requestedCapabilities).toBe(null);
  });
});

describe("ftp security mode", () => {
  it("defaults to ftps", () => {
    expect(resolveConfig(ftpOnly).ftpSecurity).toBe("ftps");
  });

  it("lowercases an explicit value", () => {
    expect(resolveConfig({ ...ftpOnly, FTP_SECURITY: "FTP" }).ftpSecurity).toBe("ftp");
  });

  it("rejects an unknown mode", () => {
    expect(() => validateConfig(resolveConfig({ ...ftpOnly, FTP_SECURITY: "sftp" }))).toThrow(
      /FTP_SECURITY/
    );
  });
});

describe("validateConfig", () => {
  it("rejects a config with no profile, naming the variables", () => {
    expect(() => validateConfig(resolveConfig({}))).toThrow(/REMOTE_HOST/);
  });

  it("accepts an ftp-only config", () => {
    expect(() => validateConfig(resolveConfig(ftpOnly))).not.toThrow();
  });

  it("rejects a profile with a user but no secret, naming the profile", () => {
    expect(() => validateConfig(resolveConfig({ FTP_HOST: "h", FTP_USER: "u" }))).toThrow(
      /FTP_PASSWORD/
    );
  });

  it("rejects an unknown FILE_TRANSPORT", () => {
    expect(() => validateConfig(resolveConfig({ ...ftpOnly, FILE_TRANSPORT: "scp" }))).toThrow(
      /FILE_TRANSPORT/
    );
  });

  it("rejects FILE_TRANSPORT naming an unconfigured profile", () => {
    expect(() => validateConfig(resolveConfig({ ...ftpOnly, FILE_TRANSPORT: "sftp" }))).toThrow(
      /SSH_HOST/
    );
  });
});

describe("configWarnings", () => {
  it("warns when DB_USER is set but no password resolves", () => {
    const cfg = resolveConfig({ DB_USER: "dbuser", DB_NAME: "site_db" });
    const warnings = configWarnings(cfg);
    expect(warnings).toStrictEqual([
      'DB_PASSWORD is not set. The mysql client will rely on host-side credentials ' +
        "such as ~/.my.cnf (fine if the remote host is configured that way, otherwise " +
        "connections will fail).",
    ]);
  });

  it("does not warn when a password is set", () => {
    const cfg = resolveConfig({ DB_USER: "dbuser", DB_PASSWORD: "own", DB_NAME: "site_db" });
    expect(configWarnings(cfg)).toStrictEqual([]);
  });

  it("does not warn when db is null", () => {
    expect(configWarnings(resolveConfig({}))).toStrictEqual([]);
  });

  it("does not warn when DB_USER is unset", () => {
    const cfg = resolveConfig({ DB_NAME: "site_db" });
    expect(configWarnings(cfg)).toStrictEqual([]);
  });
});
