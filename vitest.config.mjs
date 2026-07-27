import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    mockReset: true,
    setupFiles: ["./test/setup.mjs"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.mjs"],
      reporter: ["text", "lcov"],
    },
  },
});
