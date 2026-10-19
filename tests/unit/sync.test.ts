import "fake-indexeddb/auto"
import { syncFromRemote, commit, replayPendingCommits, MAX_REPLAY_ATTEMPTS, type Conflict } from "../../src/session/sync"
import type { Session } from "../../src/session/unlock"
import { LocalStore, MAX_PENDING_COMMITS } from "../../src/store/local"
import { PendingQueueFullError, ReplayRepeatedlyUnreachableError } from "../../src/store/errors"
import { GithubStore } from "../../src/store/github"
import { encryptVault, decryptVault } from "../../src/vault/crypto"
import { VAULT_PATH, DATA_BRANCH } from "../../src/config"

const PASS = "a-sufficiently-long-sync-test-passphrase"
const OWNER = "o"
const REPO = "r"

// fake-indexeddb's `indexedDB` is one global for the whole process (same reasoning as
// tests/unit/local.test.ts's own beforeEach) -- without resetting it, one test's seeded
// draft/cachedVault/pendingCommits would leak into the next.
beforeEach(async () => {
  await new LocalStore().clear()
})

function repoPath(suffix: string): string {
  return `/repos/${OWNER}/${REPO}${suffix}`
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    text: "v0\n",
    baseSha: "sha-v0",
    token: "unused-by-sync.ts",
    identity: "unused-by-sync.ts",
    passphrase: PASS,
    ...overrides,
  }
}

interface FixtureResponse {
  status: number
  body: unknown
}

/** Same "METHOD /path" call-recording convention as github-read/write.test.ts and
 * unlock.test.ts's own recordingFetch: throws loudly on an unregistered call (so a bug that
 * makes this code hit an unexpected endpoint fails with a clear message), answers from
 * `responses`, and -- extended the way github-write.test.ts's own version is -- tolerates an
 * *array* of responses per key, consumed in order and holding the last entry once exhausted
 * (what drives this file's own "sequential replies for the same endpoint across two write
 * attempts" tests below). Duplicated rather than imported, matching this project's existing
 * test-helper convention (e.g. github-setup.test.ts's own makeBodyOf comment): each test file
 * is self-contained. */
function recordingFetch(
  calls: string[],
  responses: Record<string, FixtureResponse | FixtureResponse[]>,
): typeof fetch {
  const cursor: Record<string, number> = {}
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const { pathname, search } = new URL(urlStr)
    const method = init?.method ?? "GET"
    const key = `${method} ${pathname}${search}`
    calls.push(key)
    const fixture = responses[key]
    if (!fixture) throw new Error(`no fixture response for ${key}`)
    const sequence = Array.isArray(fixture) ? fixture : [fixture]
    const i = cursor[key] ?? 0
    cursor[key] = i + 1
    const picked = sequence[Math.min(i, sequence.length - 1)]
    return new Response(JSON.stringify(picked.body), {
      status: picked.status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

/** A `fetch` that never reaches a server at all -- confirmed live in this project's own Node
 * 24 runtime (`node -e 'fetch("http://<bogus host>.invalid/")'`) that a real network-level
 * failure rejects with a plain `TypeError` ("fetch failed", `.cause` the underlying
 * `ENOTFOUND`), never one of GithubStore's own named error classes (src/store/errors.ts). This
 * is what src/session/sync.ts's `isUnreachable` treats as "offline" -- not `navigator.onLine`,
 * so this test needs no injected event or timer at all (task brief: "if your offline test
 * needs an online event or a timer, inject it" -- this design needs neither, see the report). */
function fetchThatIsOffline(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed")
  }) as typeof fetch
}

function refFixture(commitSha: string): Record<string, FixtureResponse> {
  return {
    [`GET ${repoPath(`/git/ref/heads/${DATA_BRANCH}`)}`]: {
      status: 200,
      body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: commitSha } },
    },
  }
}

/** The commit -> tree -> blob walk both `readHead` (after resolving the ref) and `readAt`
 * (given the sha directly) perform -- see src/store/github.ts's shared `readVaultAtCommit`.
 * Keyed on `commitSha` so two different versions (e.g. "base" and "theirs" in a conflict) never
 * collide with each other's fixtures. */
function commitTreeBlobFixtures(armored: string, commitSha: string): Record<string, FixtureResponse> {
  return {
    [`GET ${repoPath(`/git/commits/${commitSha}`)}`]: { status: 200, body: { sha: commitSha, tree: { sha: `tree-${commitSha}` } } },
    [`GET ${repoPath(`/git/trees/tree-${commitSha}`)}`]: {
      status: 200,
      body: { sha: `tree-${commitSha}`, tree: [{ path: VAULT_PATH, mode: "100644", type: "blob", sha: `blob-${commitSha}` }] },
    },
    [`GET ${repoPath(`/git/blobs/blob-${commitSha}`)}`]: { status: 200, body: { sha: `blob-${commitSha}`, content: btoa(armored) } },
  }
}

