import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.{ts,tsx}",
      "plugins/*/tests/**/*.test.{ts,tsx}",
      "workers/*/tests/**/*.test.{ts,tsx}",
    ],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
  },
});
