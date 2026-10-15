import "fake-indexeddb/auto"
import { Decrypter } from "age-encryption"
import { unlock, type Stage } from "../../src/session/unlock"
import { LocalStore } from "../../src/store/local"
import { GithubStore } from "../../src/store/github"
import { TokenError } from "../../src/store/errors"
import { encryptVault, decryptVault, encryptToRecipient, WrongPassphraseError } from "../../src/vault/crypto"
import { generateDeviceIdentity, wrapIdentity } from "../../src/vault/identity"
import { VAULT_PATH, DATA_BRANCH } from "../../src/config"

const PASS = "a-sufficiently-long-unlock-test-passphrase"
const OWNER = "o"
const REPO = "r"

// fake-indexeddb's `indexedDB` is one global for the whole process (same reasoning as
// tests/unit/local.test.ts's own beforeEach) -- without resetting it, one test's seeded
// cachedVault/wrappedIdentity/token would leak into the next. This matters more here than in
// local.test.ts: a leaked cachedVault would silently flip which of unlock's two branches a
// later test actually exercises.
beforeEach(async () => {
  await new LocalStore().clear()
})

// ---------------------------------------------------------------------------
// GitHub fixtures for the "fetch" stage -- same recordingFetch/fixture-map shape as
// tests/unit/github-read.test.ts, trimmed to just readHead's own 4-request walk (ref -> commit
// -> tree -> blob) and parameterised on the armored text so the "first unlock" tests below fetch
// a REAL, independently decryptable vault.age rather than an opaque fixture string.
// ---------------------------------------------------------------------------

interface FixtureResponse {
  status: number
  body: unknown
}

function repoPath(suffix: string): string {
  return `/repos/${OWNER}/${REPO}${suffix}`
}

function readHeadFixtures(armored: string, commitSha: string): Record<string, FixtureResponse> {
  return {
    [`GET ${repoPath(`/git/ref/heads/${DATA_BRANCH}`)}`]: {
      status: 200,
      body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: commitSha } },
    },
    [`GET ${repoPath(`/git/commits/${commitSha}`)}`]: {
      status: 200,
      body: { sha: commitSha, tree: { sha: "tree-1" }, message: "save" },
    },
    [`GET ${repoPath("/git/trees/tree-1")}`]: {
      status: 200,
      body: { sha: "tree-1", tree: [{ path: VAULT_PATH, mode: "100644", type: "blob", sha: "vault-blob-1" }] },
    },
    [`GET ${repoPath("/git/blobs/vault-blob-1")}`]: {
      status: 200,
      body: { sha: "vault-blob-1", content: btoa(armored), encoding: "base64" },
    },
  }
}

/** Same recording-fetch shape as github-read.test.ts/github-write.test.ts: records every call
 * as a "METHOD /path" string and answers from `responses`, throwing loudly on an unregistered
 * call instead of returning some default -- so a bug that makes unlock hit an unexpected
 * endpoint fails with a clear message, not a confusing downstream assertion failure. */