function readHeadFixtures(armored: string, commitSha: string): Record<string, FixtureResponse> {
  return { ...refFixture(commitSha), ...commitTreeBlobFixtures(armored, commitSha) }
}

/** `write`'s happy-path fixtures, same shapes as github-write.test.ts's own `writeFixtures` --
 * a repo-GET for `assertRepoWritable`'s guard, then one 201 per creation call, then a 200 on
 * the ref update, landing at `resultSha`. */
function writeFixtures(resultSha: string): Record<string, FixtureResponse> {
  return {
    [`GET ${repoPath("")}`]: { status: 200, body: { private: true, permissions: { push: true } } },
    [`POST ${repoPath("/git/blobs")}`]: { status: 201, body: { sha: "new-blob" } },
    [`POST ${repoPath("/git/trees")}`]: { status: 201, body: { sha: "new-tree" } },
    [`POST ${repoPath("/git/commits")}`]: { status: 201, body: { sha: resultSha } },
    [`PATCH ${repoPath(`/git/refs/heads/${DATA_BRANCH}`)}`]: {
      status: 200,
      body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: resultSha } },
    },
  }
}

/** `write`'s fixtures, but rejecting the ref update as a non-fast-forward (422 -- this
 * project's own live-confirmed status, see github-write.test.ts), merged with whatever read
 * fixtures (`readHead`/`readAt`) the conflict path needs on top -- same composition
 * github-write.test.ts's own `storeRejectingRefWith` uses, extended with read fixtures since
 * this task's own conflict handling reads two more versions after the rejection. */
function storeRejectingWrite(readFixtures: Record<string, FixtureResponse>): GithubStore {
  return new GithubStore({
    owner: OWNER,
    repo: REPO,
    token: "t",
    fetch: recordingFetch([], {
      [`GET ${repoPath("")}`]: { status: 200, body: { private: true, permissions: { push: true } } },
      [`POST ${repoPath("/git/blobs")}`]: { status: 201, body: { sha: "attempt-blob" } },
      [`POST ${repoPath("/git/trees")}`]: { status: 201, body: { sha: "attempt-tree" } },
      [`POST ${repoPath("/git/commits")}`]: { status: 201, body: { sha: "attempt-commit" } },
      [`PATCH ${repoPath(`/git/refs/heads/${DATA_BRANCH}`)}`]: { status: 422, body: { message: "not a fast forward" } },
      ...readFixtures,
    }),
  })
}

// ---------------------------------------------------------------------------
// Brief's five named tests
// ---------------------------------------------------------------------------

test("a newer remote with a clean draft updates the editor", async () => {
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const newArmored = await encryptVault("v1 from remote\n", PASS)
  const store = new GithubStore({
    owner: OWNER,
    repo: REPO,
    token: "t",
    fetch: recordingFetch([], readHeadFixtures(newArmored, "sha-v1")),
  })

  const result = await syncFromRemote(session, store, local)

  expect(result).toEqual({ updated: true, diverged: false })
  expect(session.text).toBe("v1 from remote\n")
  expect(session.baseSha).toBe("sha-v1")
  expect(await local.getCachedVault()).toEqual({ armored: newArmored, sha: "sha-v1" })
})

test("a newer remote with a dirty draft never overwrites it", async () => {
  const local = new LocalStore()
  // Draft.armored is encrypted to the device identity (spec §7), not the vault passphrase --
  // syncFromRemote's diverged branch never decrypts it (it must not even need to), so an
  // opaque placeholder is exactly as valid a fixture here as a real device-identity ciphertext
  // would be.
  const dirtyArmored = "dirty-draft-ciphertext-placeholder"
  await local.putDraft({ armored: dirtyArmored, baseSha: "sha-v0", savedAt: 1000 })
  const session = makeSession({ baseSha: "sha-v0", text: "v0 + local edits\n" })
  const newArmored = await encryptVault("v1 from remote\n", PASS)
  const store = new GithubStore({
    owner: OWNER,
    repo: REPO,
    token: "t",
    fetch: recordingFetch([], readHeadFixtures(newArmored, "sha-v1")),
  })

  const r = await syncFromRemote(session, store, local)

  expect(r).toEqual({ updated: false, diverged: true })
  expect((await local.getDraft())!.armored).toBe(dirtyArmored)
  // Never overwritten in memory either -- the whole point of "diverged" is that nothing about
  // the user's current edit is touched until they explicitly commit.
  expect(session.text).toBe("v0 + local edits\n")
  expect(session.baseSha).toBe("sha-v0")
  expect(await local.getCachedVault()).toBeNull()
})

