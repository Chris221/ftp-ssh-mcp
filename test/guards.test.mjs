import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  buildRemoteCommand,
  expandHome,
  expandRemoteBase,
  formatFingerprint,
  isHomeRelative,
  normalizeFingerprint,
  quoteRemotePath,
  resolveRemotePath,
  shellQuote,
  validateCommand,
} from '../src/guards.mjs';

const ALLOWED = ['npm', 'node', 'mysql', 'touch', 'ls', 'cat', 'pwd'];
const validate = (command) => validateCommand(command, ALLOWED);
const resolveRemote = (input, base = '') => resolveRemotePath(input, base);

/**
 * These cover the guardrails, not the transfer logic. The allowlist only
 * inspects the first token, so it is only sound while a command cannot become
 * several commands -- most of what follows is checking exactly that.
 */

describe('validateCommand', () => {
  it('accepts a plain allowed command', () => {
    expect(validate('npm install --omit=dev')).toBe('npm install --omit=dev');
    expect(validate('touch tmp/restart.txt')).toBe('touch tmp/restart.txt');
  });

  it('trims surrounding whitespace', () => {
    expect(validate('  pwd  ')).toBe('pwd');
  });

  it('refuses a program that is not on the allowlist', () => {
    expect(() => validate('rm -rf foo')).toThrow(/not allowed/);
    expect(() => validate('curl https://example.com')).toThrow(/not allowed/);
  });

  it('refuses command chaining', () => {
    expect(() => validate('npm install; rm -rf /')).toThrow(/metacharacters/);
    expect(() => validate('npm install && rm -rf /')).toThrow(/metacharacters/);
    expect(() => validate('npm install || wget evil')).toThrow(/metacharacters/);
  });

  it('refuses pipes and redirection', () => {
    expect(() => validate('cat secrets | mail me')).toThrow(/metacharacters/);
    expect(() => validate('npm run x > /etc/passwd')).toThrow(/metacharacters/);
    expect(() => validate('mysql < /etc/shadow')).toThrow(/metacharacters/);
  });

  it('refuses command substitution', () => {
    expect(() => validate('touch $(whoami)')).toThrow(/metacharacters/);
    expect(() => validate('touch `whoami`')).toThrow(/metacharacters/);
    expect(() => validate('touch ${HOME}')).toThrow(/metacharacters/);
  });

  it('refuses newline-smuggled second commands', () => {
    expect(() => validate('npm install\nrm -rf /')).toThrow(/metacharacters/);
    expect(() => validate('npm install\r\nrm -rf /')).toThrow(/metacharacters/);
  });

  it('refuses escaping backslashes', () => {
    expect(() => validate('touch foo\\;bar')).toThrow(/metacharacters/);
  });

  it('refuses an empty command', () => {
    expect(() => validate('')).toThrow(/required/);
    expect(() => validate('   ')).toThrow(/required/);
  });

  it('does not let an allowed program name prefix a disallowed one', () => {
    // "npmx" must not pass just because "npm" is allowed.
    expect(() => validate('npmx install')).toThrow(/not allowed/);
  });
});

describe('resolveRemote', () => {
  it('rejects parent traversal', () => {
    expect(() => resolveRemote('../etc/passwd')).toThrow(/\.\./);
    expect(() => resolveRemote('a/../../b')).toThrow(/\.\./);
  });

  it('rejects an empty path', () => {
    expect(() => resolveRemote('')).toThrow(/required/);
  });

  it('normalises backslashes', () => {
    expect(resolveRemote('a\\b')).toBe('a/b');
  });
});

describe('quoteRemotePath', () => {
  // Single-quoting suppresses tilde expansion, so `cd '~/site'` fails on the
  // host. These paths come from config (SSH_BASE_DIR, SSH_ACTIVATE), which is
  // exactly where a tilde is most likely to appear.
  it('expands a leading tilde while still quoting the rest', () => {
    expect(quoteRemotePath('~/parkavebeads.com')).toBe('"$HOME"/\'parkavebeads.com\'');
  });

  it('handles a bare tilde', () => {
    expect(quoteRemotePath('~')).toBe('"$HOME"');
    expect(quoteRemotePath('~/')).toBe('"$HOME"');
  });

  it('quotes an absolute path normally', () => {
    expect(quoteRemotePath('/home/user/site')).toBe("'/home/user/site'");
  });

  it('does not treat a mid-path tilde as a home directory', () => {
    expect(quoteRemotePath('/srv/~backup')).toBe("'/srv/~backup'");
  });

  it('still neutralises injection after the tilde', () => {
    expect(quoteRemotePath("~/a'; rm -rf /; echo '")).toBe(
      '"$HOME"/\'a\'\\\'\'; rm -rf /; echo \'\\\'\'\'',
    );
  });
});

