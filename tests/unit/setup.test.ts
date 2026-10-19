import "fake-indexeddb/auto"
import { Encrypter } from "age-encryption"
import { finishSetup, errorRecoveryHtml, prefillPassphrase, type FinishSetupParams } from "../../src/ui/setup"
import { LocalStore } from "../../src/store/local"
import { GithubStore } from "../../src/store/github"
import { TokenError, RepoPublicError } from "../../src/store/errors"
import { repoOwner, repoSlug } from "../../src/config"
import { checkPassphrase } from "../../src/vault/passphrase"
import { encryptVault } from "../../src/vault/crypto"
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

// ---------------------------------------------------------------------------------------------
// The two-scrypt-runs-are-never-concurrent regression test (re-review NEW-2).
//
// Spec §11 names this test specifically, and says why it has to be a test rather than the comment
// `finishSetup` already carries: the constraint "is invisible in the code and would read like a
// pointless pessimisation to a future optimiser". §5.4 is the hazard -- one logN=17 run holds
// ~128 MiB, two concurrently peak near 256 and can get a mobile tab discarded, which costs a user
// access to their own data in a project with no recovery key. tests/unit/unlock.test.ts and
// tests/unit/sync.test.ts each already pin this for their own path; this file did not, so a
// `Promise.all` of `finishSetup`'s two encrypts -- which are genuinely independent of each other,
// and sit either side of a network call, so collapsing them looks like a free win -- would have
// been caught by nothing at all.
// ---------------------------------------------------------------------------------------------

/** Peak-concurrency instrumentation, patching the shared `Encrypter.prototype.encrypt` exactly
 * the way tests/unit/unlock.test.ts's own `instrumentScrypt` patches `Decrypter.prototype.decrypt`
 * -- duplicated rather than imported, matching this project's self-contained-test-file convention;
 * see that file's version for why patching the prototype rather than the module binding is what
 * works here. The direction differs because the paths differ: `unlock` only ever decrypts,
 * `finishSetup` only ever encrypts.
 *
 * The cast is that file's reasoning verbatim, in the encrypt direction: `Encrypter.encrypt` is
 * overloaded in age-encryption's own .d.ts (plain/"text"/stream) and no single function literal
 * can satisfy all of those call signatures at once for a direct assignment, so the prototype is
 * treated as holding one untyped function and the patch forwards whatever was actually passed.
 *
 * Counts EVERY `Encrypter.encrypt`, not only the scrypt ones -- so for `finishSetup` that is
 * three: `encryptVault("")`, `wrapIdentity` (both passphrase/scrypt), and `encryptToRecipient`
 * (X25519, no KDF). Deliberate, and the same choice unlock.test.ts makes (its own count includes
 * the X25519 `token.age` decrypt): the assertion worth making is that this sequence never has two
 * age operations in flight at once, which is strictly stronger than the §5.4 minimum and needs no
 * per-call-site distinction that a future edit could get wrong. */
function instrumentEncrypt(onStart: () => void, onEnd: () => void): () => void {
  const proto = Encrypter.prototype as unknown as { encrypt: (...args: unknown[]) => Promise<unknown> }
  const original = proto.encrypt
  proto.encrypt = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    onStart()
    try {
      return await original.apply(this, args)
    } finally {
      onEnd()
    }
  }
  return () => {
    proto.encrypt = original
  }
}

test("finishSetup never runs two scrypt operations concurrently", async () => {
  const local = new LocalStore()
  let live = 0
  let peak = 0
  const restore = instrumentEncrypt(
    () => {
      peak = Math.max(peak, ++live)
    },
    () => {
      live--
    },
  )
  try {
    await finishSetup(makeParams(), local)
  } finally {
    restore()
  }
  expect(peak).toBe(1)
})

test("a concurrent finishSetup would actually be caught (instrumentation sanity check)", async () => {
  // The same self-check unlock.test.ts pairs with its own version, for the same reason: without
  // it, the test above could read back 1 because the instrumentation never observes anything
  // rather than because the code under test is genuinely sequential. Calls the real
  // `encryptVault` twice through `Promise.all`, bypassing `finishSetup` entirely, and proves peak
  // reaches 2 under the identical instrumentation.
  let live = 0
  let peak = 0
  const restore = instrumentEncrypt(
    () => {
      peak = Math.max(peak, ++live)
    },
    () => {
      live--
    },
  )
  try {
    await Promise.all([encryptVault("a", PASS), encryptVault("b", PASS)])
  } finally {
    restore()
  }
  expect(peak).toBe(2)
})

