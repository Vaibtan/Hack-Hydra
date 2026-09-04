import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/unit/**/*.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
          testTimeout: 20_000
        }
      },
      {
        test: {
          name: "live",
          include: ["packages/*/test/live/**/*.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
          testTimeout: 900_000,
          hookTimeout: 900_000,
          fileParallelism: false
        }
      }
    ]
  }
})
