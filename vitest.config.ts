import { defineConfig } from "vitest/config"

/**
 * Two projects, on purpose:
 *
 *  - `unit` — pure, hermetic, no network. Runs anywhere.
 *  - `live` — integration against the HydraDB Docker node on 127.0.0.1:8443.
 *             These are the probe suite: they encode the engine behaviours the
 *             design leans on, so they must hit the real engine.
 */
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
          // The live node is a single shared resource; parallel files would
          // fight over the same key space.
          fileParallelism: false
        }
      }
    ]
  }
})
