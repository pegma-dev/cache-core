import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/cache-redis/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    globalSetup: ["./tests/redis-server.ts"],
  },
});
