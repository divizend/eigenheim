import { resolve } from "node:path"
import { loadConfigFromFile } from "vite"
import { SCRYPT_LOG_N, VAULT_PATH, DATA_BRANCH, repoOwner, repoSlug, BUILD_COMMIT } from "../../src/config"
import pkg from "../../package.json" with { type: "json" }

test("scrypt work factor is 17, not age's default of 18", () => {
  expect(SCRYPT_LOG_N).toBe(17)          // spec §5.4 — memory-bound on phones
})
test("paths match the spec's repo layout", () => {
  expect(VAULT_PATH).toBe("vault.age")
  expect(DATA_BRANCH).toBe("data")
})
test("repo identity comes from the build, not from user input", () => {
  expect(repoOwner()).toBe("test-owner")  // injected by vite define in test env
  expect(repoSlug()).toBe("test-repo")
})
test("build commit is injected at build time, defaulting to dev when unset", () => {
  // BUILD_HASH as specced is impossible (a bundle can't contain its own hash,
  // see the task-1 ruling) — BUILD_COMMIT is the known-pre-build git SHA instead.
  expect(BUILD_COMMIT).toBe("dev")        // no VERCEL_GIT_COMMIT_SHA in the test env
})

test("the define substitution bakes in real env values, not just the fallback", async () => {
  // The unit tests above only ever see the unset/fallback branch (no
  // VERCEL_GIT_* vars in the test env). This drives vite.config.ts's own
  // `define` block a second time with those vars forced to known values,
  // proving the substitution actually reads them rather than always
  // falling back — the branch a Vercel build genuinely takes.
  const keys = ["VERCEL_GIT_REPO_OWNER", "VERCEL_GIT_REPO_SLUG", "VERCEL_GIT_COMMIT_SHA"] as const
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]])) as Record<(typeof keys)[number], string | undefined>
  process.env.VERCEL_GIT_REPO_OWNER = "probe-owner"
  process.env.VERCEL_GIT_REPO_SLUG = "probe-repo"
  process.env.VERCEL_GIT_COMMIT_SHA = "probe1234"
  try {
    const result = await loadConfigFromFile(
      { command: "build", mode: "production" },
      resolve(import.meta.dirname, "../../vite.config.ts"),
    )
    expect(result?.config.define).toEqual({
      __REPO_OWNER__: '"probe-owner"',
      __REPO_SLUG__: '"probe-repo"',
      __BUILD_COMMIT__: '"probe1234"',
    })
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
})

test("runtime dependencies are exactly the three the spec allows", () => {
  // spec §4 — bundle size IS a security property here, so this is a guard,
  // not housekeeping. A fourth runtime dep is a spec change.
  expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["age-encryption", "node-diff3", "qrcode"])
})
