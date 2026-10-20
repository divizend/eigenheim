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
    // `--host 127.0.0.1` is load-bearing, not tidiness. `vite preview` binds `localhost` by
    // default, and on a GitHub Actions runner `localhost` resolves to ::1 first -- so the server
    // listened on IPv6 only while Playwright polled the IPv4 `127.0.0.1` in `url` below, and the
    // start check never succeeded. It surfaced as "Timed out waiting from config.webServer" with
    // no server output, which looks exactly like a slow build: raising the timeout from 120s to
    // 300s changed nothing, which is what ruled that explanation out. Binding the same literal
    // address Playwright probes removes the resolution step entirely.
    // Always rebuilds before serving, so a stale dist/ from an earlier task is never what the
    // suite actually exercises.
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    // 300s, not Playwright's 60s default and not the 120s this started at. Raised after the
    // first real CI run timed out here with no error output at all: a cold GitHub Actions
    // runner has no `.tsbuildinfo` and no Vite cache, so `tsc -b` across all three composite
    // projects plus a full bundle exceeded 120s on its own. CI additionally runs `npm run
    // build` as its own step first, which makes the incremental rebuild here fast and, more
    // usefully, makes a genuine BUILD failure show up as a build failure rather than as this
    // opaque "timed out waiting from config.webServer".
    timeout: 300_000,
  },
})
