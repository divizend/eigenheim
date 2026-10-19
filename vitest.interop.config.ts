import { defineConfig } from "vitest/config"

// A separate config for the outbound-interop suite, exactly like vitest.integration.config.ts
// and for the same reason: vite.config.ts's own `include` is scoped to tests/unit/** so a bare
// `vitest run` -- the suite that must stay green with no network and no binaries -- never
// discovers a test that needs either. Confirmed in that file's own comment that an explicit CLI
// path argument does NOT bypass `include`, so a second config is genuinely required.
export default defineConfig({
  define: {
    __REPO_OWNER__: JSON.stringify("test-owner"),
    __REPO_SLUG__: JSON.stringify("test-repo"),
    __BUILD_COMMIT__: JSON.stringify("dev"),
  },
  test: {
    globals: true,
    include: ["tests/interop/**/*.test.ts"],
    // One real scrypt run plus a subprocess download-free decrypt; generous because this runs
    // on CI hardware whose speed this repo does not control.
    testTimeout: 120_000,
  },
})
