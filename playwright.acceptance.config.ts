import { defineConfig, devices } from "@playwright/test"

// The acceptance suite (spec §14) runs against a REAL private GitHub repository with a REAL
// token, so it lives behind its own config and its own npm script — exactly like the
// integration and interop suites, and for the same reason: `npm run test:e2e` must stay
// runnable by anyone, with no credentials, forever.
export default defineConfig({
  testDir: "tests/acceptance",
  reporter: "list",
  workers: 1,
  timeout: 300_000,
  use: {
    baseURL: "http://127.0.0.1:4288",
    headless: true,
    ...devices["Desktop Chrome"],
  },
  webServer: {
    // Built with the real repo baked in, so the bundle under test is addressed at the same
    // repository the assertions then inspect on github.com.
    command: "npm run build && npm run preview -- --port 4288 --strictPort",
    url: "http://127.0.0.1:4288",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      VERCEL_GIT_REPO_OWNER: process.env.EIGENHEIM_ACCEPTANCE_OWNER ?? "",
      VERCEL_GIT_REPO_SLUG: process.env.EIGENHEIM_ACCEPTANCE_REPO ?? "",
      VERCEL_GIT_COMMIT_SHA: "acceptance",
    },
  },
})
