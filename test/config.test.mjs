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

  // "/" is the correct base for an FTP account chrooted to its own home. It
  // must survive normalization as a real value: collapsing it to "" reads as
  // "unset", and the cross-profile fallback then lends this profile the other
  // one's absolute path, which does not exist inside the chroot.
  it("keeps a root base dir rather than collapsing it to empty", () => {
    const cfg = resolveConfig({ ...ftpOnly, FTP_BASE_DIR: "/" });
    expect(cfg.ftp.baseDir).toBe("/");
  });

  it("keeps a root base dir inherited from REMOTE_BASE_DIR", () => {
    const cfg = resolveConfig({ ...ftpOnly, REMOTE_BASE_DIR: "/" });
    expect(cfg.ftp.baseDir).toBe("/");
  });
});

// An empty baseDir means NO path confinement (resolveRemotePath treats it as
// "anywhere"), and the two profiles are configured independently. The README
// tells users SSH_BASE_DIR is required for ssh_exec, so setting only that one
// is the likely case — and it used to leave the default ftp transport
// completely unconfined while the README promised confinement.
describe("cross-profile base dir fallback", () => {
  const both = { ...ftpOnly, ...sshOnly };

  it("lends the SSH base dir to a profile-less FTP profile", () => {
    const cfg = resolveConfig({ ...both, SSH_BASE_DIR: "/home/u/site" });
    expect(cfg.ftp.baseDir).toBe("/home/u/site");
    expect(cfg.ssh.baseDir).toBe("/home/u/site");
  });

  it("lends the FTP base dir to a profile-less SSH profile", () => {
    const cfg = resolveConfig({ ...both, FTP_BASE_DIR: "/home/u/site" });
    expect(cfg.ssh.baseDir).toBe("/home/u/site");
    expect(cfg.ftp.baseDir).toBe("/home/u/site");
  });

  it("never overrides a profile's own base dir", () => {
    // The cPanel shape this protects: the FTP account is chrooted to the web
    // root while SSH sees the whole home. Borrowing must not flatten that.
    const cfg = resolveConfig({
      ...both,
      FTP_BASE_DIR: "/home/u/public_html",
      SSH_BASE_DIR: "/home/u",
    });
    expect(cfg.ftp.baseDir).toBe("/home/u/public_html");
    expect(cfg.ssh.baseDir).toBe("/home/u");
  });

  it("prefers REMOTE_BASE_DIR over the other profile's value", () => {
    const cfg = resolveConfig({ ...both, REMOTE_BASE_DIR: "/shared", SSH_BASE_DIR: "/home/u" });
    expect(cfg.ftp.baseDir).toBe("/shared");
  });

  it("leaves both empty when neither profile has one", () => {
    const cfg = resolveConfig(both);
    expect(cfg.ftp.baseDir).toBe("");
    expect(cfg.ssh.baseDir).toBe("");
  });

  it("cannot borrow from a profile that is not configured", () => {
    const cfg = resolveConfig({ ...ftpOnly, SSH_BASE_DIR: "/home/u" });
    expect(cfg.ssh).toBe(null);
    expect(cfg.ftp.baseDir).toBe("");
  });

  // The regression this pairs with: an FTP account chrooted to its own home is
  // configured with "/", and must NOT inherit SSH's view of the whole home.
  it("treats a root base dir as configured, so it borrows nothing", () => {
    const cfg = resolveConfig({ ...both, FTP_BASE_DIR: "/", SSH_BASE_DIR: "/home/u/site" });
    expect(cfg.ftp.baseDir).toBe("/");
    expect(cfg.ssh.baseDir).toBe("/home/u/site");
  });
});

