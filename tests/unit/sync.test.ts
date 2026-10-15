import "fake-indexeddb/auto"
import { syncFromRemote, commit, replayPendingCommit, type Conflict } from "../../src/session/sync"
import type { Session } from "../../src/session/unlock"
import { LocalStore } from "../../src/store/local"
import { GithubStore } from "../../src/store/github"
import { encryptVault, decryptVault } from "../../src/vault/crypto"
import { VAULT_PATH, DATA_BRANCH } from "../../src/config"

const PASS = "a-sufficiently-long-sync-test-passphrase"
const OWNER = "o"
const REPO = "r"

// fake-indexeddb's `indexedDB` is one global for the whole process (same reasoning as
// tests/unit/local.test.ts's own beforeEach) -- without resetting it, one test's seeded
// draft/cachedVault/pendingCommit would leak into the next.
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
 * *array* of responses per key, consumed in order and holding the last entry once exhausted.
 * Duplicated rather than imported, matching this project's existing test-helper convention
 * (e.g. github-setup.test.ts's own makeBodyOf comment): each test file is self-contained. */
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
 * is what src/session/sync.ts's `commit` treats as "offline" -- not `navigator.onLine`, so
 * this test needs no injected event or timer at all (task brief: "if your offline test needs
 * an online event or a timer, inject it" -- this design needs neither, see the report). */
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
  // "reconnect" is simulated by simply calling replayPendingCommit with a GithubStore whose
  // fetch actually answers -- both are plain, deterministic function calls.
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  await local.putDraft({ armored: "draft-ciphertext-placeholder", baseSha: "sha-v0", savedAt: 1000 })

  const offlineStore = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: fetchThatIsOffline() })
  const queued = await commit(session, "offline edit\n", offlineStore, local)
  expect(queued).toEqual({ queued: true })

  const pending = await local.getPendingCommit()
  expect(pending).not.toBeNull()
  expect(pending!.baseSha).toBe("sha-v0")
  expect(await decryptVault(pending!.armored, PASS)).toBe("offline edit\n")
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
  const replayed = await replayPendingCommit(session, onlineStore, local)

  expect(replayed).toEqual({ sha: "reconnect-commit" })
  expect(await local.getPendingCommit()).toBeNull()
  expect(await local.getDraft()).toBeNull()
  expect(await local.getCachedVault()).toEqual({ armored: pending!.armored, sha: "reconnect-commit" })
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

test("a second offline commit supersedes the first -- the queue never holds more than one", async () => {
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const offlineStore = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: fetchThatIsOffline() })

  await commit(session, "first offline edit\n", offlineStore, local)
  await commit(session, "second offline edit\n", offlineStore, local)

  const pending = await local.getPendingCommit()
  expect(await decryptVault(pending!.armored, PASS)).toBe("second offline edit\n")
})

test("a named GithubStore error (not a network failure) propagates instead of being queued", async () => {
  // isUnreachable's whole point: only a failure with none of GithubStore's own named classes
  // means "couldn't reach GitHub at all". A public repo is a real, named, non-transient
  // condition (RepoPublicError) with its own recovery affordance (spec §13) -- queuing it for
  // a silent retry would be actively wrong, since retrying can never fix it.
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const store = new GithubStore({
    owner: OWNER,
    repo: REPO,
    token: "t",
    fetch: recordingFetch([], { [`GET ${repoPath("")}`]: { status: 200, body: { private: false, permissions: { push: true } } } }),
  })

  await expect(commit(session, "mine\n", store, local)).rejects.toThrow(/private/)
  expect(await local.getPendingCommit()).toBeNull()
})