test("commit on a stale base returns a three-way conflict, not an error", async () => {
  const local = new LocalStore()
  await local.putDraft({ armored: "draft-ciphertext-placeholder", baseSha: "sha-v0", savedAt: 1000 })
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const baseArmored = await encryptVault("v0\n", PASS)
  const theirsArmored = await encryptVault("v1\n", PASS)
  const store = storeRejectingWrite({
    ...readHeadFixtures(theirsArmored, "sha-v1"),
    ...commitTreeBlobFixtures(baseArmored, "sha-v0"),
  })

  const r = await commit(session, "mine\n", store, local)

  expect("conflict" in r).toBe(true)
  const { conflict } = r as { conflict: Conflict }
  expect(conflict).toMatchObject({ base: "v0\n", mine: "mine\n", theirs: "v1\n" })
  expect(typeof conflict.merged).toBe("string")
  expect(typeof conflict.conflicted).toBe("boolean")
  // commit() never writes on a conflict -- no path advances the cached vault or clears the
  // draft when the result is a conflict, not a sha.
  expect(await local.getCachedVault()).toBeNull()
  expect(await local.getDraft()).not.toBeNull()
})

test("offline commits queue and replay in order on reconnect", async () => {
  // spec §13 -- "editing continues; commit queues and retries on reconnect". No real timer or
  // `online` event anywhere in this test: "offline" is simulated by a fetch that throws
  // (fetchThatIsOffline, see its own doc comment for why that's the right signal), and
  // "reconnect" is simulated by simply calling replayPendingCommits with a GithubStore whose
  // fetch actually answers -- both are plain, deterministic function calls.
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  await local.putDraft({ armored: "draft-ciphertext-placeholder", baseSha: "sha-v0", savedAt: 1000 })

  const offlineStore = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: fetchThatIsOffline() })
  const queued = await commit(session, "offline edit\n", offlineStore, local)
  expect(queued).toEqual({ queued: true })

  const queue = await local.getPendingCommits()
  expect(queue.length).toBe(1)
  expect(queue[0].baseSha).toBe("sha-v0")
  expect(await decryptVault(queue[0].armored, PASS)).toBe("offline edit\n")
  // Queuing alone never commits anything -- no network call succeeded, so nothing durable
  // changed yet.
  expect(await local.getCachedVault()).toBeNull()
  expect((await local.getDraft())!.armored).toBe("draft-ciphertext-placeholder")
  expect(session.baseSha).toBe("sha-v0")
  expect(session.text).toBe("v0\n")

  // "Reconnect": nothing else has moved remotely, so replaying the exact same queued attempt
  // against a store that can actually reach GitHub now just succeeds.
  const calls: string[] = []
  const onlineStore = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: recordingFetch(calls, writeFixtures("reconnect-commit")) })
  const replayed = await replayPendingCommits(session, onlineStore, local)

  expect(replayed).toEqual({ committedShas: ["reconnect-commit"], conflict: null, unreachable: false })
  expect(await local.getPendingCommits()).toEqual([])
  expect(await local.getDraft()).toBeNull()
  expect(await local.getCachedVault()).toEqual({ armored: queue[0].armored, sha: "reconnect-commit" })
  expect(session.baseSha).toBe("reconnect-commit")
  expect(session.text).toBe("offline edit\n")
})

test("a successful commit advances the cached vault and clears the draft", async () => {
  const local = new LocalStore()
  await local.putDraft({ armored: "draft-ciphertext-placeholder", baseSha: "sha-v0", savedAt: 1000 })
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const calls: string[] = []
  const store = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: recordingFetch(calls, writeFixtures("fresh-commit")) })

  const r = await commit(session, "v1\n", store, local)

  expect(r).toEqual({ sha: "fresh-commit" })
  const cached = await local.getCachedVault()
  expect(cached!.sha).toBe("fresh-commit")
  expect(await decryptVault(cached!.armored, PASS)).toBe("v1\n")
  expect(await local.getDraft()).toBeNull()
  expect(session.baseSha).toBe("fresh-commit")
  expect(session.text).toBe("v1\n")
})

// ---------------------------------------------------------------------------
// Additional coverage added during self-review, not named by the brief -- each closes a gap
// the five tests above leave open or pins a requirement the brief states in prose but the
// named tests don't directly exercise (task 7/9's own precedent for naming these explicitly
// rather than leaving them silent).
// ---------------------------------------------------------------------------

