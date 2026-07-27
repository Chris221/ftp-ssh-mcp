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