describe('buildRemoteCommand', () => {
  const activate = '~/nodevenv/ParkAveBeads.com/22/bin/activate';
  const baseDir = '~/ParkAveBeads.com';

  it('sources the venv, then changes directory, then runs the command', () => {
    expect(buildRemoteCommand({ activate, baseDir, command: 'npm install --omit=dev' })).toBe(
      '. "$HOME"/\'nodevenv/ParkAveBeads.com/22/bin/activate\' 2>/dev/null || : && ' +
        'cd "$HOME"/\'ParkAveBeads.com\' && npm install --omit=dev',
    );
  });

  it('does not abort the chain when the venv is missing', () => {
    // The venv does not exist until the cPanel Node app is created. A missing
    // one must not stop `ls` or `mysql` from working.
    const built = buildRemoteCommand({ activate, baseDir, command: 'pwd' });
    expect(built).toContain('|| :');
    expect(built).toMatch(/\|\| : && cd /);
  });

  it('omits activation entirely when none is configured', () => {
    expect(buildRemoteCommand({ baseDir, command: 'pwd' })).toBe(
      'cd "$HOME"/\'ParkAveBeads.com\' && pwd',
    );
  });

  it('requires a baseDir and a command', () => {
    expect(() => buildRemoteCommand({ baseDir: '', command: 'pwd' })).toThrow(/baseDir/);
    expect(() => buildRemoteCommand({ baseDir, command: '' })).toThrow(/command/);
  });
});

describe('expandHome', () => {
  // Local paths, not remote ones: fs.readFile does not expand `~`, so a key
  // path written as ~/.ssh/id_rsa would fail with ENOENT without this.
  it('expands a leading tilde to the home directory', () => {
    expect(expandHome('~/.ssh/id_rsa_pab')).toBe(path.join(os.homedir(), '.ssh/id_rsa_pab'));
  });

  it('handles a bare tilde', () => {
    expect(expandHome('~')).toBe(os.homedir());
  });

  it('accepts a backslash separator on Windows', () => {
    expect(expandHome('~\\.ssh\\id_rsa')).toBe(path.join(os.homedir(), '.ssh\\id_rsa'));
  });

  it('leaves absolute paths alone', () => {
    expect(expandHome('C:/Users/Chris/.ssh/id_rsa')).toBe('C:/Users/Chris/.ssh/id_rsa');
    expect(expandHome('/home/user/key')).toBe('/home/user/key');
  });

  it('does not expand a mid-path tilde', () => {
    expect(expandHome('/keys/~backup')).toBe('/keys/~backup');
  });

  it('tolerates an empty or missing value', () => {
    expect(expandHome('')).toBe('');
    expect(expandHome(undefined)).toBe('');
  });
});

describe('isHomeRelative', () => {
  it('recognises the two forms that name the login account own home', () => {
    expect(isHomeRelative('~')).toBe(true);
    expect(isHomeRelative('~/')).toBe(true);
    expect(isHomeRelative('~/site')).toBe(true);
  });

  it('rejects a named home and a tilde anywhere but the start', () => {
    expect(isHomeRelative('~other')).toBe(false);
    expect(isHomeRelative('~other/site')).toBe(false);
    expect(isHomeRelative('/home/u/~backup')).toBe(false);
    expect(isHomeRelative('')).toBe(false);
  });

  // It gates both the expansion (expandRemoteBase) and the network round trip
  // (effectiveBaseDir), and is exported, so it must answer rather than throw for
  // a value that never passed through normalizeBase. Throwing here would turn
  // "no confinement" into a TypeError at connect time.
  it('answers false for a non-string instead of throwing', () => {
    expect(isHomeRelative(undefined)).toBe(false);
    expect(isHomeRelative(null)).toBe(false);
    expect(isHomeRelative(0)).toBe(false);
    expect(isHomeRelative(false)).toBe(false);
  });
});

describe('expandRemoteBase', () => {
  it('returns an absolute base unchanged', () => {
    expect(expandRemoteBase('/home/u/site', '/home/u')).toBe('/home/u/site');
  });

  it('leaves a tilde that is not a home reference alone', () => {
    expect(expandRemoteBase('/home/u/~backup', '/home/u')).toBe('/home/u/~backup');
  });

  it('returns an empty base unchanged, so "no confinement" stays no confinement', () => {
    expect(expandRemoteBase('', '/home/u')).toBe('');
  });

  it('expands a lone tilde to the login directory', () => {
    expect(expandRemoteBase('~', '/home/u')).toBe('/home/u');
  });

  it('expands a trailing-slash tilde to the login directory', () => {
    expect(expandRemoteBase('~/', '/home/u')).toBe('/home/u');
  });

  it('expands a tilde-prefixed path', () => {
    expect(expandRemoteBase('~/site/public', '/home/u')).toBe('/home/u/site/public');
  });

  it('handles a chrooted login directory of "/"', () => {
    expect(expandRemoteBase('~/site', '/')).toBe('/site');
    expect(expandRemoteBase('~', '/')).toBe('/');
  });

  it('strips a trailing slash from the reported login directory', () => {
    expect(expandRemoteBase('~', '/home/u/')).toBe('/home/u');
    expect(expandRemoteBase('~/site', '/home/u/')).toBe('/home/u/site');
  });

  it('refuses a login directory that is not absolute', () => {
    // A relative base would silently rebase every path onto the session's
    // working directory instead of confining it.
    expect(() => expandRemoteBase('~/site', 'home/u')).toThrow(/not an absolute path/);
    expect(() => expandRemoteBase('~/site', '')).toThrow(/not an absolute path/);
  });
});