function recordingFetch(calls: string[], responses: Record<string, FixtureResponse>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const { pathname, search } = new URL(urlStr)
    const method = init?.method ?? "GET"
    const key = `${method} ${pathname}${search}`
    calls.push(key)
    const fixture = responses[key]
    if (!fixture) throw new Error(`no fixture response for ${key}`)
    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

/** Builds the `makeStore` factory the amended `unlock` signature requires (plan Ruling R3): a
 * real `GithubStore`, constructed with a recording `fetch` so "no network call happened" can be
 * asserted directly against the HTTP-level call log, the same way github-read/write.test.ts
 * already prove request ordering -- not by trusting that `makeStore` itself was never invoked. */
function makeStoreFor(calls: string[], responses: Record<string, FixtureResponse>): (token: string) => GithubStore {
  return (token: string) => new GithubStore({ owner: OWNER, repo: REPO, token, fetch: recordingFetch(calls, responses) })
}

/** A `makeStore` for the cached-vault tests, which must never reach the network at all (spec
 * §5.3: "Unlock requires no network at all" when a cached vault is present) -- throwing here,
 * rather than merely never asserting on a call count, means an accidental call fails the test
 * immediately and loudly, from the exact place the regression would be. */
function makeStoreMustNotBeCalled(): (token: string) => GithubStore {
  return (_token: string): GithubStore => {
    throw new Error("unlock must not reach the network when a cached vault is already present")
  }
}

// ---------------------------------------------------------------------------
// Local-store seeding helpers. Both device.age (the wrapped identity) and vault.age are always
// wrapped/encrypted under byte-identical passphrase bytes on a real device (spec §5.1/§5.3 --
// one passphrase, everywhere), so every seed helper below wraps/encrypts both under the exact
// same `passphrase` argument, never two different literals that happen to look alike.
// ---------------------------------------------------------------------------

async function seedDeviceAndToken(
  local: LocalStore,
  passphrase: string,
  tokenPlaintext: string | null,
): Promise<{ identity: string }> {
  const { identity, recipient } = await generateDeviceIdentity()
  await local.putWrappedIdentity(await wrapIdentity(identity, passphrase))
  if (tokenPlaintext !== null) {
    await local.putToken(await encryptToRecipient(tokenPlaintext, recipient))
  }
  return { identity }
}

/** Wraps age-encryption's `Decrypter.decrypt` -- the one method every passphrase-protected
 * decrypt in this project (vault.age, device.age) AND every identity-protected decrypt
 * (token.age) ultimately calls (confirmed by reading node_modules/age-encryption@0.3.1/dist/
 * index.js in full: `Decrypter`/`Encrypter` are the package's only two crypto-operation
 * classes, and `decrypt`/`encrypt` are their only methods that do real work) -- counting how
 * many calls are simultaneously in flight (started but not yet resolved).
 *
 * Patches the shared CLASS PROTOTYPE, not a module import binding: `Decrypter.prototype.decrypt`
 * is a plain method added by normal `class ... { async decrypt() {} }` syntax, which ECMAScript
 * defines as an ordinary writable/configurable property on the prototype object -- reassigning
 * it is a normal object mutation, nothing ESM-specific. This sidesteps the real restriction that
 * DOES apply to `import { x } from "module"` bindings (native ESM namespace objects are frozen;
 * assigning to one throws), which is why this project has no `vi.mock` precedent to follow: this
 * approach needs none of Vitest's own ESM-mocking machinery, only ordinary JS. Every importer of
 * "age-encryption" in this test run (this file, src/vault/crypto.ts, src/vault/identity.ts)
 * resolves to the exact same singleton module instance, so this patch is visible to
 * unlock.ts's own calls without unlock.ts needing any test-only seam of its own.
 *
 * `onStart` fires synchronously the instant `.decrypt(...)` is CALLED -- before the wrapped
 * function's own `await` suspends it -- which is what makes this catch a `Promise.all`-style bug
 * and not just a literal-same-CPU-instant race: `@noble/hashes`' `scrypt` (confirmed by reading
 * dist/recipients.js: `ScryptIdentity.unwrapFileKey`/`ScryptRecipient.wrapFileKey` call the
 * synchronous `scrypt(...)` export from "@noble/hashes/scrypt.js" directly, not `scryptAsync`) is
 * a single-threaded, blocking computation, so two such computations can never literally execute
 * at the same instant regardless of how they are kicked off -- but `Promise.all([a(), b()])`
 * still evaluates both call expressions synchronously back to back before either settles, so
 * `onStart` for call B fires while call A is still in flight (suspended, not yet resolved),
 * which is exactly the forbidden pattern this test exists to catch (two 128 MiB buffers alive
 * at once is a real-memory, not a real-CPU-concurrency, hazard -- see src/session/unlock.ts's
 * own header comment). Verified empirically, not just reasoned about: see this file's "a
 * concurrent implementation is actually caught" test below, which deliberately runs two
 * decrypts via Promise.all and confirms peak reaches 2.
 *
 * Returns a restore function; every test using this MUST call it (in a `finally`), or the patch
 * leaks into later tests in this same file -- vitest's default per-FILE module isolation keeps
 * it from leaking into *other* test files, but every test here shares one module instance. */
function instrumentScrypt(onStart: () => void, onEnd: () => void): () => void {
  // `any` here is a deliberate, narrow escape hatch: Decrypter.decrypt is overloaded three ways
  // in age-encryption's own .d.ts (plain/"text"/stream), and no single function literal can
  // satisfy all three call signatures at once the way TypeScript requires for a direct
  // assignment -- the cast below treats the prototype as holding one untyped function, which is
  // all this dynamic patch needs: it forwards whatever was actually passed, for every call shape.
  const proto = Decrypter.prototype as unknown as { decrypt: (...args: unknown[]) => Promise<unknown> }
  const original = proto.decrypt
  proto.decrypt = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    onStart()
    try {
      return await original.apply(this, args)
    } finally {
      onEnd()
    }
  }
  return () => {
    proto.decrypt = original
  }
}

