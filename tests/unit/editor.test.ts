import "fake-indexeddb/auto"
import { Encrypter } from "age-encryption"
import {
  openDocument,
  autosaveDraft,
  commitDocument,
  syncOnce,
  drainQueue,
  indicatorState,
  indicatorLabel,
  adoptSyncedText,
  createOperationQueue,
  type SaveState,
  type SessionIO,
} from "../../src/ui/editor"
import type { Session } from "../../src/session/unlock"
import { LocalStore } from "../../src/store/local"
import { GithubStore } from "../../src/store/github"
import { encryptVault, decryptVault, encryptToRecipient, decryptWithIdentity } from "../../src/vault/crypto"
import { generateDeviceIdentity, recipientFor } from "../../src/vault/identity"
import { VAULT_PATH, DATA_BRANCH } from "../../src/config"

// Ruling R28: Task 13's worst bug existed because every step's real work lived inline inside a
// DOM click-handler closure, so no unit test could call it. src/ui/editor.ts therefore keeps its
// whole orchestration -- open, autosave, commit, background sync, queue replay, and the
// indicator's own state function -- in plain DOM-free functions, and this file is what calls
// them. These tests run in bare Node (vite.config.ts sets no `environment`), so any `document`
// or `window` reference that leaks into one of those functions fails here immediately with a
// ReferenceError rather than only showing up in a 10s Playwright run.

const PASS = "a-sufficiently-long-editor-test-passphrase"
const OWNER = "o"
const REPO = "r"

beforeEach(async () => {
  // fake-indexeddb's `indexedDB` is one global for the whole process (same reasoning as
  // tests/unit/local.test.ts's own beforeEach): a leaked draft would silently flip which branch
  // of `openDocument` a later test exercises.
  await new LocalStore().clear()
})

function repoPath(suffix: string): string {
  return `/repos/${OWNER}/${REPO}${suffix}`
}

/** A session with a REAL device identity -- unlike tests/unit/sync.test.ts, which can use a
 * placeholder string there, every draft this file writes is genuinely X25519-encrypted to this
 * identity and read back through it. */
async function makeSession(overrides: Partial<Session> = {}): Promise<Session> {
  const { identity } = await generateDeviceIdentity()
  return { text: "committed\n", baseSha: "sha-v0", token: "gh-token", identity, passphrase: PASS, ...overrides }
}

interface FixtureResponse {
  status: number
  body: unknown
}

/** The same "METHOD /path" call-recording convention as github-read/write.test.ts,
 * unlock.test.ts and sync.test.ts, including their array-per-key form (consumed in order,
 * holding the last entry once exhausted). Self-contained per this project's test convention. */
function recordingFetch(calls: string[], responses: Record<string, FixtureResponse | FixtureResponse[]>): typeof fetch {
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

/** A `fetch` that never reaches a server -- a plain `TypeError`, which is the shape a real
 * network failure takes and the one thing src/session/sync.ts's `isUnreachable` treats as
 * offline (see its doc comment; confirmed live in this project's Node runtime). */
function fetchThatIsOffline(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed")
  }) as typeof fetch
}

function readHeadFixtures(armored: string, commitSha: string): Record<string, FixtureResponse> {
  return {
    [`GET ${repoPath(`/git/ref/heads/${DATA_BRANCH}`)}`]: { status: 200, body: { object: { sha: commitSha } } },
    [`GET ${repoPath(`/git/commits/${commitSha}`)}`]: { status: 200, body: { sha: commitSha, tree: { sha: `tree-${commitSha}` } } },
    [`GET ${repoPath(`/git/trees/tree-${commitSha}`)}`]: {
      status: 200,
      body: { sha: `tree-${commitSha}`, tree: [{ path: VAULT_PATH, mode: "100644", type: "blob", sha: `blob-${commitSha}` }] },
    },
    [`GET ${repoPath(`/git/blobs/blob-${commitSha}`)}`]: { status: 200, body: { sha: `blob-${commitSha}`, content: btoa(armored) } },
  }
}