test("replaying a queued commit that conflicts clears the queue and never retries it verbatim", async () => {
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const queuedArmored = await encryptVault("queued edit\n", PASS)
  await local.putPendingCommit({ armored: queuedArmored, baseSha: "sha-v0", message: "save" })
  const baseArmored = await encryptVault("v0\n", PASS)
  const theirsArmored = await encryptVault("someone else's v1\n", PASS)
  const store = storeRejectingWrite({
    ...readHeadFixtures(theirsArmored, "sha-v1"),
    ...commitTreeBlobFixtures(baseArmored, "sha-v0"),
  })

  const r = await replayPendingCommit(session, store, local)

  expect(r).not.toBeNull()
  expect("conflict" in r!).toBe(true)
  expect((r as { conflict: Conflict }).conflict).toMatchObject({
    base: "v0\n",
    mine: "queued edit\n",
    theirs: "someone else's v1\n",
  })
  // "a real answer, not a transient failure" (task brief) -- cleared, not left to be replayed
  // verbatim against the same now-stale base on a later reconnect.
  expect(await local.getPendingCommit()).toBeNull()
})

test("replaying while still unreachable rejects and leaves the commit queued", async () => {
  // The mirror image of the conflict case above: here the retry itself still can't reach
  // GitHub at all, so nothing has been resolved -- the pending commit must survive for a
  // future reconnect to try again, which it can only do if this rejects rather than silently
  // returning something that looks like "handled".
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const queuedArmored = await encryptVault("queued edit\n", PASS)
  await local.putPendingCommit({ armored: queuedArmored, baseSha: "sha-v0", message: "save" })
  const store = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: fetchThatIsOffline() })

  await expect(replayPendingCommit(session, store, local)).rejects.toThrow()

  expect(await local.getPendingCommit()).not.toBeNull()
})

test("a failure fetching 'theirs' during conflict resolution propagates raw, never silently queued", async () => {
  // Self-review catch: a first cut of attemptWrite classified ANY error reaching its single
  // catch block -- including one from the conflict-resolution follow-up calls, not just the
  // initial store.write -- with the same isUnreachable check used to decide "queue this".
  // isUnreachable cannot distinguish "the initial write never reached GitHub" from "GitHub was
  // reached, said StaleWriteError, and THEN a later call failed for some unrelated reason" --
  // both look identical from the outside (neither is one of ALL_ERROR_CLASSES). Silently
  // queuing the latter would retry stale content against a base already known to be wrong,
  // instead of surfacing whatever the real, different problem was. This fixture deliberately
  // makes the ref-update fail as a genuine StaleWriteError (so GitHub really was reached), and
  // ONLY THEN makes the very next call (readHead's own ref-GET) throw a network-shaped error --
  // proving the two are told apart, not conflated.
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
  expect(await local.getPendingCommit()).toBeNull()
})

test("a later successful direct commit clears a stale queued commit nobody ever replayed", async () => {
  // A real sequence, not contrived: offline, edit, Ctrl+S queues a commit; back online before
  // any reconnect-replay ran; user edits again and hits Ctrl+S, which goes straight through
  // (attemptWrite's own success path, not replayPendingCommit). The now-superseded queued
  // attempt -- built on the same baseSha, carrying strictly older content -- must not survive
  // to be replayed later against a base that's now stale, reproducing a conflict about content
  // the user already re-saved successfully.
  const local = new LocalStore()
  const session = makeSession({ baseSha: "sha-v0", text: "v0\n" })
  const staleQueuedArmored = await encryptVault("never-replayed offline edit\n", PASS)
  await local.putPendingCommit({ armored: staleQueuedArmored, baseSha: "sha-v0", message: "save" })
  const store = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: recordingFetch([], writeFixtures("direct-commit")) })

  const r = await commit(session, "v1, saved directly while online\n", store, local)

  expect(r).toEqual({ sha: "direct-commit" })
  expect(await local.getPendingCommit()).toBeNull()
})

test("replayPendingCommit is a no-op returning null when nothing is queued", async () => {
  const local = new LocalStore()
  const session = makeSession()
  const store = new GithubStore({ owner: OWNER, repo: REPO, token: "t", fetch: recordingFetch([], {}) })

  expect(await replayPendingCommit(session, store, local)).toBeNull()
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