// ---------------------------------------------------------------------------
// Brief's six named tests
// ---------------------------------------------------------------------------

test("with a cached vault: decrypts the vault FIRST, token after", async () => {
  // spec §5.3 -- the editor must open before the token work begins
  const local = new LocalStore()
  const { identity } = await seedDeviceAndToken(local, PASS, "gh-token-cached-path")
  await local.putCachedVault({ armored: await encryptVault("hello vault\n", PASS), sha: "cached-sha-1" })

  const stages: Stage[] = []
  const session = await unlock({
    passphrase: PASS,
    local,
    makeStore: makeStoreMustNotBeCalled(),
    onStage: (s) => stages.push(s),
  })

  expect(stages).toEqual(["vault", "token"])
  expect(session).toEqual({
    text: "hello vault\n",
    baseSha: "cached-sha-1",
    token: "gh-token-cached-path",
    identity,
  })
})

test("on a device's first unlock: token, then fetch, then vault", async () => {
  const local = new LocalStore()
  const { identity } = await seedDeviceAndToken(local, PASS, "gh-token-first-unlock")
  // deliberately no putCachedVault -- this is what selects the first-unlock branch

  const calls: string[] = []
  const vaultArmored = await encryptVault("fetched vault text\n", PASS)
  const makeStore = makeStoreFor(calls, readHeadFixtures(vaultArmored, "remote-commit-1"))

  const stages: Stage[] = []
  const session = await unlock({ passphrase: PASS, local, makeStore, onStage: (s) => stages.push(s) })

  expect(stages).toEqual(["token", "fetch", "vault"])
  expect(session).toEqual({
    text: "fetched vault text\n",
    baseSha: "remote-commit-1",
    token: "gh-token-first-unlock",
    identity,
  })
  expect(calls).toEqual([
    `GET /repos/${OWNER}/${REPO}/git/ref/heads/${DATA_BRANCH}`,
    `GET /repos/${OWNER}/${REPO}/git/commits/remote-commit-1`,
    `GET /repos/${OWNER}/${REPO}/git/trees/tree-1`,
    `GET /repos/${OWNER}/${REPO}/git/blobs/vault-blob-1`,
  ])
})

test("never runs two scrypt operations concurrently", async () => {
  // spec §11/§5.4 -- concurrency here peaks ~256 MiB and gets mobile tabs killed. Invisible in
  // the code and reads like a pointless pessimisation; pinned here. Exercises the first-unlock
  // branch: it is the richer of the two (three sequential Decrypter.decrypt calls -- device.age,
  // token.age, the fetched vault.age -- with a network call interleaved), so it is the stronger
  // proof that nothing here is ever started before the previous step has fully resolved.
  const local = new LocalStore()
  await seedDeviceAndToken(local, PASS, "gh-token-concurrency")
  const makeStore = makeStoreFor([], readHeadFixtures(await encryptVault("concurrency check\n", PASS), "c1"))

  let live = 0
  let peak = 0
  const restore = instrumentScrypt(
    () => {
      peak = Math.max(peak, ++live)
    },
    () => {
      live--
    },
  )
  try {
    await unlock({ passphrase: PASS, local, makeStore })
  } finally {
    restore()
  }
  expect(peak).toBe(1)
})

test("a concurrent implementation is actually caught (instrumentation sanity check)", async () => {
  // Not one of the brief's six -- a deliberate self-check that the instrumentation above would
  // actually fail on a buggy, Promise.all'd implementation, not just happen to always read back
  // 1 regardless of what runs. Calls the REAL Decrypter.decrypt directly (bypassing unlock.ts
  // entirely) twice via Promise.all, proving peak reaches 2 under the exact same instrumentation
  // the "never concurrent" test above relies on.
  const armored = await encryptVault("a", PASS)
  let live = 0
  let peak = 0
  const restore = instrumentScrypt(
    () => {
      peak = Math.max(peak, ++live)
    },
    () => {
      live--
    },
  )
  try {
    await Promise.all([decryptVault(armored, PASS), decryptVault(armored, PASS)])
  } finally {
    restore()
  }
  expect(peak).toBe(2)
})

test("a wrong passphrase fails before any network call", async () => {
  // First-unlock branch: the one branch that would otherwise reach the network, so "no network
  // call happened" is a meaningful assertion here, not a vacuous one (the cached-vault branch
  // never calls the network regardless of passphrase correctness).
  const local = new LocalStore()
  await seedDeviceAndToken(local, PASS, "gh-token-unreachable")
  const calls: string[] = []
  const makeStore = makeStoreFor(calls, readHeadFixtures(await encryptVault("unreachable\n", PASS), "c1"))

  await expect(unlock({ passphrase: "wrong-but-long-enough-x", local, makeStore })).rejects.toThrow(
    WrongPassphraseError,
  )
  expect(calls).toEqual([])
})

