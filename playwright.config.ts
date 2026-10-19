import { defineConfig, devices } from "@playwright/test"

// E2E suite (spec §11's "full setup wizard against a mocked GitHub API", plus later tasks'
// editor/conflict/history/offline specs). Runs against `vite preview` -- the actual production
// build output -- rather than the dev server, so this tests what ships, not what a dev-only code
// path happens to do (same reasoning as this project's own tests/integration suite testing the
// real GitHub API rather than a simulation of it).
//
// `testDir` + Playwright's own default `testMatch` (`**/*.@(spec|test).?(c|m)js` and the .ts
// equivalents) is what discovers spec files -- no hardcoded file path here or in any npm script,
// so a second file under tests/e2e/ (Task 14 onward) is picked up with zero config changes.
//
// Port 4173 is `vite preview`'s own default (confirmed free on this box via `ss -tlnp` before
// choosing it) -- `--strictPort` so a silent auto-increment on a busy port can never desync the
// server's real port from `baseURL`/`webServer.url` below.
export default defineConfig({
  testDir: "tests/e2e",
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    ...devices["Desktop Chrome"],
  },
  webServer: {
    // Always rebuilds before serving, so a stale dist/ from an earlier task is never what the
    // suite actually exercises.
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
