import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadEnvFile } from "../src/env-file.mjs";

let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "envfile-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadEnvFile", () => {
  it("returns null when no .env exists", () => {
    const env = {};
    expect(loadEnvFile(env, dir)).toBe(null);
    expect(env).toStrictEqual({});
  });

  it("loads KEY=value pairs from cwd/.env", () => {
    writeFileSync(path.join(dir, ".env"), "REMOTE_HOST=example.com\nFTP_PORT=21\n");
    const env = {};
    expect(loadEnvFile(env, dir)).toBe(path.join(dir, ".env"));
    expect(env).toStrictEqual({ REMOTE_HOST: "example.com", FTP_PORT: "21" });
  });

  it("strips surrounding single or double quotes", () => {
    writeFileSync(path.join(dir, ".env"), `A="quoted"\nB='single'\n`);
    const env = {};
    loadEnvFile(env, dir);
    expect(env).toStrictEqual({ A: "quoted", B: "single" });
  });

  it("ignores comments and blank lines", () => {
    writeFileSync(path.join(dir, ".env"), "# a comment\n\nA=1\n");
    const env = {};
    loadEnvFile(env, dir);
    expect(env).toStrictEqual({ A: "1" });
  });

  it("does not overwrite a non-empty existing value", () => {
    writeFileSync(path.join(dir, ".env"), "A=fromfile\n");
    const env = { A: "fromenv" };
    loadEnvFile(env, dir);
    expect(env.A).toBe("fromenv");
  });

  it("treats an empty existing value as absent", () => {
    writeFileSync(path.join(dir, ".env"), "A=fromfile\n");
    const env = { A: "" };
    loadEnvFile(env, dir);
    expect(env.A).toBe("fromfile");
  });

  it("prefers MCP_ENV_FILE over cwd/.env", () => {
    const explicit = path.join(dir, "custom.env");
    writeFileSync(explicit, "A=explicit\n");
    writeFileSync(path.join(dir, ".env"), "A=implicit\n");
    const env = { MCP_ENV_FILE: explicit };
    expect(loadEnvFile(env, dir)).toBe(explicit);
    expect(env.A).toBe("explicit");
  });

  it("throws when MCP_ENV_FILE names a file that cannot be read", () => {
    // The user explicitly pointed at a file. Falling back to cwd/.env (or to
    // nothing) loads DIFFERENT credentials than the ones they asked for, and
    // says nothing — a typo'd path must fail the startup loudly instead.
    writeFileSync(path.join(dir, ".env"), "A=implicit\n");
    const env = { MCP_ENV_FILE: path.join(dir, "missing.env") };

    expect(() => loadEnvFile(env, dir)).toThrow(/MCP_ENV_FILE/);
    expect(() => loadEnvFile(env, dir)).toThrow(/missing\.env/);
    // And nothing was loaded from the fallback .env behind the user's back.
    expect(env.A).toBeUndefined();
  });

  it("resolves a relative MCP_ENV_FILE against cwd, like the .env fallback", () => {
    writeFileSync(path.join(dir, "custom.env"), "A=relative\n");
    const env = { MCP_ENV_FILE: "custom.env" };

    expect(loadEnvFile(env, dir)).toBe(path.join(dir, "custom.env"));
    expect(env.A).toBe("relative");
  });

  it("preserves values containing = characters unquoted", () => {
    writeFileSync(
      path.join(dir, ".env"),
      "TOKEN=YWJjZGVmZw==\nURL=https://h/p?a=1&b=2\n"
    );
    const env = {};
    loadEnvFile(env, dir);
    expect(env).toStrictEqual({
      TOKEN: "YWJjZGVmZw==",
      URL: "https://h/p?a=1&b=2",
    });
  });

  it("strips quotes from values containing = characters", () => {
    writeFileSync(path.join(dir, ".env"), `Q="a=b=c"\n`);
    const env = {};
    loadEnvFile(env, dir);
    expect(env).toStrictEqual({ Q: "a=b=c" });
  });
});

// A password is the value most likely to contain a quote or significant
// whitespace, and the one where quietly changing it costs the most: the wrong
// secret goes out on every connect, and on cPanel enough failures trip cPHulk
// and lock the account out at the host level. So the parser must either return
// the value exactly or leave it visibly untouched — never half-strip it.
describe("loadEnvFile quoting", () => {
  const load = (contents) => {
    writeFileSync(path.join(dir, ".env"), contents);
    const env = {};
    loadEnvFile(env, dir);
    return env;
  };

  it("strips matching double quotes", () => {
    expect(load(`A="hunter2"\n`)).toStrictEqual({ A: "hunter2" });
  });

  it("strips matching single quotes", () => {
    expect(load(`A='hunter2'\n`)).toStrictEqual({ A: "hunter2" });
  });

  it("leaves mismatched quotes intact rather than stripping them", () => {
    // The regression: /^["'](.*)["']$/ accepted these and returned `foo`,
    // silently turning a password of `"foo'` into a different password.
    expect(load(`A="foo'\n`)).toStrictEqual({ A: `"foo'` });
    expect(load(`B='foo"\n`)).toStrictEqual({ B: `'foo"` });
  });

  it("leaves an unterminated quote intact", () => {
    expect(load(`A="foo\n`)).toStrictEqual({ A: `"foo` });
    expect(load(`B=foo"\n`)).toStrictEqual({ B: `foo"` });
  });

  it("preserves leading and trailing spaces inside quotes", () => {
    expect(load(`A="  spaced  "\n`)).toStrictEqual({ A: "  spaced  " });
    expect(load(`B='\tpadded\t'\n`)).toStrictEqual({ B: "\tpadded\t" });
  });

  it("still trims an unquoted value", () => {
    expect(load("A=  spaced  \n")).toStrictEqual({ A: "spaced" });
  });

  it("keeps quote characters that are inside the value", () => {
    expect(load(`A="say \\"hi\\""\n`)).toStrictEqual({ A: `say \\"hi\\"` });
    expect(load(`B=it's-fine\n`)).toStrictEqual({ B: "it's-fine" });
  });

  it("treats a lone quote character as the value", () => {
    expect(load(`A="\n`)).toStrictEqual({ A: `"` });
  });

  it("resolves empty quotes to an empty string", () => {
    expect(load(`A=""\n`)).toStrictEqual({ A: "" });
  });
});