// ---------------------------------------------------------------------------------------------
// `errorRecoveryHtml` (re-review NEW-3): a pure `(err: unknown) => string`, exported from
// src/ui/setup.ts purely so it is reachable from here. Before these tests only its
// `RepoPublicError` branch was covered at all, and only indirectly, by two ~6.5s Playwright
// tests asserting on the rendered settings link -- so "fix round 1's extraction preserved
// behaviour" rested on reading the diff. That gap is also exactly how re-review NEW-1 (step 6's
// unactionable TokenError copy) escaped: observing what the TokenError branch actually emitted
// took a throwaway Playwright spec, because nothing could call the function.
// ---------------------------------------------------------------------------------------------

test("errorRecoveryHtml's RepoPublicError branch carries the message and a direct settings link", () => {
  const html = errorRecoveryHtml(new RepoPublicError("the repo must be private"))

  expect(html).toContain("the repo must be private")
  expect(html).toContain(`https://github.com/${repoOwner()}/${repoSlug()}/settings`)
  expect(html).toContain("private repository is required")
})

test("errorRecoveryHtml's TokenError branch carries the message and a create-token link", () => {
  const html = errorRecoveryHtml(new TokenError("the token cannot write to this repository"))

  expect(html).toContain("the token cannot write to this repository")
  expect(html).toContain("https://github.com/settings/personal-access-tokens/new")
  // Re-review NEW-1 / ruling R30: this copy is shared by step 3 AND step 6, so it must not
  // instruct the reader to use anything that only exists on one of them. "the steps above" named
  // step 3's walkthrough markup, which does not exist at step 6 -- where the message is shown
  // over a single "Create my vault" button and no token field at all. The way forward at step 6
  // is a real affordance (the #retoken-btn this branch's own catch appends), not copy pointing at
  // absent markup, so this phrasing must stay step-neutral.
  expect(html).not.toMatch(/steps above/i)
})

test("errorRecoveryHtml's fallback branch shows an unrecognised error's own message, with no link", () => {
  const html = errorRecoveryHtml(new Error("something else went wrong"))

  expect(html).toContain("something else went wrong")
  expect(html).not.toContain("<a ")
})

test("errorRecoveryHtml's fallback branch stringifies a thrown non-Error", () => {
  // `catch (err)` in JS binds whatever was thrown, which need not be an Error at all -- hence
  // the `err: unknown` parameter, and hence this case.
  expect(errorRecoveryHtml("a bare string was thrown")).toContain("a bare string was thrown")
})

test("errorRecoveryHtml escapes HTML-significant characters in every branch", () => {
  // This is the property that makes the two `feedback.innerHTML = errorRecoveryHtml(err)` call
  // sites safe. Every message reaching here originates from this project's own code rather than
  // from anything the user typed, so this is defence in depth rather than a closed injection
  // vector -- but "defence in depth" is only true while it actually holds, which nothing checked
  // before this test.
  // `&`, `<` and `>` only -- deliberately not quotes. Every message this function interpolates
  // lands in text-node position (inside a `<p>`), never inside an attribute value, so those three
  // are exactly the sufficient set; the only attribute interpolations in this file are a module
  // constant and build-time `define` values. A future call site that put an error message into an
  // attribute would need quote escaping too, and would be wrong to rely on this function as-is.
  const nasty = "<script>alert(1)</script> & <b>bold</b>"
  for (const err of [new RepoPublicError(nasty), new TokenError(nasty), new Error(nasty), nasty]) {
    const html = errorRecoveryHtml(err)
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<b>")
  }
})

// ---------------------------------------------------------------------------------------------
// `prefillPassphrase` (ruling R30's second half): step 4's prefill decision, extracted out of
// `renderPassphraseStep`'s DOM body so it is testable in this DOM-free suite (ruling R28's
// mandate, same reason `finishSetup` above is a separate function).
//
// Why this property is load-bearing rather than cosmetic: R30 adds a route from step 6 BACK to
// step 3, so step 4 can now be rendered a second time within one setup. Generating a fresh
// passphrase on that second render would silently invalidate the recovery sheet the user already
// printed at step 5 -- the one artifact this project has instead of a password reset.
// ---------------------------------------------------------------------------------------------

test("prefillPassphrase generates a fresh passphrase on the first visit to step 4", () => {
  const generated = prefillPassphrase("")

  expect(generated.split(" ").length).toBe(6) // spec §5.5's six diceware words
  expect(checkPassphrase(generated).ok).toBe(true)
  // Freshly generated, not a constant: two calls with no stored passphrase must differ.
  expect(prefillPassphrase("")).not.toBe(generated)
})

test("prefillPassphrase reuses an already-chosen passphrase, so a printed recovery sheet stays valid", () => {
  const alreadyChosen = "the passphrase the user already printed at step 5"

  expect(prefillPassphrase(alreadyChosen)).toBe(alreadyChosen)
})
