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

test("runtime dependencies are exactly the three the spec allows", () => {
  // spec §4 — bundle size IS a security property here, so this is a guard,
  // not housekeeping. A fourth runtime dep is a spec change.
  expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["age-encryption", "node-diff3", "qrcode"])
})
