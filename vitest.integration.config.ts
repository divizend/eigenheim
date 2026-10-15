import { defineConfig } from "vitest/config"

// Dedicated vitest config for tests/integration/** (the real-GitHub-API suite, gated on
// EIGENHEIM_IT_TOKEN -- see that directory's own test file for the full reasoning). Deliberately
// never auto-discovered: vitest's own config search looks for an exact `vitest.config.*` filename
// before falling back to `vite.config.ts`, and this file is named differently on purpose, so it's
// only ever used when explicitly passed via `--config` (see package.json's `test:integration`
// script). `vite.config.ts` itself scopes its own `test.include` to tests/unit/** for the
// complementary reason: so a bare `vitest run`/`npm test` -- CI's own suite, which must stay green
// with no token present -- never even discovers tests/integration/github.test.ts, let alone runs
// it.
//
// `testTimeout`/`hookTimeout` are both raised well past vitest's 5s/10s defaults: a single test
// here makes dozens of real, sequential round-trips to api.github.com (create a repo, five calls
// for an orphan commit, four for a write, three more for a raw reproduction, a final read-back and
// history check, a delete -- see the test file), which comfortably exceeds 5s on real network
// latency even though none of it is slow by API-call standards individually.
//
// The `define` block below is a deliberate, intentional duplicate of vite.config.ts's own --
// matching this project's existing test-helper convention of self-contained files over shared
// imports (e.g. tests/unit/github-setup.test.ts's own makeBodyOf comment: "duplicated rather than
// imported... each file is self-contained"). It's required here, not just copied out of caution:
// src/config.ts's top-level `BUILD_COMMIT` assignment references `__BUILD_COMMIT__` at
// module-evaluation time, which Vite's transform pipeline (which vitest also drives) must
// substitute even though this suite never actually reads BUILD_COMMIT's value -- omitting this
// block fails to transform src/config.ts at all, and src/store/github.ts (which this suite
// exercises directly) imports VAULT_PATH/DATA_BRANCH from exactly that module.
export default defineConfig({
  define: {
    __REPO_OWNER__: JSON.stringify(process.env.VERCEL_GIT_REPO_OWNER || "test-owner"),
    __REPO_SLUG__: JSON.stringify(process.env.VERCEL_GIT_REPO_SLUG || "test-repo"),
    __BUILD_COMMIT__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA || "dev"),
  },
  test: {
    globals: true,
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
})