// A "~" reaches the file tools unexpanded: there is no shell in the FTP or SFTP
// protocol, and an OpenSSH server resolves it to a directory literally named
// "~" under the home dir. ssh_exec is fine (quoteRemotePath expands it), which
// is what makes the failure confusing — so the config is refused outright.
describe("tilde base dir", () => {
  const both = { ...ftpOnly, ...sshOnly };

  it.each([
    ["~", "a lone tilde"],
    ["~/", "a trailing-slash tilde"],
    ["~/site", "a tilde-prefixed path"],
  ])('rejects %s as an ftp base dir (%s)', (value) => {
    const cfg = resolveConfig({ ...ftpOnly, FTP_BASE_DIR: value });
    expect(() => validateConfig(cfg)).toThrow(/FTP_BASE_DIR .*absolute path/s);
  });

  it("rejects a tilde ssh base dir and names SSH_BASE_DIR", () => {
    const cfg = resolveConfig({ ...sshOnly, SSH_BASE_DIR: "~/site" });
    expect(() => validateConfig(cfg)).toThrow(/SSH_BASE_DIR .*absolute path/s);
  });

  it("names the borrowed variable when the tilde is inherited", () => {
    // FTP borrows SSH's tilde, so both profiles are bad; FTP is reported first.
    const cfg = resolveConfig({ ...both, SSH_BASE_DIR: "~/site" });
    expect(cfg.ftp.baseDir).toBe("~/site");
    expect(() => validateConfig(cfg)).toThrow(/FTP_BASE_DIR/);
  });

  // ssh_exec expands "~" correctly, so a config that never registers the file
  // tools is not broken and must keep working.
  it("allows a tilde when the file tools are not served", () => {
    const cfg = resolveConfig({
      ...sshOnly,
      SSH_BASE_DIR: "~/site",
      SSH_ALLOW_EXEC: "true",
      MCP_CAPABILITIES: "ssh",
    });
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it("does not reject an absolute path containing a tilde later on", () => {
    const cfg = resolveConfig({ ...ftpOnly, FTP_BASE_DIR: "/home/u/~backup" });
    expect(() => validateConfig(cfg)).not.toThrow();
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

// SSH_HOST_FINGERPRINT is a PUBLIC value — it is what you would paste into a
// chat message to ask "is this the right host?" — so it must resolve through
// open(), inheriting REMOTE_HOST_FINGERPRINT even for a profile that names its
// own user. Routing it through secret() would silently drop the pin in exactly
// the multi-account cPanel setup the secret rule exists for, and dropping a pin
// means connecting to an unverified host.
describe("ssh host fingerprint", () => {
  const FINGERPRINT = "SHA256:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

  it("resolves SSH_HOST_FINGERPRINT", () => {
    const cfg = resolveConfig({ ...sshOnly, SSH_HOST_FINGERPRINT: FINGERPRINT });
    expect(cfg.ssh.hostFingerprint).toBe(FINGERPRINT);
  });

  it("inherits REMOTE_HOST_FINGERPRINT", () => {
    const cfg = resolveConfig({ ...sshOnly, REMOTE_HOST_FINGERPRINT: FINGERPRINT });
    expect(cfg.ssh.hostFingerprint).toBe(FINGERPRINT);
  });

  it("inherits the shared fingerprint even when the profile sets its own user", () => {
    const cfg = resolveConfig({
      REMOTE_HOST: "h",
      REMOTE_USER: "shared",
      REMOTE_HOST_FINGERPRINT: FINGERPRINT,
      SSH_USER: "cpanel",
      SSH_PASSWORD: "own",
    });
    expect(cfg.ssh.hostFingerprint).toBe(FINGERPRINT);
    // The secret rule still applies to the secret next door, unchanged.
    expect(cfg.ssh.password).toBe("own");
  });

  it("prefers the profile value over the shared one", () => {
    const cfg = resolveConfig({
      ...sshOnly,
      REMOTE_HOST_FINGERPRINT: "SHA256:ZmFrZS1zaGFyZWQtZmluZ2VycHJpbnQtdmFsdWUtMDAwMDA",
      SSH_HOST_FINGERPRINT: FINGERPRINT,
    });
    expect(cfg.ssh.hostFingerprint).toBe(FINGERPRINT);
  });

  it("is '' when unset", () => {
    expect(resolveConfig(sshOnly).ssh.hostFingerprint).toBe("");
  });

  it("is accepted by validateConfig in both renderings", () => {
    const hex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    expect(() =>
      validateConfig(resolveConfig({ ...sshOnly, SSH_HOST_FINGERPRINT: FINGERPRINT }))
    ).not.toThrow();
    expect(() =>
      validateConfig(resolveConfig({ ...sshOnly, SSH_HOST_FINGERPRINT: hex }))
    ).not.toThrow();
  });

  it("is rejected by validateConfig when it cannot be parsed", () => {
    expect(() =>
      validateConfig(resolveConfig({ ...sshOnly, SSH_HOST_FINGERPRINT: "sha256:oops" }))
    ).toThrow(/SSH_HOST_FINGERPRINT/);
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

  // mysql_query is at least as powerful as ssh_exec, which requires an explicit
  // SSH_ALLOW_EXEC. If DB_USER inherited REMOTE_USER, DB_NAME alone would
  // activate the capability and there would be no equivalent opt-in anywhere.
  it("does NOT inherit REMOTE_USER for DB_USER", () => {
    const cfg = resolveConfig({ REMOTE_USER: "shared", REMOTE_PASSWORD: "sekrit", DB_NAME: "site_db" });
    expect(cfg.db.user).toBe("");
  });

  it("uses DB_USER when it is set explicitly", () => {
    const cfg = resolveConfig({ REMOTE_USER: "shared", DB_USER: "dbuser", DB_NAME: "site_db" });
    expect(cfg.db.user).toBe("dbuser");
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

  // A key is as valid a secret as a password for SSH, and key auth is the
  // commonest SSH setup — naming only SSH_PASSWORD sends that user to fix the
  // wrong variable.
  it("names both SSH secrets when an SSH profile has neither", () => {
    // REMOTE_PASSWORD is set but not inherited, because SSH_USER names its own
    // identity — the case where the message actually gets read.
    const cfg = resolveConfig({ SSH_HOST: "h", SSH_USER: "u", REMOTE_PASSWORD: "shared" });
    expect(() => validateConfig(cfg)).toThrow(/SSH_PASSWORD or SSH_PRIVATE_KEY/);
  });

  it("accepts an SSH profile whose only secret is a private key", () => {
    const cfg = resolveConfig({ SSH_HOST: "h", SSH_USER: "u", SSH_PRIVATE_KEY: "/keys/id_rsa" });
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it("still names only FTP_PASSWORD for the ftp profile, which has no key option", () => {
    expect(() => validateConfig(resolveConfig({ FTP_HOST: "h", FTP_USER: "u" }))).toThrow(
      /^FTP_PASSWORD is not set\./
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
  const HOST_KEY_WARNING =
    "SSH_HOST_FINGERPRINT is not set, so the host key is accepted without verification " +
    "and a machine on the path could impersonate the host. Pin it with the output of " +
    '"ssh-keyscan -t rsa <host> | ssh-keygen -lf -".';

  // Each case below varies exactly one dimension, so the other warnings are
  // switched off by giving the config a base directory and (where relevant) a
  // pinned fingerprint. Asserting the WHOLE array rather than "contains" is
  // deliberate: it catches a warning that fires when it should not, which is
  // how a warning surface stops being read.
  const pinned = "SHA256:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
  const quietSsh = { ...sshOnly, SSH_BASE_DIR: "/home/u", SSH_HOST_FINGERPRINT: pinned };
  const quietFtp = { ...ftpOnly, FTP_BASE_DIR: "/home/u" };

  it("warns when an SSH profile has no pinned host key", () => {
    const cfg = resolveConfig({ ...sshOnly, SSH_BASE_DIR: "/home/u" });
    expect(configWarnings(cfg)).toStrictEqual([HOST_KEY_WARNING]);
  });

  it("does not warn about the host key once a fingerprint is pinned", () => {
    expect(configWarnings(resolveConfig(quietSsh))).toStrictEqual([]);
  });

  it("does not warn about the host key for an ftp-only config", () => {
    // No SSH profile means no SSH handshake to verify — the warning would be
    // noise, and noise is what makes real warnings get ignored.
    expect(configWarnings(resolveConfig(quietFtp))).toStrictEqual([]);
  });

  const unconfined = (name, variable) =>
    `No base directory resolved for the ${name} transport, so path confinement is ` +
    `disabled there: the file tools can reach any path the account can. Set ` +
    `${variable} (or REMOTE_BASE_DIR).`;

  it("warns when the ftp transport has no base directory", () => {
    expect(configWarnings(resolveConfig(ftpOnly))).toStrictEqual([
      unconfined("ftp", "FTP_BASE_DIR"),
    ]);
  });

  it("warns when the sftp transport has no base directory", () => {
    const cfg = resolveConfig({ ...sshOnly, SSH_HOST_FINGERPRINT: pinned });
    expect(configWarnings(cfg)).toStrictEqual([unconfined("sftp", "SSH_BASE_DIR")]);
  });

  it("does not warn once the base dir is borrowed from the other profile", () => {
    // The fix for the "SSH_BASE_DIR set, FTP_BASE_DIR unset" case: FTP is
    // confined by borrowing, so there is nothing left to warn about.
    const cfg = resolveConfig({
      ...ftpOnly,
      ...sshOnly,
      SSH_BASE_DIR: "/home/u",
      SSH_HOST_FINGERPRINT: pinned,
    });
    expect(cfg.ftp.baseDir).toBe("/home/u");
    expect(configWarnings(cfg)).toStrictEqual([]);
  });

  it("warns about both transports when neither has a base dir", () => {
    const cfg = resolveConfig({ ...ftpOnly, ...sshOnly, SSH_HOST_FINGERPRINT: pinned });
    expect(configWarnings(cfg)).toStrictEqual([
      unconfined("ftp", "FTP_BASE_DIR"),
      unconfined("sftp", "SSH_BASE_DIR"),
    ]);
  });

  it("does not warn about confinement when the files capability is not selected", () => {
    // No file tools are registered, so there is nothing unconfined to warn
    // about — and an unactionable warning trains people to ignore the rest.
    const cfg = resolveConfig({
      ...sshOnly,
      SSH_ALLOW_EXEC: "true",
      SSH_BASE_DIR: "/home/u",
      SSH_HOST_FINGERPRINT: pinned,
      MCP_CAPABILITIES: "ssh",
    });
    expect(configWarnings(cfg)).toStrictEqual([]);
  });

  // MCP_CAPABILITIES=ssh with SSH_ALLOW_EXEC unset used to start a server with
  // no tools and no diagnostic at all — indistinguishable from the client
  // failing to connect.
  describe("requested but inactive capabilities", () => {
    const inactiveWarning = (names, zero) =>
      "MCP_CAPABILITIES names capabilities that are not configured, so they registered no " +
      `tools: ${names}. See the Capabilities table in the README for what ` +
      "each one requires." +
      (zero ? " No capability is active at all: this server exposes no tools." : "");

    it("warns, and says the server has no tools, when nothing activates", () => {
      const cfg = resolveConfig({ ...quietSsh, MCP_CAPABILITIES: "ssh" });
      expect(configWarnings(cfg)).toStrictEqual([inactiveWarning("ssh", true)]);
    });

    it("warns without the no-tools sentence when something else is active", () => {
      const cfg = resolveConfig({ ...quietSsh, MCP_CAPABILITIES: "files,mysql" });
      expect(configWarnings(cfg)).toStrictEqual([inactiveWarning("mysql", false)]);
    });

    it("lists every inactive capability", () => {
      const cfg = resolveConfig({ ...quietSsh, MCP_CAPABILITIES: "ssh,mysql" });
      expect(configWarnings(cfg)).toStrictEqual([inactiveWarning("ssh, mysql", true)]);
    });

    it("does not warn when every requested capability is active", () => {
      const cfg = resolveConfig({ ...quietSsh, SSH_ALLOW_EXEC: "true", MCP_CAPABILITIES: "files,ssh" });
      expect(configWarnings(cfg)).toStrictEqual([]);
    });

    it("does not warn when MCP_CAPABILITIES is unset", () => {
      expect(configWarnings(resolveConfig(quietSsh))).toStrictEqual([]);
    });

    it("says nothing about an unknown name, which is a startup error instead", () => {
      const cfg = resolveConfig({ ...quietSsh, MCP_CAPABILITIES: "files,nope" });
      expect(configWarnings(cfg)).toStrictEqual([]);
    });
  });

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