test("opens a vault written in NFC when the passphrase is typed in NFD", async () => {
  // spec §5.5 rule 3 -- the same passphrase, a different device's input method. Forgiving on
  // read; still byte-exact on write, so `age -d` keeps working. device.age is seeded too (not
  // just the cached vault) so this exercises the realistic full path -- a device whose own
  // setup used the NFC form, same as the vault -- rather than leaving `identity`/`token`
  // unresolvable.
  const nfc = "für-mein-eigenheim-passphrase"
  const local = new LocalStore()
  const { identity } = await seedDeviceAndToken(local, nfc, "gh-token-nfc")
  await local.putCachedVault({ armored: await encryptVault("hallo\n", nfc), sha: "s1" })

  const session = await unlock({
    passphrase: nfc.normalize("NFD"),
    local,
    makeStore: makeStoreMustNotBeCalled(),
  })

  expect(session.text).toBe("hallo\n")
  expect(session.identity).toBe(identity)
  expect(session.token).toBe("gh-token-nfc")
})

test("the NFC/NFD fallback is tried in sequence, never concurrently", async () => {
  // the fallback must not reintroduce what the third test above forbids: three 128 MiB scrypt
  // runs at once would be worse than the original bug. Same scenario as the NFC/NFD test above
  // (two sequential attempts against vault.age -- NFD fails, NFC succeeds -- then one more
  // against device.age), instrumented the same way as the "never concurrent" test.
  const nfc = "für-mein-eigenheim-passphrase"
  const local = new LocalStore()
  await seedDeviceAndToken(local, nfc, "gh-token-nfc-concurrency")
  await local.putCachedVault({ armored: await encryptVault("hallo\n", nfc), sha: "s1" })

  let live = 0
  let peak = 0
  const restore = instrumentScrypt(
    () => {
      peak = Math.max(peak, ++live)
    },
    () => {
      live--
    },
  )
  try {
    await unlock({ passphrase: nfc.normalize("NFD"), local, makeStore: makeStoreMustNotBeCalled() })
  } finally {
    restore()
  }
  expect(peak).toBe(1)
})

// ---------------------------------------------------------------------------
// Additional coverage added during self-review, not named by the brief -- each closes a gap the
// six tests above leave open (task 7/9's own precedent for naming these explicitly rather than
// leaving them silent).
// ---------------------------------------------------------------------------

test("a cached vault with no stored token still unlocks, reporting token: null", async () => {
  // spec §5.3/§7 -- the token is needed only to sync and commit, never to read, so its absence
  // must not block opening the vault at all when a cached copy already exists.
  const local = new LocalStore()
  const { identity } = await seedDeviceAndToken(local, PASS, null)
  await local.putCachedVault({ armored: await encryptVault("offline read\n", PASS), sha: "s2" })

  const session = await unlock({ passphrase: PASS, local, makeStore: makeStoreMustNotBeCalled() })

  expect(session.token).toBeNull()
  expect(session.text).toBe("offline read\n")
  expect(session.identity).toBe(identity)
})

test("first unlock without a stored token raises TokenError before fetching", async () => {
  // Without a cached vault AND without a token, there is no way to reach the vault at all (no
  // local ciphertext to read, no credential to fetch one) -- a clearly-named error, not a
  // network attempt with an empty/undefined token.
  const local = new LocalStore()
  await seedDeviceAndToken(local, PASS, null)
  const calls: string[] = []
  const makeStore = makeStoreFor(calls, readHeadFixtures(await encryptVault("unreachable\n", PASS), "c1"))

  await expect(unlock({ passphrase: PASS, local, makeStore })).rejects.toThrow(TokenError)
  expect(calls).toEqual([])
})

test("onStage is genuinely optional -- unlock works with no callback at all", async () => {
  const local = new LocalStore()
  await seedDeviceAndToken(local, PASS, "gh-token-no-callback")
  await local.putCachedVault({ armored: await encryptVault("no callback\n", PASS), sha: "s3" })

  await expect(
    unlock({ passphrase: PASS, local, makeStore: makeStoreMustNotBeCalled() }),
  ).resolves.toMatchObject({ text: "no callback\n" })
})
