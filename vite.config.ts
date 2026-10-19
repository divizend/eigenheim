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
    // 20s, not vitest's 5s default, and set ONCE here rather than per test (ruling R31).
    //
    // Every slow test in this suite is slow for the same single structural reason, so the
    // accommodation belongs where that reason can be stated once: every vault operation is a
    // logN=17 scrypt run (spec §5.4), and §5.3 requires that such runs "must not run
    // concurrently" -- §5.4's reason being peak memory, 128 MiB per run. So a test's wall clock
    // is essentially its scrypt-op count times the per-op cost, and no test here can be made
    // faster without either weakening what it covers or violating that ordering rule.
    //
    // Sized from measurement on this box, not from a guess. Spec §5.4's own figures (407 ms
    // encrypt / 402 ms decrypt) were taken on an idle machine; this box's CPU is a shared,
    // cgroup-throttled quota (`cat /sys/fs/cgroup/cpu.max` -> `1200000 100000`, i.e. 12 cores
    // against `nproc`'s 16, with `cpu.stat`'s nr_throttled/throttled_usec both nonzero and
    // climbing), so concurrent work from other sessions roughly doubles it. The heaviest test
    // here is tests/unit/sync.test.ts's "replay stops at the first conflict", at a MEASURED ten
    // sequential ops (see its own comment for how that count was established and where the ten
    // come from); three consecutive runs of it under real contention --
    //   npx vitest run tests/unit/sync.test.ts --reporter=verbose --testTimeout=60000
    // -- reported 6971ms, 5577ms and 7243ms, i.e. ~700-725 ms/op against §5.4's ~405 ms. 20s is
    // ~2.8x the worst of those, which is the margin a contention spike needs: at 5s this suite
    // failed 4 of 4 full runs on a clean tree (16-18 tests each, every failure "Test timed out
    // in 5000ms", no assertion errors), including tests that cost only ~2.5s unloaded.
    //
    // The accepted cost, stated so it is a decision and not an oversight: a genuinely hung test
    // now takes 20s to fail instead of 5s. For a 12-file suite that is far cheaper than a suite
    // which fails most runs for no real defect -- and a hang is caught by the wall clock of the
    // whole run either way.
    testTimeout: 20_000,
  },
})
