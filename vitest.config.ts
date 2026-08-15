import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/cache-redis/**",
      "packages/cache-azure-redis/**",
      "packages/cache-elasticache/**",
      "packages/cache-upstash-redis/**",
    ],
  },
});