describe('shellQuote', () => {
  it('wraps a value in single quotes', () => {
    expect(shellQuote('/home/user/PAB')).toBe("'/home/user/PAB'");
  });

  it('neutralises an embedded single quote', () => {
    // The closing quote must not be escapable into a new command.
    expect(shellQuote("a'; rm -rf /; echo '")).toBe("'a'\\''; rm -rf /; echo '\\'''");
  });
});

describe("resolveRemotePath base fence", () => {
  it("allows paths within the base directory", () => {
    expect(resolveRemotePath("index.html", "/home/site/public_html")).toBe(
      "/home/site/public_html/index.html"
    );
  });

  it("rejects .. segments with transport-neutral message", () => {
    // The fence check is unreachable by design — the .. pre-check catches
    // every escaping input. This test asserts the check that genuinely fires.
    expect(() => resolveRemotePath("../outside", "/home/site/public_html")).toThrow(
      /must not contain '\.\.' segments/
    );
  });

  it("does not mention FTP_BASE_DIR in errors", () => {
    // Verify the error message has been updated to be transport-neutral
    expect(() => resolveRemotePath("../outside", "/home/site/public_html")).not.toThrow(
      /FTP_BASE_DIR/
    );
  });
});

// SSH_HOST_FINGERPRINT is compared against a digest of the offered host key, so
// everything the user might paste has to reduce to the same canonical form. The
// two renderings that matter are what `ssh-keygen -lf -` prints (SHA256:base64)
// and the hex digest other tools show.
describe("normalizeFingerprint", () => {
  // 32 bytes: 0x00..0x1f. Chosen so the hex and base64 renderings of the SAME
  // value can both be written out literally and checked against each other.
  const HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  const BASE64 = Buffer.from(HEX, "hex").toString("base64").replace(/=+$/, "");

  it("accepts the SHA256:<base64> rendering ssh-keygen prints", () => {
    expect(normalizeFingerprint(`SHA256:${BASE64}`)).toBe(HEX);
  });

  it("accepts bare base64 without the SHA256: prefix", () => {
    expect(normalizeFingerprint(BASE64)).toBe(HEX);
  });

  it("accepts base64 with padding", () => {
    expect(normalizeFingerprint(`SHA256:${Buffer.from(HEX, "hex").toString("base64")}`)).toBe(HEX);
  });

  it("accepts a bare hex digest, case-insensitively", () => {
    expect(normalizeFingerprint(HEX.toUpperCase())).toBe(HEX);
  });

  it("accepts colon-separated hex", () => {
    const colons = HEX.match(/../g).join(":");
    expect(normalizeFingerprint(colons)).toBe(HEX);
  });

  it("ignores surrounding whitespace and a lowercase prefix", () => {
    expect(normalizeFingerprint(`  sha256:${BASE64}  `)).toBe(HEX);
  });

  it("returns '' for an unset value", () => {
    expect(normalizeFingerprint("")).toBe("");
    expect(normalizeFingerprint(undefined)).toBe("");
    expect(normalizeFingerprint(null)).toBe("");
  });

  it("returns '' rather than guessing when the value is not a SHA-256 digest", () => {
    // Each of these is a plausible mistake: an MD5 fingerprint, a truncated
    // digest, the whole ssh-keygen line, and free text. None may be treated as
    // a usable pin, because the caller turns "" into a hard configuration
    // error instead of connecting unverified.
    expect(normalizeFingerprint("d0:41:1e:f7:36:2f:31:0e:1c:5a:cd:12:2a:31:d1:eb")).toBe("");
    expect(normalizeFingerprint(HEX.slice(0, 40))).toBe("");
    expect(normalizeFingerprint(`2048 SHA256:${BASE64} host (RSA)`)).toBe("");
    expect(normalizeFingerprint("not-a-fingerprint")).toBe("");
  });

  it("round-trips through formatFingerprint into the ssh-keygen rendering", () => {
    expect(formatFingerprint(HEX)).toBe(`SHA256:${BASE64}`);
    expect(normalizeFingerprint(formatFingerprint(HEX))).toBe(HEX);
  });
});
