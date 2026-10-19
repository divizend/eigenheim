import { existsSync, readFileSync } from "node:fs"

// The README is the public template's front door and the only documentation a non-technical
// user reads before trusting this app with something. These are the four facts it must carry.

const README = readFileSync("README.md", "utf-8")

test("the Deploy button points at a real clone URL for this repository", () => {
  expect(README).toContain("https://vercel.com/new/clone?repository-url=")
  // Not a placeholder: the clone URL must name an actual GitHub repository, or the one-click
  // deploy this project promises lands on an error page.
  const clone = /repository-url=(\S+?)\)/.exec(README)?.[1]
  expect(clone).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/)
})

test("every screenshot the README references exists on disk", () => {
  // A missing image is invisible in review -- GitHub renders a small broken icon -- and fatal
  // to the audience this page is written for.
  const refs = [...README.matchAll(/!\[[^\]]*\]\((docs\/onboarding\/[^)]+)\)/g)].map((m) => m[1])
  expect(refs.length, "the README references no screenshots at all").toBeGreaterThan(0)
  for (const ref of refs) {
    expect(existsSync(ref), `README references ${ref}, which does not exist`).toBe(true)
  }
})

test("the README states the trust model including what is NOT protected", () => {
  // spec §3 and §10: the host serving hostile JavaScript is a real limitation of this design,
  // and burying it would make every other claim on this page less trustworthy, not more.
  expect(README).toMatch(/hostile|malicious code|first load/i)
  expect(README).toMatch(/not\s+protected/i)
  // And the two mitigations that exist, so the limitation is not stated as a shrug.
  expect(README).toMatch(/never activates a new build without asking/i)
  expect(README).toMatch(/SHA-256 of the bundle actually running/i)
})

test("the README gives the offline recovery command", () => {
  expect(README).toContain("age -d vault.age")
})

test("the README says plainly that there is no recovery", () => {
  // The single most consequential fact about this design. A user who learns it after losing a
  // passphrase has been misled, however accurate everything else was.
  expect(README).toMatch(/no password reset/i)
  expect(README).toMatch(/no recovery key/i)
})

test("the README does not promise a second factor this design cannot provide", () => {
  expect(README).not.toMatch(/two-factor|2FA enabled|multi-factor authentication protects/i)
})

test("the opt-in suites are documented with the env var each one needs", () => {
  // Both exist precisely so `npm test` needs no token, no network and no binaries; a reader who
  // cannot find out how to run them will reasonably assume they do not exist.
  expect(README).toContain("EIGENHEIM_IT_TOKEN")
  expect(README).toContain("EIGENHEIM_AGE_BIN")
})