function writeFixtures(resultSha: string, refStatus = 200): Record<string, FixtureResponse> {
  return {
    [`GET ${repoPath("")}`]: { status: 200, body: { private: true, permissions: { push: true } } },
    [`POST ${repoPath("/git/blobs")}`]: { status: 201, body: { sha: "new-blob" } },
    [`POST ${repoPath("/git/trees")}`]: { status: 201, body: { sha: "new-tree" } },
    [`POST ${repoPath("/git/commits")}`]: { status: 201, body: { sha: resultSha } },
    [`PATCH ${repoPath(`/git/refs/heads/${DATA_BRANCH}`)}`]: {
      status: refStatus,
      body: refStatus === 200 ? { object: { sha: resultSha } } : { message: "Update is not a fast forward" },
    },
  }
}

function ioWith(fetchImpl: typeof fetch, local = new LocalStore()): SessionIO {
  return { local, makeStore: (token: string) => new GithubStore({ owner: OWNER, repo: REPO, token, fetch: fetchImpl }) }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------------------------
// openDocument -- what the editor shows the moment it mounts (spec §7's draft slot, §13's "not a
// blank screen").
// ---------------------------------------------------------------------------------------------

test("with no draft, the editor opens on the committed text and reports it as committed", async () => {
  const local = new LocalStore()
  const session = await makeSession()
  expect(await openDocument(session, local)).toEqual({ text: "committed\n", dirty: false, notice: null })
})

test("with an uncommitted draft, the editor opens on the DRAFT, not the committed version", async () => {
  // The DOM-free half of "a reload restores the uncommitted draft": autosave is local only
  // (spec §2), so the last thing typed must survive a reload even though GitHub never saw it.
  const local = new LocalStore()
  const session = await makeSession()
  const recipient = await recipientFor(session.identity)
  await local.putDraft({ armored: await encryptToRecipient("typed but never saved\n", recipient), baseSha: "sha-v0", savedAt: 1 })

  expect(await openDocument(session, local)).toEqual({ text: "typed but never saved\n", dirty: true, notice: null })
})

test("a draft whose content equals the committed text is not reported as local-only", async () => {
  const local = new LocalStore()
  const session = await makeSession()
  const recipient = await recipientFor(session.identity)
  await local.putDraft({ armored: await encryptToRecipient("committed\n", recipient), baseSha: "sha-v0", savedAt: 1 })

  const opened = await openDocument(session, local)
  expect(opened.text).toBe("committed\n")
  expect(opened.dirty).toBe(false)
})

test("a draft that will not decrypt falls back to the committed text with a notice, and is never deleted", async () => {
  // spec §13: no state may dead-end and nothing is discarded unseen. A draft encrypted to some
  // other device's identity (or corrupted) must not blank the editor, and must not be silently
  // thrown away either -- the row stays exactly where it was.
  const local = new LocalStore()
  const session = await makeSession()
  const { recipient: someoneElse } = await generateDeviceIdentity()
  const foreign = await encryptToRecipient("unreadable here\n", someoneElse)
  await local.putDraft({ armored: foreign, baseSha: "sha-v0", savedAt: 7 })

  const opened = await openDocument(session, local)
  expect(opened.text).toBe("committed\n")
  expect(opened.dirty).toBe(false)
  expect(opened.notice).toMatch(/could not be read/i)
  expect((await local.getDraft())?.armored).toBe(foreign)
})

// ---------------------------------------------------------------------------------------------
// autosaveDraft -- spec §2's central guarantee ("autosave is local only; GitHub writes are
// explicit") and spec §7's `draft.age` row.
// ---------------------------------------------------------------------------------------------

test("autosave encrypts the text to the device identity and stores it against the session's base", async () => {
  const local = new LocalStore()
  const session = await makeSession({ baseSha: "sha-v3" })

  await autosaveDraft("hello draft\n", session, local)

  const draft = await local.getDraft()
  expect(draft?.baseSha).toBe("sha-v3")
  expect(draft?.armored).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/)
  expect(await decryptWithIdentity(draft!.armored, session.identity)).toBe("hello draft\n")
  // Local only: the passphrase is not what this is encrypted under, and must not be recoverable
  // from it (spec §7's "Passphrase | none -- memory only").
  await expect(decryptVault(draft!.armored, PASS)).rejects.toThrow()
})

