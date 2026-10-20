import { readFileSync } from "node:fs"

// Guards the facts CI depends on that nothing else would catch until a run fails -- or, worse,
// until one silently stops checking.

const CI = readFileSync(".github/workflows/ci.yml", "utf-8")
const FIXTURES = readFileSync("scripts/make-fixtures.sh", "utf-8")
const PKG = JSON.parse(readFileSync("package.json", "utf-8")) as { scripts: Record<string, string> }

test("the pinned age checksum is identical in CI and in the fixture generator", () => {
  // The literal IS the trust anchor: age's releases are signed through a transparency log, not
  // a hash either script can derive. It lives in two files, so a drifted copy would either
  // break CI on a good release or quietly accept a bad binary. This was caught for real --
  // the first version of ci.yml carried an invented value.
  const inCi = /AGE_SHA256:\s*([0-9a-f]{64})/.exec(CI)?.[1]
  const inFixtures = /linux-amd64\)\s*echo\s*"([0-9a-f]{64})"/.exec(FIXTURES)?.[1]
  expect(inCi, "no AGE_SHA256 found in .github/workflows/ci.yml").toBeDefined()
  expect(inFixtures, "no linux-amd64 checksum found in scripts/make-fixtures.sh").toBeDefined()
  expect(inCi).toBe(inFixtures)
})

test("CI pins the same age version the interop test asserts against", () => {
  const interop = readFileSync("tests/interop/age-cli.test.ts", "utf-8")
  const asserted = /toBe\("(v[0-9.]+)"\)/.exec(interop)?.[1]
  expect(asserted).toBeDefined()
  expect(CI).toContain(`age-${asserted}-linux-amd64.tar.gz`)
})

test("every npm script CI invokes actually exists", () => {
  // A renamed script would otherwise surface only as a red CI run on an unrelated commit.
  for (const name of ["test", "test:interop", "test:e2e", "build"]) {
    expect(PKG.scripts[name], `package.json has no "${name}" script, but CI runs it`).toBeDefined()
  }
  for (const name of ["npm test", "npm run test:interop", "npm run test:e2e", "npm run build"]) {
    expect(CI, `CI never runs "${name}"`).toContain(name)
  }
})

test("the bare unit suite CI runs cannot reach the token- or binary-gated suites", () => {
  // `npm test` must stay green with no token, no network and no binaries. Both opt-in suites
  // live behind their own configs precisely so a bare `vitest run` cannot discover them.
  expect(PKG.scripts.test).toBe("vitest run")
  expect(PKG.scripts["test:integration"]).toContain("--config vitest.integration.config.ts")
  expect(PKG.scripts["test:interop"]).toContain("--config vitest.interop.config.ts")

  const base = readFileSync("vite.config.ts", "utf-8")
  expect(base).toContain('include: ["tests/unit/**/*.test.ts"]')
})

test("the build-hash guard stages before comparing, so it cannot skip a NEW file", () => {
  // `git diff --quiet -- <path>` compares the working tree against the INDEX, and an untracked
  // file is in neither -- so it answers "no change" for a file that has never been committed.
  // The first version of this workflow used exactly that, and silently skipped every
  // publication: the job went green, printed "unchanged; nothing to commit", and
  // build-hash.txt was a 404 on main. Caught on the real repository, not in review.
  const commit = /Commit build-hash\.txt[\s\S]*?(?=\n  \w|$)/.exec(CI)?.[0] ?? ""
  expect(commit).toContain("git add build-hash.txt")
  expect(commit).toContain("git diff --cached --quiet")
  // The staging must come BEFORE the comparison, which is the whole point.
  expect(commit.indexOf("git add build-hash.txt")).toBeLessThan(commit.indexOf("git diff --cached --quiet"))
})

test("the build hash is published from main only, and never loops", () => {
  // A hash published from a branch would describe a bundle nobody serves; and a commit that
  // re-triggers CI would republish forever.
  expect(CI).toContain("if: github.ref == 'refs/heads/main'")
  expect(CI).toContain("[skip ci]")
})

test("CI builds with the same repo identity Vercel bakes in", () => {
  // Otherwise the published hash describes a DIFFERENT bundle than the one users run, for a
  // reason that has nothing to do with tampering, and the Settings integrity panel reports a
  // mismatch on every single deploy.
  for (const name of ["VERCEL_GIT_COMMIT_SHA", "VERCEL_GIT_REPO_OWNER", "VERCEL_GIT_REPO_SLUG"]) {
    expect(CI, `CI's build job does not set ${name}`).toContain(name)
  }
})