test("the merge base is the draft's own baseSha, not the session's, when the two have diverged", async () => {
  // A real scenario, not a contrived one: two tabs share one IndexedDB (Review Focus 4). If
  // another tab's own successful commit already advanced this session's in-memory baseSha
  // (e.g. via its own syncFromRemote/commit call touching the same `local`) while THIS
  // session's draft is still built on the version it actually started from, the draft's own
  // stored baseSha -- not the session's -- is the true common ancestor for a three-way merge.
  // Using the wrong one here would hand `merge3` the wrong "base", silently corrupting the
  // conflict it produces.
  const local = new LocalStore()
  await local.putDraft({ armored: "draft-ciphertext-placeholder", baseSha: "sha-true-base", savedAt: 1000 })
  // The session's own baseSha has drifted ahead (as if some other code path advanced it) --
  // deliberately NOT equal to the draft's.
  const session = makeSession({ baseSha: "sha-session-drifted", text: "v0\n" })
  const baseArmored = await encryptVault("v0\n", PASS)
  const theirsArmored = await encryptVault("v1\n", PASS)
  const store = storeRejectingWrite({
    ...readHeadFixtures(theirsArmored, "sha-v1"),
    ...commitTreeBlobFixtures(baseArmored, "sha-true-base"),
  })

  const r = await commit(session, "mine\n", store, local)

  expect("conflict" in r).toBe(true)
  expect((r as { conflict: Conflict }).conflict).toMatchObject({ base: "v0\n", mine: "mine\n", theirs: "v1\n" })
})

test("a named GithubStore error (not a network failure) propagates instead of being queued", async () => {
  // isUnreachable's whole point: only a genuine network-level failure (a real TypeError) means
  // "couldn't reach GitHub at all". A public repo is a real, named, non-transient condition
  // (RepoPublicError, a plain Error subclass -- never a TypeError) with its own recovery
  // affordance (spec §13) -- queuing it for a silent retry would be actively wrong, since
  // retrying can never fix it.
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const store = new GithubStore({
    owner: OWNER,
    repo: REPO,
    token: "t",
    fetch: recordingFetch([], { [`GET ${repoPath("")}`]: { status: 200, body: { private: false, permissions: { push: true } } } }),
  })

  await expect(commit(session, "mine\n", store, local)).rejects.toThrow(/private/)
  expect(await local.getPendingCommits()).toEqual([])
})

test("a genuine unmapped GitHub HTTP error propagates immediately instead of being silently queued forever", async () => {
  // Review round 1, Important 3: a transient 500 (or any status GithubStore's own request()
  // doesn't specifically map) is a REAL response GitHub sent -- request()'s generic fallback
  // turns it into a plain, unclassified `Error`, never a `TypeError`. The original
  // exclusion-based isUnreachable ("not one of the six named classes") would have misclassified
  // this as "offline" and queued it, where it would fail identically -- and silently -- on
  // every future replay, with no diagnostic. The fixed, positive `instanceof TypeError` test
  // tells the two apart.
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const responses: Record<string, FixtureResponse> = {
    [`GET ${repoPath("")}`]: { status: 200, body: { private: true, permissions: { push: true } } },
    [`POST ${repoPath("/git/blobs")}`]: { status: 201, body: { sha: "b" } },
    [`POST ${repoPath("/git/trees")}`]: { status: 201, body: { sha: "t" } },
    [`POST ${repoPath("/git/commits")}`]: { status: 201, body: { sha: "c" } },
    [`PATCH ${repoPath(`/git/refs/heads/${DATA_BRANCH}`)}`]: { status: 500, body: { message: "Internal Server Error" } },
  }
  const store = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: recordingFetch([], responses) })

  await expect(commit(session, "mine\n", store, local)).rejects.toThrow()
  expect(await local.getPendingCommits()).toEqual([])
})

test("a failure fetching 'theirs' during conflict resolution propagates raw, never silently queued", async () => {
  // Self-review catch (original implementation): a first cut of attemptWrite classified ANY
  // error reaching its single catch block -- including one from the conflict-resolution
  // follow-up calls, not just the initial store.write -- with the same isUnreachable check used
  // to decide "queue this". isUnreachable cannot distinguish "the initial write never reached
  // GitHub" from "GitHub was reached, said StaleWriteError, and THEN a later call failed for
  // some unrelated reason" if both happen to be TypeErrors. Silently queuing the latter would
  // retry stale content against a base already known to be wrong, instead of surfacing whatever
  // the real, different problem was. This fixture deliberately makes the ref-update fail as a
  // genuine StaleWriteError (so GitHub really was reached), and ONLY THEN makes the very next
  // call (readHead's own ref-GET) throw a network-shaped error -- proving the two are told
  // apart, not conflated.
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const responses: Record<string, FixtureResponse> = {
    [`GET ${repoPath("")}`]: { status: 200, body: { private: true, permissions: { push: true } } },
    [`POST ${repoPath("/git/blobs")}`]: { status: 201, body: { sha: "attempt-blob" } },
    [`POST ${repoPath("/git/trees")}`]: { status: 201, body: { sha: "attempt-tree" } },
    [`POST ${repoPath("/git/commits")}`]: { status: 201, body: { sha: "attempt-commit" } },
    [`PATCH ${repoPath(`/git/refs/heads/${DATA_BRANCH}`)}`]: { status: 422, body: { message: "not a fast forward" } },
  }
  const refPath = repoPath(`/git/ref/heads/${DATA_BRANCH}`)
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const { pathname } = new URL(urlStr)
    if (pathname === refPath) throw new TypeError("fetch failed")
    const method = init?.method ?? "GET"
    const key = `${method} ${pathname}`
    const fixture = responses[key]
    if (!fixture) throw new Error(`no fixture response for ${key}`)
    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  const store = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: fetchFn })

  await expect(commit(session, "mine\n", store, local)).rejects.toThrow(TypeError)
  // NOT queued -- the whole point: this is a different failure than "never reached GitHub".
  expect(await local.getPendingCommits()).toEqual([])
})

