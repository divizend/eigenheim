import { defineConfig } from "vitest/config"

// Repo identity and build identity, baked in at build time so the user is
// never asked to type their own repo name (spec §9.2) and the running
// bundle can state which commit it was built from (spec §10.2).
//
// Vercel sets VERCEL_GIT_REPO_OWNER / VERCEL_GIT_REPO_SLUG / VERCEL_GIT_COMMIT_SHA
// automatically for any git-connected deployment, no configuration needed.
// Locally and under test, all three are absent, so each falls back to a
// fixed value that local dev and tests can rely on.
export default defineConfig({
  define: {
    __REPO_OWNER__: JSON.stringify(process.env.VERCEL_GIT_REPO_OWNER || "test-owner"),
    __REPO_SLUG__: JSON.stringify(process.env.VERCEL_GIT_REPO_SLUG || "test-repo"),
    __BUILD_COMMIT__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA || "dev"),
  },
  test: {
    globals: true,
    // Scoped to tests/unit/** alone (vitest's own default include is broader, "**/*.test.ts"
    // anywhere in the project) so a bare `vitest run`/`npm test` -- CI's own suite, which must
    // stay green with no token present -- never discovers tests/integration/**, which talks to
    // the real GitHub API and creates/deletes real repos.
    //
    // Confirmed live that this requires a second config file, not just a different CLI
    // invocation of this one: an explicit CLI path argument (e.g. `vitest run
    // tests/integration/github.test.ts`) is still filtered through the active config's own
    // `include`/`exclude` before anything runs, exactly like a bare `vitest run` is -- it does
    // NOT bypass them. With `include` scoped as below, running that exact command reported "No
    // test files found", not the targeted file. `npm run test:integration` therefore points
    // `vitest` at a wholly separate config (vitest.integration.config.ts, via `--config`) whose
    // own `include` covers tests/integration/** instead -- see that file's own comment, and
    // tests/integration/github.test.ts's, for the EIGENHEIM_IT_TOKEN gate this file alone
    // doesn't provide.
    include: ["tests/unit/**/*.test.ts"],
  },
})