test("an autosave that resolves late never clobbers a newer one", async () => {
  // `savedAt` has to be stamped BEFORE the encrypt, not after: encryption takes real time, so
  // two overlapping autosaves can resolve out of order, and LocalStore.putDraft's monotonic
  // guard (src/store/local.ts) can only refuse the older one if the older one actually carries
  // the older timestamp. Stamping after the encrypt would hand the slow, stale call a NEWER
  // timestamp than the keystrokes that overtook it, and destroy them.
  const local = new LocalStore()
  const session = await makeSession()
  const { release, restore } = gateFirstEncrypt()
  try {
    const stale = autosaveDraft("stale keystrokes\n", session, local)
    await sleep(5) // real clock, so the two calls cannot share a millisecond
    await autosaveDraft("newest keystrokes\n", session, local)
    release()
    await stale
  } finally {
    restore()
  }

  const draft = await local.getDraft()
  expect(await decryptWithIdentity(draft!.armored, session.identity)).toBe("newest keystrokes\n")
})

/** Blocks the FIRST `Encrypter.encrypt` call until released, letting a later call overtake it --
 * the same prototype-patch shape as tests/unit/unlock.test.ts's `instrumentScrypt` and
 * tests/unit/setup.test.ts's `instrumentEncrypt`, see those for why the cast is needed. */
function gateFirstEncrypt(): { release: () => void; restore: () => void } {
  const proto = Encrypter.prototype as unknown as { encrypt: (...args: unknown[]) => Promise<unknown> }
  const original = proto.encrypt
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let first = true
  proto.encrypt = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    if (first) {
      first = false
      await gate
    }
    return original.apply(this, args)
  }
  return {
    release: () => release(),
    restore: () => {
      proto.encrypt = original
    },
  }
}

// ---------------------------------------------------------------------------------------------
// commitDocument -- the explicit ⌘/Ctrl+S save (spec §6.4/§6.5/§13), mapped to exactly the
// states the indicator and the Task 15 seam need.
// ---------------------------------------------------------------------------------------------

test("a successful commit reports the new sha, advances the session and clears the draft", async () => {
  const local = new LocalStore()
  const session = await makeSession()
  const io = ioWith(recordingFetch([], writeFixtures("sha-v1")), local)
  await autosaveDraft("about to be saved\n", session, local)

  expect(await commitDocument("about to be saved\n", session, io)).toEqual({ kind: "committed", sha: "sha-v1" })
  expect(session.baseSha).toBe("sha-v1")
  expect(session.text).toBe("about to be saved\n")
  expect(await local.getDraft()).toBeNull()
  expect((await local.getCachedVault())?.sha).toBe("sha-v1")
})

test("a stale commit reports the three-way conflict and keeps the draft (Task 15's seam)", async () => {
  const local = new LocalStore()
  const session = await makeSession({ text: "v0\n" })
  const io = ioWith(
    recordingFetch([], {
      ...writeFixtures("unused", 422),
      ...readHeadFixtures(await encryptVault("theirs\n", PASS), "sha-theirs"),
      // `readAt(baseSha)` walks commit -> tree -> blob for the base the edit started from.
      [`GET ${repoPath("/git/commits/sha-v0")}`]: { status: 200, body: { sha: "sha-v0", tree: { sha: "tree-sha-v0" } } },
      [`GET ${repoPath("/git/trees/tree-sha-v0")}`]: {
        status: 200,
        body: { sha: "tree-sha-v0", tree: [{ path: VAULT_PATH, mode: "100644", type: "blob", sha: "blob-sha-v0" }] },
      },
      [`GET ${repoPath("/git/blobs/blob-sha-v0")}`]: { status: 200, body: { content: btoa(await encryptVault("v0\n", PASS)) } },
    }),
    local,
  )
  await autosaveDraft("mine\n", session, local)
  const draftBefore = await local.getDraft()

  const outcome = await commitDocument("mine\n", session, io)

  expect(outcome.kind).toBe("conflict")
  if (outcome.kind !== "conflict") throw new Error("unreachable: asserted above")
  expect(outcome.conflict).toMatchObject({ base: "v0\n", mine: "mine\n", theirs: "theirs\n" })
  // Nothing is discarded while a conflict is unresolved (spec §6.5): the draft is still there.
  expect(await local.getDraft()).toEqual(draftBefore)
})