test("replayPendingCommits is a no-op returning null when nothing is queued", async () => {
  const local = new LocalStore()
  const session = makeSession()
  const store = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: recordingFetch([], {}) })

  expect(await replayPendingCommits(session, store, local)).toBeNull()
})

test("syncFromRemote makes no decrypt call at all when nothing has changed", async () => {
  // head.sha === session.baseSha must short-circuit before touching the draft or the
  // passphrase-protected decrypt (scrypt) at all -- a session with a deliberately wrong
  // passphrase would throw WrongPassphraseError if this path ever reached decryptVault.
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n", passphrase: "this-would-fail-to-decrypt-anything" })
  const calls: string[] = []
  const store = new GithubStore({
    owner: OWNER,
    repo: REPO,
    token: "t",
    fetch: recordingFetch(calls, readHeadFixtures(await encryptVault("v0\n", PASS), "sha-v0")),
  })

  const r = await syncFromRemote(session, store, local)

  expect(r).toEqual({ updated: false, diverged: false })
  expect(session.text).toBe("v0\n")
  expect(await local.getCachedVault()).toBeNull()
})

test("the conflict path never runs its scrypt-protected decrypts concurrently", async () => {
  // Global Constraint (plan.md): the two scrypt runs must never be concurrent, on pain of a
  // mobile tab being discarded (spec §5.4) -- stated for unlock.ts, but the underlying hazard
  // (two ~128 MiB age-scrypt buffers alive at once) is identical here, where a conflict can
  // run up to three such decrypts (base, theirs, and -- for a replay -- mine) in the same
  // call. Same patch-the-shared-prototype instrumentation as unlock.test.ts's own
  // "never runs two scrypt operations concurrently" (duplicated rather than imported, matching
  // this project's self-contained-test-file convention; see that file's own doc comment for
  // why patching the prototype rather than the module binding is safe here).
  const { Decrypter } = await import("age-encryption")
  const proto = Decrypter.prototype as unknown as { decrypt: (...args: unknown[]) => Promise<unknown> }
  const original = proto.decrypt
  let live = 0
  let peak = 0
  proto.decrypt = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    peak = Math.max(peak, ++live)
    try {
      return await original.apply(this, args)
    } finally {
      live--
    }
  }

  try {
    const local = new LocalStore()
    await local.putDraft({ armored: "draft-ciphertext-placeholder", baseSha: "sha-v0", savedAt: 1000 })
    const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
    const baseArmored = await encryptVault("v0\n", PASS)
    const theirsArmored = await encryptVault("v1\n", PASS)
    const store = storeRejectingWrite({
      ...readHeadFixtures(theirsArmored, "sha-v1"),
      ...commitTreeBlobFixtures(baseArmored, "sha-v0"),
    })
    await commit(session, "mine\n", store, local)
  } finally {
    proto.decrypt = original
  }
  expect(peak).toBe(1)
})

// ---------------------------------------------------------------------------
// Review round 1 fixes -- two Criticals and an Important, each reproduced live against this
// file's own pre-fix code before being fixed (see this task's fix report for the RED output).
// The tests below assert the FIXED, correct behaviour; each replaces an earlier test that
// asserted what turned out to be the bug itself (named in each comment below).
// ---------------------------------------------------------------------------

test("two tabs independently queuing offline commits from the same base must not destroy each other", async () => {
  // Critical 1. Two INDEPENDENT Session objects -- not the same object called twice. That
  // distinction is exactly what let this bug through the first time: the original "a second
  // offline commit supersedes the first" test (removed) used one Session for both calls,
  // modeling one continuous editing stream, never two tabs that each went offline from the
  // same base without ever seeing the other's edit.
  const local = new LocalStore()
  const sessionTab1 = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const sessionTab2 = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const offlineStore = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: fetchThatIsOffline() })

  await commit(sessionTab1, "A\n", offlineStore, local)
  await commit(sessionTab2, "B\n", offlineStore, local)

  const queue = await local.getPendingCommits()
  expect(queue.length).toBe(2)
  expect(await decryptVault(queue[0].armored, PASS)).toBe("A\n")
  expect(await decryptVault(queue[1].armored, PASS)).toBe("B\n")
})

