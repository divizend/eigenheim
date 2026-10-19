import "fake-indexeddb/auto"
import { finishSetup, type FinishSetupParams } from "../../src/ui/setup"
import { LocalStore } from "../../src/store/local"
import { GithubStore } from "../../src/store/github"
import { generateDeviceIdentity } from "../../src/vault/identity"

// Review finding 2 on this task: `finishSetup` (src/ui/setup.ts) is step 6's real work --
// initialize the data branch, wrap the device identity and token, persist all three locally --
// extracted into a plain `async function` specifically so it is unit-testable without a browser.
// Before this extraction, the only coverage for this sequence was a ~6.5s Playwright run, which
// could not usefully assert on the LOCAL-PERSISTENCE ordering below (review finding 1) at all --
// forcing one specific IndexedDB write to fail is not something a real browser's own IndexedDB
// lets an E2E test do from the outside.

const OWNER = "o"
const REPO = "r"
const PASS = "a-sufficiently-long-setup-test-passphrase"

function repoPath(suffix: string): string {
  return `/repos/${OWNER}/${REPO}${suffix}`
}

/** Minimal GitHub API stub answering exactly the calls `initializeDataBranch` makes, all
 * successful -- this file is about `finishSetup`'s own local-persistence ordering, not
 * GithubStore's request-building, which tests/unit/github-setup.test.ts already covers
 * exhaustively. Self-contained rather than imported from that file, matching this project's own
 * convention (that file's own header comment: "each file is self-contained") -- its fixture
 * helpers are not exported. */
function succeedingFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const { pathname } = new URL(url)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    if (pathname === repoPath("")) return json({ private: true, permissions: { push: true } })
    if (pathname === repoPath("/git/blobs")) return json({ sha: "blob-sha" }, 201)
    if (pathname === repoPath("/git/trees")) return json({ sha: "tree-sha" }, 201)
    if (pathname === repoPath("/git/commits")) return json({ sha: "commit-sha" }, 201)
    if (pathname === repoPath("/git/refs")) return json({ ref: "refs/heads/data" }, 201)
    throw new Error(`setup.test.ts: unmocked GitHub call: ${pathname}`)
  }) as typeof fetch
}

function makeParams(overrides?: Partial<FinishSetupParams>): FinishSetupParams {
  return {
    passphrase: PASS,
    token: "gh-token",
    store: new GithubStore({ owner: OWNER, repo: REPO, token: "gh-token", fetch: succeedingFetch() }),
    identityPromise: generateDeviceIdentity(),
    ...overrides,
  }
}

// fake-indexeddb's `indexedDB` is one global for the whole process (same reasoning as
// tests/unit/local.test.ts's own beforeEach), so each test starts from a clean slate.
beforeEach(async () => {
  await new LocalStore().clear()
})

test("finishSetup persists the token, the cached vault and the wrapped identity, and returns the session", async () => {
  const local = new LocalStore()
  const session = await finishSetup(makeParams(), local)

  expect(session).toEqual({
    text: "",
    baseSha: "commit-sha",
    token: "gh-token",
    identity: expect.any(String),
    passphrase: PASS,
  })
  expect(await local.getToken()).not.toBeNull()
  expect(await local.getCachedVault()).toEqual({ armored: expect.any(String), sha: "commit-sha" })
  expect(await local.getWrappedIdentity()).not.toBeNull()
})

test("a failure after the identity is wrapped never leaves a wrapped identity stored, even though it failed later (review finding 1)", async () => {
  // Simulates exactly the class of failure review finding 1 named: quota, a closed tab, power
  // loss -- nothing network-related, since `initializeDataBranch` has already succeeded by this
  // point. `local.ts`'s own `putSlot` opens a fresh transaction per call, so this is a real,
  // reachable interruption point, not a contrived one.
  class FailsOnCachedVault extends LocalStore {
    override async putCachedVault(): Promise<void> {
      throw new Error("simulated: storage failed (quota, tab closed, power loss, ...)")
    }
  }
  const local = new FailsOnCachedVault()

  await expect(finishSetup(makeParams(), local)).rejects.toThrow("simulated: storage failed")

  // The one value src/main.ts's routing gate reads (`getWrappedIdentity() !== null`) must stay
  // null after ANY failure in this sequence -- otherwise this device is stuck: "already set up"
  // per that gate, but with no recovery key to fall back on (this project's own central design
  // constraint) and nothing for a future unlock view to open. A stray `token`/`cachedVault` left
  // behind by this failed attempt (putToken above already succeeded) is NOT a bug to guard
  // against here: both are inert without a matching identity, and get cleanly overwritten by
  // the next successful finishSetup call -- the gate is what must never lie, not every slot.
  expect(await local.getWrappedIdentity()).toBeNull()
})
