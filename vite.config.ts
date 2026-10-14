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
  },
})