test("two consecutive offline commits from the same session also both queue, in order -- never superseded", async () => {
  // The complementary, same-tab case: even a single continuous editing stream's own two
  // offline saves both queue (every commit already carries the full text, so there would be no
  // CORRECTNESS reason to drop the first -- but review round 1 established that dropping it is
  // also not SAFE in general, so the uniform rule is simply: enqueue always appends).
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const offlineStore = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: fetchThatIsOffline() })

  await commit(session, "first offline edit\n", offlineStore, local)
  await commit(session, "second offline edit\n", offlineStore, local)

  const queue = await local.getPendingCommits()
  expect(queue.length).toBe(2)
  expect(await decryptVault(queue[0].armored, PASS)).toBe("first offline edit\n")
  expect(await decryptVault(queue[1].armored, PASS)).toBe("second offline edit\n")
})

test("enqueuing beyond the cap during commit() propagates PendingQueueFullError, and the edit survives in the draft", async () => {
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  await local.putDraft({ armored: "draft-at-start", baseSha: "sha-v0", savedAt: 1000 })
  for (let i = 0; i < MAX_PENDING_COMMITS; i++) {
    await local.enqueuePendingCommit({ armored: `filler-${i}`, baseSha: "sha-v0", message: "m" })
  }
  const offlineStore = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: fetchThatIsOffline() })

  await expect(commit(session, "one too many\n", offlineStore, local)).rejects.toThrow(PendingQueueFullError)

  // The edit is not lost -- it is still sitting in the draft (commit() only touches the draft
  // on a successful write, which this was not).
  expect(await local.getDraft()).not.toBeNull()
})

test("a newer draft written while a commit is in flight survives, rebased onto the just-committed sha, instead of being destroyed", async () => {
  // Critical 2. Models the real race: commit() reads the draft, then spends real time (scrypt
  // plus a network round trip) before its write resolves. Injected here as a side effect of
  // the fetch mock's very first call (the blob POST), landing a NEWER draft mid-write --
  // deterministic, no real timing or concurrency needed, matching this project's injection
  // discipline.
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  await local.putDraft({ armored: "draft-at-start", baseSha: "sha-v0", savedAt: 1000 })

  const fixtures = writeFixtures("in-flight-commit")
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const { pathname, search } = new URL(urlStr)
    const method = init?.method ?? "GET"
    const key = `${method} ${pathname}${search}`
    if (key === `POST ${repoPath("/git/blobs")}`) {
      await local.putDraft({ armored: "draft-written-during-the-write", baseSha: "sha-v0", savedAt: 9999 })
    }
    const fixture = fixtures[key]
    if (!fixture) throw new Error(`no fixture response for ${key}`)
    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  const store = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: fetchFn })

  await commit(session, "v1\n", store, local)

  const draftAfter = await local.getDraft()
  expect(draftAfter).not.toBeNull()
  expect(draftAfter?.armored).toBe("draft-written-during-the-write")
  // Rebased onto the sha just committed -- not left pointing at the now-stale original base.
  expect(draftAfter?.baseSha).toBe("in-flight-commit")
})

test("a later successful direct commit does not destroy a stale queued entry -- replaying it still safely surfaces as a conflict", async () => {
  // Replaces the original "a later successful direct commit clears a stale queued commit
  // nobody ever replayed" test, which asserted the OPPOSITE of what review round 1 established
  // is safe: "the newer save already supersedes whatever was queued" is exactly the unverified
  // "these two must be equivalent" assumption that Critical 1 proved false for two tabs sharing
  // a base. The safe answer is to never guess -- leave the stale entry queued, and let its own
  // eventual replay discover, via a real three-way merge, whether it is actually superseded or
  // genuinely independent content.
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const staleQueuedArmored = await encryptVault("never-replayed offline edit\n", PASS)
  await local.enqueuePendingCommit({ armored: staleQueuedArmored, baseSha: "sha-v0", message: "save" })
  const store = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: recordingFetch([], writeFixtures("direct-commit")) })

  const r = await commit(session, "v1, saved directly while online\n", store, local)
  expect(r).toEqual({ sha: "direct-commit" })

  // The stale entry is untouched by this unrelated success.
  const queueAfter = await local.getPendingCommits()
  expect(queueAfter.length).toBe(1)
  expect(await decryptVault(queueAfter[0].armored, PASS)).toBe("never-replayed offline edit\n")

  // Replaying it now safely surfaces as a conflict (its baseSha is stale against the direct
  // commit that just happened), not silently vanishing and not wrongly applied.
  const theirsArmored = await encryptVault("v1, saved directly while online\n", PASS)
  const baseArmored = await encryptVault("v0\n", PASS)
  const replayStore = storeRejectingWrite({
    ...readHeadFixtures(theirsArmored, "direct-commit"),
    ...commitTreeBlobFixtures(baseArmored, "sha-v0"),
  })
  const replayResult = await replayPendingCommits(session, replayStore, local)

  expect(replayResult).not.toBeNull()
  expect(replayResult!.conflict).toMatchObject({
    base: "v0\n",
    mine: "never-replayed offline edit\n",
    theirs: "v1, saved directly while online\n",
  })
})

