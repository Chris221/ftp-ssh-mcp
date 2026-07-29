import { describe, expect, it } from "vitest";

import { effectiveBaseDir } from "../../src/transports/base-dir.mjs";

describe("effectiveBaseDir", () => {
  it("returns an absolute base dir unchanged without calling lookup", async () => {
    const lookup = () => {
      throw new Error("should not be called");
    };
    const seen = await effectiveBaseDir("/home/tester/site", "SSH_BASE_DIR", lookup);
    expect(seen).toBe("/home/tester/site");
  });

  it("returns an empty base dir unchanged without calling lookup, so 'no confinement' stays no confinement", async () => {
    const lookup = () => {
      throw new Error("should not be called");
    };
    const seen = await effectiveBaseDir("", "SSH_BASE_DIR", lookup);
    expect(seen).toBe("");
  });

  it("expands a tilde base dir using the looked-up login directory", async () => {
    const lookup = async () => "/home/tester";
    const seen = await effectiveBaseDir("~/site", "SSH_BASE_DIR", lookup);
    expect(seen).toBe("/home/tester/site");
  });

  it("names the variable and preserves the reason when the lookup itself fails", async () => {
    const lookup = async () => {
      throw new Error("connection reset");
    };
    await expect(effectiveBaseDir("~/site", "SSH_BASE_DIR", lookup)).rejects.toThrow(
      /SSH_BASE_DIR/
    );
    await expect(effectiveBaseDir("~/site", "SSH_BASE_DIR", lookup)).rejects.toThrow(
      /connection reset/
    );
  });

  // Task 1's expandRemoteBase throws when the reported login directory is not
  // absolute, but it is deliberately variable-agnostic and cannot name what the
  // user has to change. effectiveBaseDir knows the variable, so it must add
  // that context rather than let expandRemoteBase's bare message pass through.
  it("names the variable when expandRemoteBase refuses a non-absolute login directory", async () => {
    const lookup = async () => "not-absolute";
    await expect(effectiveBaseDir("~/site", "FTP_BASE_DIR", lookup)).rejects.toThrow(
      /FTP_BASE_DIR/
    );
    // The underlying reason from expandRemoteBase must still be present, not
    // swallowed in favor of a generic wrapper message.
    await expect(effectiveBaseDir("~/site", "FTP_BASE_DIR", lookup)).rejects.toThrow(
      /not an absolute path/
    );
  });
});