test("a commit that cannot reach GitHub is queued, not failed", async () => {
  const local = new LocalStore()
  const session = await makeSession()
  const io = ioWith(fetchThatIsOffline(), local)

  expect(await commitDocument("saved while offline\n", session, io)).toEqual({ kind: "queued" })
  const queue = await local.getPendingCommits()
  expect(queue.length).toBe(1)
  expect(await decryptVault(queue[0].armored, PASS)).toBe("saved while offline\n")
})

test("a commit with no token on this device reports that, without reaching for a store", async () => {
  const local = new LocalStore()
  const session = await makeSession({ token: null })
  const io: SessionIO = {
    local,
    makeStore: () => {
      throw new Error("must not build a store without a token")
    },
  }

  expect(await commitDocument("nowhere to put this\n", session, io)).toEqual({ kind: "no-token" })
})

test("an unexpected GitHub failure is reported with its message, never swallowed", async () => {
  // spec §13: a thrown error with no UI affordance is an incomplete state. `commit` lets every
  // named error class through (only unreachable-ness is queued), so the editor has to turn one
  // into something showable instead of an unhandled rejection.
  const local = new LocalStore()
  const session = await makeSession()
  const io = ioWith(
    recordingFetch([], { [`GET ${repoPath("")}`]: { status: 200, body: { private: false, permissions: { push: true } } } }),
    local,
  )

  const outcome = await commitDocument("blocked\n", session, io)
  expect(outcome.kind).toBe("failed")
  if (outcome.kind !== "failed") throw new Error("unreachable: asserted above")
  expect(outcome.message).toMatch(/private/i)
})

// ---------------------------------------------------------------------------------------------
// syncOnce / drainQueue -- spec §5.3's background sync and §13's "commit queues and retries on
// reconnect", the two things the editor starts on its own rather than on a keystroke.
// ---------------------------------------------------------------------------------------------

test("background sync adopts a newer remote version when nothing local is pending", async () => {
  const local = new LocalStore()
  const session = await makeSession({ text: "v0\n" })
  const io = ioWith(recordingFetch([], readHeadFixtures(await encryptVault("newer from another device\n", PASS), "sha-v9")), local)

  expect(await syncOnce(session, io)).toEqual({ kind: "updated", text: "newer from another device\n" })
  expect(session.baseSha).toBe("sha-v9")
  expect((await local.getCachedVault())?.sha).toBe("sha-v9")
})

test("background sync never touches a local draft; it reports the divergence instead", async () => {
  const local = new LocalStore()
  const session = await makeSession({ text: "v0\n" })
  await autosaveDraft("my own edit\n", session, local)
  const draftBefore = await local.getDraft()
  const io = ioWith(recordingFetch([], readHeadFixtures(await encryptVault("theirs\n", PASS), "sha-v9")), local)

  expect(await syncOnce(session, io)).toEqual({ kind: "diverged" })
  expect(await local.getDraft()).toEqual(draftBefore)
  expect(session.baseSha).toBe("sha-v0")
})

test("background sync that cannot reach GitHub reports offline, not an error", async () => {
  const session = await makeSession()
  expect(await syncOnce(session, ioWith(fetchThatIsOffline()))).toEqual({ kind: "offline" })
})

test("an up-to-date background sync reports unchanged and makes no claim about the text", async () => {
  const local = new LocalStore()
  const session = await makeSession({ baseSha: "sha-v0" })
  const io = ioWith(recordingFetch([], readHeadFixtures(await encryptVault("v0\n", PASS), "sha-v0")), local)
  expect(await syncOnce(session, io)).toEqual({ kind: "unchanged" })
})