test("replaying a queued commit that conflicts dequeues it and never retries it verbatim", async () => {
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const queuedArmored = await encryptVault("queued edit\n", PASS)
  await local.enqueuePendingCommit({ armored: queuedArmored, baseSha: "sha-v0", message: "save" })
  const baseArmored = await encryptVault("v0\n", PASS)
  const theirsArmored = await encryptVault("someone else's v1\n", PASS)
  const store = storeRejectingWrite({
    ...readHeadFixtures(theirsArmored, "sha-v1"),
    ...commitTreeBlobFixtures(baseArmored, "sha-v0"),
  })

  const r = await replayPendingCommits(session, store, local)

  expect(r).not.toBeNull()
  expect(r!.committedShas).toEqual([])
  expect(r!.unreachable).toBe(false)
  expect(r!.conflict).toMatchObject({ base: "v0\n", mine: "queued edit\n", theirs: "someone else's v1\n" })
  // "a real answer, not a transient failure" (task brief) -- dequeued, not left to be replayed
  // verbatim against the same now-stale base on a later reconnect.
  expect(await local.getPendingCommits()).toEqual([])
})

test("the queue can drain multiple entries in one call as independent commits when none of them conflict", async () => {
  // Realistically, every entry queued during the SAME offline episode shares the identical
  // original baseSha (nothing succeeded in between to advance it), so the second entry onward
  // almost always hits a stale write on replay -- see the "stops at the first conflict" test
  // below for that ordinary case. This test instead proves the LOOP ITSELF correctly keeps
  // draining after a success (not just handling exactly one entry): it constructs a queue
  // whose second entry's own baseSha is deliberately set to what the first entry is KNOWN (in
  // this test, not in reality) to commit to -- an artificial setup no real offline user could
  // arrange, since nobody knows their own future commit sha while still offline, but a faithful
  // test of the loop's own control flow and of "N queued entries replay as N real commits"
  // (review round 1's own ruling) in the one case where that is actually achievable in a single
  // call.
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  await local.enqueuePendingCommit({ armored: await encryptVault("first\n", PASS), baseSha: "sha-v0", message: "m1" })
  await local.enqueuePendingCommit({ armored: await encryptVault("second\n", PASS), baseSha: "commit-1", message: "m2" })

  const store = new GithubStore({
    owner: OWNER,
    repo: REPO,
    token: "t",
    fetch: recordingFetch([], {
      [`GET ${repoPath("")}`]: { status: 200, body: { private: true, permissions: { push: true } } },
      [`POST ${repoPath("/git/blobs")}`]: { status: 201, body: { sha: "blob" } },
      [`POST ${repoPath("/git/trees")}`]: { status: 201, body: { sha: "tree" } },
      [`POST ${repoPath("/git/commits")}`]: [
        { status: 201, body: { sha: "commit-1" } },
        { status: 201, body: { sha: "commit-2" } },
      ],
      [`PATCH ${repoPath(`/git/refs/heads/${DATA_BRANCH}`)}`]: [
        { status: 200, body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "commit-1" } } },
        { status: 200, body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "commit-2" } } },
      ],
    }),
  })

  const result = await replayPendingCommits(session, store, local)

  expect(result).toEqual({ committedShas: ["commit-1", "commit-2"], conflict: null, unreachable: false })
  expect(await local.getPendingCommits()).toEqual([])
  expect(session.baseSha).toBe("commit-2")
  expect(session.text).toBe("second\n")
})

