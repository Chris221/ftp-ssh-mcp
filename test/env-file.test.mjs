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

  it("falls back to cwd/.env when MCP_ENV_FILE does not exist", () => {
    writeFileSync(path.join(dir, ".env"), "A=implicit\n");
    const env = { MCP_ENV_FILE: path.join(dir, "missing.env") };
    expect(loadEnvFile(env, dir)).toBe(path.join(dir, ".env"));
    expect(env.A).toBe("implicit");
  });
});