test("reconnecting with nothing queued makes no network call at all", async () => {
  const session = await makeSession()
  const calls: string[] = []
  expect(await drainQueue(session, ioWith(recordingFetch(calls, {})))).toEqual({ kind: "nothing-queued" })
  expect(calls).toEqual([])
})

test("reconnecting replays a queued commit and reports how many landed", async () => {
  const local = new LocalStore()
  const session = await makeSession()
  await local.enqueuePendingCommit({ armored: await encryptVault("queued while offline\n", PASS), baseSha: "sha-v0", message: "m" })
  const io = ioWith(recordingFetch([], writeFixtures("sha-v1")), local)

  expect(await drainQueue(session, io)).toEqual({ kind: "committed", count: 1 })
  expect(await local.getPendingCommits()).toEqual([])
  expect(session.baseSha).toBe("sha-v1")
})

test("a replay that conflicts surfaces the conflict rather than retrying forever", async () => {
  const local = new LocalStore()
  const session = await makeSession({ text: "v0\n" })
  await local.enqueuePendingCommit({ armored: await encryptVault("mine\n", PASS), baseSha: "sha-v0", message: "m" })
  const io = ioWith(
    recordingFetch([], {
      ...writeFixtures("unused", 422),
      ...readHeadFixtures(await encryptVault("theirs\n", PASS), "sha-theirs"),
      [`GET ${repoPath("/git/commits/sha-v0")}`]: { status: 200, body: { sha: "sha-v0", tree: { sha: "tree-sha-v0" } } },
      [`GET ${repoPath("/git/trees/tree-sha-v0")}`]: {
        status: 200,
        body: { sha: "tree-sha-v0", tree: [{ path: VAULT_PATH, mode: "100644", type: "blob", sha: "blob-sha-v0" }] },
      },
      [`GET ${repoPath("/git/blobs/blob-sha-v0")}`]: { status: 200, body: { content: btoa(await encryptVault("v0\n", PASS)) } },
    }),
    local,
  )

  const outcome = await drainQueue(session, io)
  expect(outcome.kind).toBe("conflict")
  if (outcome.kind !== "conflict") throw new Error("unreachable: asserted above")
  expect(outcome.conflict).toMatchObject({ base: "v0\n", mine: "mine\n", theirs: "theirs\n" })
})

test("a replay that keeps finding GitHub unreachable eventually says so instead of staying silent", async () => {
  // src/session/sync.ts throws ReplayRepeatedlyUnreachableError at its own retry cap rather than
  // returning the usual silent `unreachable` -- the editor must show that, not crash on it.
  const local = new LocalStore()
  const session = await makeSession()
  const armored = await encryptVault("stuck\n", PASS)
  await local.enqueuePendingCommit({ armored, baseSha: "sha-v0", message: "m" })
  const io = ioWith(fetchThatIsOffline(), local)

  let outcome = await drainQueue(session, io)
  while (outcome.kind === "offline") outcome = await drainQueue(session, io)

  expect(outcome.kind).toBe("failed")
  if (outcome.kind !== "failed") throw new Error("unreachable: asserted above")
  expect(outcome.message).toMatch(/unreachable/i)
  // The edit itself is never discarded at the cap -- only the signal changes.
  expect((await local.getPendingCommits()).length).toBe(1)
})

// ---------------------------------------------------------------------------------------------
// The indicator (spec §8's "persistent indicator of local-vs-committed state") and the
// keystroke-safety rule background sync has to obey.
// ---------------------------------------------------------------------------------------------

test("the indicator distinguishes committed, local-only and offline", async () => {
  expect(indicatorState({ dirty: false, online: true, queued: 0 })).toBe("committed")
  expect(indicatorState({ dirty: true, online: true, queued: 0 })).toBe("local-only")
  // A queued commit is, by definition, not on GitHub yet -- even once the connection is back and
  // before the replay has run.
  expect(indicatorState({ dirty: false, online: true, queued: 1 })).toBe("local-only")
  // Offline outranks both: it explains WHY nothing is reaching GitHub.
  expect(indicatorState({ dirty: false, online: false, queued: 0 })).toBe("offline")
  expect(indicatorState({ dirty: true, online: false, queued: 2 })).toBe("offline")
})