test("replay stops at the first conflict, leaving any later queued entries untouched for a future call", async () => {
  // This is the suite's single heaviest test, and the one vite.config.ts's `testTimeout` is
  // sized from: this whole test body -- setup, replay, AND its own closing assertion -- runs TEN
  // sequential logN=17 scrypt operations, never concurrently (this project's own Global
  // Constraint, spec §5.4), and that is essentially the entirety of its wall clock. The op count
  // is this test's own property and lives here; the per-op cost and the chosen timeout are
  // suite-wide and live there (ruling R31 -- the override this test used to carry inline was
  // removed when that global was added, because every other scrypt-heavy test in this suite was
  // one contention spike from needing an identical one).
  //
  // Ten is MEASURED, not counted by reading the call sites: a temporary stack-logging probe
  // wrapped around encryptVault/decryptVault in src/vault/crypto.ts, run against this single
  // test by name, reported exactly `enc=5 dec=5`, with these origins in the captured stacks --
  //   encryptVault x5 -- the three `enqueuePendingCommit` fixtures ("A", "B", "C"), plus the
  //     `aArmored` and `baseArmored` fixtures the mocked store answers reads with.
  //   decryptVault x5 -- replayPendingCommits' own per-entry `mineText` decrypt, once each for
  //     "A" and "B"; attemptWrite's two conflict-path decrypts for "theirs"/"base"; and this
  //     test's own final `decryptVault(remaining[0].armored, PASS)`, which is how the
  //     `"C" was never even attempted` assertion reads the still-queued entry back.
  // That last one is why counting by eye got this wrong twice (seven, then nine): it sits in an
  // assertion rather than in the code under test, so a count scoped to "setup plus replay" misses
  // it -- while the ~0.5s it costs is exactly the kind of wall clock this timeout exists to
  // cover. Hence the deliberately unscoped framing above: the number and the covered wall clock
  // have to be the same thing. Re-measure the same way before editing this number again, and
  // tell vite.config.ts if it changes -- that is where ten ops gets turned into a timeout.
  //
  // The ordinary multi-entry shape: all three entries share the identical original base (the
  // realistic case for one offline episode -- nothing succeeded in between to advance any of
  // them). "A" fast-forwards cleanly; that is exactly what makes "B" (same base) stale the
  // instant "A" lands -- so "B" conflicts against "A"'s own just-written content. "C" is never
  // even attempted.
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  await local.enqueuePendingCommit({ armored: await encryptVault("A\n", PASS), baseSha: "sha-v0", message: "m-a" })
  await local.enqueuePendingCommit({ armored: await encryptVault("B\n", PASS), baseSha: "sha-v0", message: "m-b" })
  await local.enqueuePendingCommit({ armored: await encryptVault("C\n", PASS), baseSha: "sha-v0", message: "m-c" })

  const aArmored = await encryptVault("A\n", PASS)
  const baseArmored = await encryptVault("v0\n", PASS)
  const store = new GithubStore({
    owner: OWNER,
    repo: REPO,
    token: "t",
    fetch: recordingFetch([], {
      [`GET ${repoPath("")}`]: { status: 200, body: { private: true, permissions: { push: true } } },
      [`POST ${repoPath("/git/blobs")}`]: { status: 201, body: { sha: "blob" } },
      [`POST ${repoPath("/git/trees")}`]: { status: 201, body: { sha: "tree" } },
      [`POST ${repoPath("/git/commits")}`]: { status: 201, body: { sha: "A-sha" } },
      [`PATCH ${repoPath(`/git/refs/heads/${DATA_BRANCH}`)}`]: [
        { status: 200, body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "A-sha" } } },
        { status: 422, body: { message: "not a fast forward" } },
      ],
      ...readHeadFixtures(aArmored, "A-sha"),
      ...commitTreeBlobFixtures(baseArmored, "sha-v0"),
    }),
  })

  const result = await replayPendingCommits(session, store, local)

  expect(result).not.toBeNull()
  expect(result!.committedShas).toEqual(["A-sha"])
  expect(result!.unreachable).toBe(false)
  expect(result!.conflict).toMatchObject({ base: "v0\n", mine: "B\n", theirs: "A\n" })

  // "C" was never even attempted -- still queued, exactly as it was.
  const remaining = await local.getPendingCommits()
  expect(remaining.length).toBe(1)
  expect(await decryptVault(remaining[0].armored, PASS)).toBe("C\n")
})

test("a single still-unreachable replay attempt returns a structured outcome without throwing, and records the attempt", async () => {
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  await local.enqueuePendingCommit({ armored: await encryptVault("queued\n", PASS), baseSha: "sha-v0", message: "m" })
  const store = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: fetchThatIsOffline() })

  const result = await replayPendingCommits(session, store, local)

  expect(result).toEqual({ committedShas: [], conflict: null, unreachable: true })
  const queue = await local.getPendingCommits()
  expect(queue.length).toBe(1)
  expect(queue[0].attempts).toBe(1)
})

test("repeated unreachable replays eventually throw ReplayRepeatedlyUnreachableError without ever discarding the entry", async () => {
  // Review round 1, Important 3's own "cap identical repeated replay failures and surface a
  // distinct error" requirement. MAX_REPLAY_ATTEMPTS - 1 calls return the ordinary structured
  // "still unreachable" outcome (attempts climbing 1, 2, 3, 4); the MAX_REPLAY_ATTEMPTS-th call
  // throws instead -- but the queue entry survives every single one of them.
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  await local.enqueuePendingCommit({ armored: await encryptVault("queued\n", PASS), baseSha: "sha-v0", message: "m" })
  const store = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: fetchThatIsOffline() })

  for (let i = 0; i < MAX_REPLAY_ATTEMPTS - 1; i++) {
    const r = await replayPendingCommits(session, store, local)
    expect(r).toEqual({ committedShas: [], conflict: null, unreachable: true })
  }

  await expect(replayPendingCommits(session, store, local)).rejects.toThrow(ReplayRepeatedlyUnreachableError)

  const queue = await local.getPendingCommits()
  expect(queue.length).toBe(1)
  expect(queue[0].attempts).toBe(MAX_REPLAY_ATTEMPTS)
  expect(await decryptVault(queue[0].armored, PASS)).toBe("queued\n")
})
