// Guards against server.json drifting from package.json. npm version bumps
// package.json (and the lockfile) but has no idea server.json exists, so
// nothing else would catch a release that moves one and not the other. MCP
// registries validate that the referenced npm package version exists, so a
// stale manifest fails at publish time in a way that's annoying to diagnose —
// better to fail the suite instead.
//
// Both files are read from disk with readFileSync + JSON.parse, rather than
// imported, so the test reflects what is actually committed rather than
// whatever a bundler or import cache might have.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "../src/config.mjs";
import { VERSION, createServer, selftestSummary } from "../src/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

describe("server.json / package.json version sync", () => {
  const pkg = readJson("package.json");
  const manifest = readJson("server.json");

  it("has a top-level version matching package.json", () => {
    expect(manifest.version).toStrictEqual(pkg.version);
  });

  it("has a packages[0].version matching package.json", () => {
    expect(manifest.packages[0].version).toStrictEqual(pkg.version);
  });

  it("has a packages[0].identifier matching package.json's name", () => {
    expect(manifest.packages[0].identifier).toStrictEqual(pkg.name);
  });
});

// The version the SERVER reports is a third copy of the same number, and it
// used to be a hardcoded "1.0.0" sitting next to manifests that said 0.0.0.
// Nothing tied it to the other two, so MCP's serverInfo.version and the
// --selftest banner would have been wrong from the first release onward. These
// assertions extend the same pin to it.
describe("server version / package.json sync", () => {
  const pkg = readJson("package.json");

  it("reports package.json's version", () => {
    expect(VERSION).toStrictEqual(pkg.version);
  });

  it("puts that version in the selftest banner", () => {
    const config = resolveConfig({ FTP_HOST: "h", FTP_USER: "u", FTP_PASSWORD: "p" });
    const { toolNames } = createServer(config);
    expect(selftestSummary(config, toolNames, null)).toContain(
      `ftp-ssh-mcp ${pkg.version} selftest OK`
    );
  });
});