test("every indicator state has its own non-empty label", async () => {
  const states: SaveState[] = ["committed", "local-only", "offline"]
  const labels = states.map(indicatorLabel)
  expect(labels.every((l) => l.trim().length > 0)).toBe(true)
  expect(new Set(labels).size).toBe(states.length)
})

test("a background sync landing mid-keystroke keeps what the user typed", async () => {
  // spec §5.3 updates the editor to a newer remote version "if the local draft is unmodified" --
  // but a keystroke can land during the fetch, before the autosave debounce has written any
  // draft for `syncFromRemote` to see. Adopting the remote text then would delete it from under
  // the cursor.
  expect(adoptSyncedText("untouched\n", "untouched\n", "theirs\n")).toEqual({ text: "theirs\n", adopted: true })
  expect(adoptSyncedText("typed while fetching\n", "untouched\n", "theirs\n")).toEqual({
    text: "typed while fetching\n",
    adopted: false,
  })
})

// ---------------------------------------------------------------------------------------------
// Never two scrypt runs at once (spec §5.4, and this project's own Global Constraint). Unlike
// unlock and setup, this view can start several scrypt-bearing operations from INDEPENDENT
// events -- a keystroke-driven commit, the reconnect handler's replay, the background sync -- so
// serialising them is the only thing keeping peak memory at one run's 128 MiB.
// ---------------------------------------------------------------------------------------------

/** Peak-concurrency instrumentation of `Encrypter.prototype.encrypt`, identical in shape to
 * tests/unit/setup.test.ts's `instrumentEncrypt`. */
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

function peakCounter(): { peak: () => number; restore: () => void } {
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
  return { peak: () => peak, restore }
}

test("two commits fired at once still run their scrypt one at a time", async () => {
  const local = new LocalStore()
  const session = await makeSession()
  const io = ioWith(recordingFetch([], writeFixtures("sha-v1")), local)
  const counter = peakCounter()
  try {
    await Promise.all([commitDocument("a\n", session, io), commitDocument("b\n", session, io)])
  } finally {
    counter.restore()
  }
  expect(counter.peak()).toBe(1)
})

test("a background sync and a commit fired at once still run their scrypt one at a time", async () => {
  const local = new LocalStore()
  const session = await makeSession({ text: "v0\n" })
  const io = ioWith(
    recordingFetch([], { ...writeFixtures("sha-v1"), ...readHeadFixtures(await encryptVault("theirs\n", PASS), "sha-v9") }),
    local,
  )
  const counter = peakCounter()
  try {
    await Promise.all([syncOnce(session, io), commitDocument("mine\n", session, io)])
  } finally {
    counter.restore()
  }
  expect(counter.peak()).toBe(1)
})

test("a concurrent implementation is actually caught (instrumentation sanity check)", async () => {
  // Not a behaviour test -- proof that the two tests above would fail on an unserialised
  // implementation, rather than reading back 1 no matter what runs. Same self-check
  // tests/unit/unlock.test.ts and tests/unit/setup.test.ts each carry.
  const counter = peakCounter()
  try {
    await Promise.all([encryptVault("a", PASS), encryptVault("b", PASS)])
  } finally {
    counter.restore()
  }
  expect(counter.peak()).toBe(2)
})

test("the operation queue runs in order and a rejected operation does not poison the chain", async () => {
  const serialize = createOperationQueue()
  const order: string[] = []
  const first = serialize(async () => {
    await sleep(5)
    order.push("first")
    throw new Error("boom")
  })
  const second = serialize(async () => {
    order.push("second")
    return "ok"
  })

  await expect(first).rejects.toThrow("boom")
  expect(await second).toBe("ok")
  expect(order).toEqual(["first", "second"])
})
