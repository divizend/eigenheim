import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import "fake-indexeddb/auto"
import {
  LocalStore,
  DB_NAME,
  MAX_PENDING_COMMITS,
  PendingQueueFullError,
  type Draft,
  type CachedVault,
  type PendingCommit,
} from "../../src/store/local"
import { generateDeviceIdentity, wrapIdentity } from "../../src/vault/identity"
import { encryptToRecipient } from "../../src/vault/crypto"

async function readFixture(name: string): Promise<string> {
  return readFile(resolve(import.meta.dirname, "../fixtures", name), "utf8")
}

/** Awaits `promise` and returns whatever it threw, or `undefined` if it
 * resolved without throwing. Used instead of bare `.rejects.toThrow()` to
 * assert the actual error's identity (constructor + `name`), not merely
 * that *some* error occurred -- a bare "it rejected" assertion would also
 * pass if the rejection started coming from an unrelated cause, which is
 * the opposite of what a regression test should do. */
async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (err) {
    return err
  }
}

/** Opens the same physical database LocalStore uses and returns every
 * [key, value] pair in every one of its object stores -- a raw scan of what
 * actually sits in storage, independent of (and not routed through)
 * LocalStore's own getters, which is the point: this is the only way to
 * catch a slot that holds the passphrase even if some getter happened to
 * mask it. */
async function dumpAll(): Promise<Array<{ store: string; key: IDBValidKey; value: unknown }>> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const rows: Array<{ store: string; key: IDBValidKey; value: unknown }> = []
  for (const storeName of Array.from(db.objectStoreNames)) {
    const tx = db.transaction(storeName, "readonly")
    await new Promise<void>((resolve, reject) => {
      const cursorReq = tx.objectStore(storeName).openCursor()
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor) {
          resolve()
          return
        }
        rows.push({ store: storeName, key: cursor.key, value: cursor.value })
        cursor.continue()
      }
      cursorReq.onerror = () => reject(cursorReq.error)
    })
  }
  db.close()
  return rows
}

// fake-indexeddb's `indexedDB` is one global for the whole process, so
// without resetting it, state written by one test would leak into the
// next -- in particular "absent before first write" below would only be
// true the first time the suite runs, not on every run. LocalStore's own
// clear() is sufficient and keeps this file from reaching into local.ts's
// internals just to reset state between tests.
beforeEach(async () => {
  await new LocalStore().clear()
})

test("each slot round-trips and is absent before first write", async () => {
  const store = new LocalStore()
  expect(await store.getWrappedIdentity()).toBeNull()
  expect(await store.getToken()).toBeNull()
  expect(await store.getDraft()).toBeNull()
  expect(await store.getCachedVault()).toBeNull()
  expect(await store.getPendingCommits()).toEqual([])

  const draft: Draft = { armored: "draft-armor", baseSha: "base-sha-1", savedAt: 1000 }
  const cached: CachedVault = { armored: "vault-armor", sha: "vault-sha-1" }
  await store.putWrappedIdentity("wrapped-identity-armor")
  await store.putToken("token-armor")
  await store.putDraft(draft)
  await store.putCachedVault(cached)
  await store.enqueuePendingCommit({ armored: "pending-armor", baseSha: "base-sha-1", message: "save" })

  expect(await store.getWrappedIdentity()).toBe("wrapped-identity-armor")
  expect(await store.getToken()).toBe("token-armor")
  expect(await store.getDraft()).toEqual(draft)
  expect(await store.getCachedVault()).toEqual(cached)
  const pending: PendingCommit = { armored: "pending-armor", baseSha: "base-sha-1", message: "save", attempts: 0 }
  expect(await store.getPendingCommits()).toEqual([pending])
})

test("enqueuePendingCommit appends -- it never overwrites an existing unreplayed entry", async () => {
  // Review round 1, Critical 1's own fix: a single slot's bare overwrite let a second queued
  // commit silently destroy a first one from a different tab that never saw it (see
  // sync.test.ts's own reproduction for the full scenario). The list itself, at the storage
  // layer, is what this test pins: enqueuing twice must grow the list, not replace its one
  // element.
  const store = new LocalStore()
  await store.enqueuePendingCommit({ armored: "A", baseSha: "s", message: "m1" })
  await store.enqueuePendingCommit({ armored: "B", baseSha: "s", message: "m2" })

  const queue = await store.getPendingCommits()
  expect(queue.map((p) => p.armored)).toEqual(["A", "B"])
})

test("enqueuePendingCommit refuses past the cap with a named error, never silently dropping anything", async () => {
  const store = new LocalStore()
  for (let i = 0; i < MAX_PENDING_COMMITS; i++) {
    await store.enqueuePendingCommit({ armored: `entry-${i}`, baseSha: "s", message: "m" })
  }
  expect((await store.getPendingCommits()).length).toBe(MAX_PENDING_COMMITS)

  await expect(store.enqueuePendingCommit({ armored: "one-too-many", baseSha: "s", message: "m" })).rejects.toThrow(
    PendingQueueFullError,
  )
  // Refused, not silently dropped -- the queue is unchanged, not missing its oldest entry
  // either.
  const queue = await store.getPendingCommits()
  expect(queue.length).toBe(MAX_PENDING_COMMITS)
  expect(queue[0].armored).toBe("entry-0")
})

test("dequeueOldestPendingCommit removes only the matching front entry, leaving the rest", async () => {
  const store = new LocalStore()
  await store.enqueuePendingCommit({ armored: "A", baseSha: "s", message: "m1" })
  await store.enqueuePendingCommit({ armored: "B", baseSha: "s", message: "m2" })

  await store.dequeueOldestPendingCommit({ armored: "A", baseSha: "s" })

  expect((await store.getPendingCommits()).map((p) => p.armored)).toEqual(["B"])
})

test("dequeueOldestPendingCommit is a safe no-op when the front entry no longer matches", async () => {
  // Defence in depth against a concurrent mutation (another tab's own replay) having already
  // changed the front of the queue -- removing by value, not blindly by index, means a stale
  // caller can never remove the wrong entry.
  const store = new LocalStore()
  await store.enqueuePendingCommit({ armored: "A", baseSha: "s", message: "m1" })

  await store.dequeueOldestPendingCommit({ armored: "not-the-real-front", baseSha: "s" })

  expect((await store.getPendingCommits()).map((p) => p.armored)).toEqual(["A"])
})

test("recordPendingCommitAttemptFailed increments the front entry's attempts and returns the new count", async () => {
  const store = new LocalStore()
  await store.enqueuePendingCommit({ armored: "A", baseSha: "s", message: "m1" })

  expect(await store.recordPendingCommitAttemptFailed({ armored: "A", baseSha: "s" })).toBe(1)
  expect(await store.recordPendingCommitAttemptFailed({ armored: "A", baseSha: "s" })).toBe(2)
  expect((await store.getPendingCommits())[0].attempts).toBe(2)
})

test("recordPendingCommitAttemptFailed returns null and changes nothing when the entry no longer matches", async () => {
  const store = new LocalStore()
  await store.enqueuePendingCommit({ armored: "A", baseSha: "s", message: "m1" })

  expect(await store.recordPendingCommitAttemptFailed({ armored: "not-the-real-front", baseSha: "s" })).toBeNull()
  expect((await store.getPendingCommits())[0].attempts).toBe(0)
})

test("clearDraft removes only the draft, leaving the rest of the store untouched", async () => {
  // Draft has no optional field, so it cannot be "cleared" through its own putter (there is no
  // value meaning "nothing pending") -- this dedicated delete is what src/session/sync.ts
  // relies on instead. Proven alongside another untouched slot, so a delete that accidentally
  // reached the wrong key (or wiped the whole store, like clear() deliberately does) would be
  // caught here.
  const store = new LocalStore()
  await store.putWrappedIdentity("wrapped-identity-armor")
  await store.putDraft({ armored: "draft-armor", baseSha: "s", savedAt: 1 })

  await store.clearDraft()

  expect(await store.getDraft()).toBeNull()
  expect(await store.getWrappedIdentity()).toBe("wrapped-identity-armor")
})

test("no slot ever holds the passphrase", async () => {
  // Amendment 1 / plan ruling R4: the real setup wizard doesn't exist until
  // Task 13. Every slot is written here through LocalStore's own API
  // instead, using real artifacts from crypto.ts/identity.ts (Tasks 2-3) --
  // the property under test ("no slot holds the passphrase") belongs to
  // LocalStore, not to the wizard, which gets its own end-to-end coverage
  // later.
  const rawPassphrase = await readFixture("PASSPHRASE")
  const passphrase = rawPassphrase.trim()

  const { identity, recipient } = await generateDeviceIdentity()
  const wrappedIdentity = await wrapIdentity(identity, passphrase)
  const tokenArmor = await encryptToRecipient("github_pat_11AAAAAAA0exampletoken", recipient)
  const draftArmor = await encryptToRecipient("draft plaintext, never the passphrase", recipient)

  const store = new LocalStore()
  await store.putWrappedIdentity(wrappedIdentity)
  await store.putToken(tokenArmor)
  await store.putDraft({ armored: draftArmor, baseSha: "base-sha-2", savedAt: 1 })
  await store.putCachedVault({ armored: "already-ciphertext-vault-blob", sha: "vault-sha-2" })
  // Task 12's new slot: a queued offline commit is exactly as ciphertext-only as the other
  // four, so it gets the same regression guard rather than being left uncovered by this test
  // just because it was added later.
  const pendingArmor = await encryptToRecipient("pending commit plaintext, never the passphrase", recipient)
  await store.enqueuePendingCommit({ armored: pendingArmor, baseSha: "base-sha-2", message: "save" })

  const serialized = JSON.stringify(await dumpAll())
  expect(serialized).not.toContain(passphrase)
  // Guards the untrimmed fixture too, in case of incidental surrounding
  // whitespace -- the thing that must never appear is the secret itself,
  // in any form it could have been typed.
  expect(serialized).not.toContain(rawPassphrase)
})

test("a second tab does not overwrite a newer draft with an older one", async () => {
  // Review focus 4. The naive way to write this test -- awaiting each
  // putDraft call in turn -- never actually races: by the time the second
  // call starts, the first's transaction has already committed, so even a
  // buggy implementation that reads the existing savedAt in a SEPARATE
  // transaction from its write would already observe the committed "new"
  // draft and correctly skip -- passing for the wrong reason. To actually
  // exercise the race deterministically (not by luck of timing), both
  // calls are started without awaiting between them and only joined
  // afterwards, repeated several times to rule out a one-off fluke.
  //
  // Verified empirically against this exact fake-indexeddb version with a
  // throwaway probe before writing this test: a same-transaction
  // (read-then-write, one tx) implementation won 200/200 such races; a
  // two-transaction (read in tx1, write in tx2) implementation lost
  // 200/200 -- i.e. this firing pattern is a deterministic discriminator
  // here, not a coin flip. That determinism comes from IndexedDB's
  // transaction atomicity/mutual exclusion (whichever transaction runs
  // first, the other's read observes it as already-committed) plus this
  // store's merge rule being commutative (keep the larger savedAt) -- NOT
  // from any guaranteed creation-order scheduling, which IndexedDB does
  // not promise. See putDraft's own doc comment in src/store/local.ts for
  // the full reasoning.
  // Each iteration writes the same two fixed (armored, savedAt) pairs to
  // the same "draft" key, so it is self-contained regardless of what a
  // previous iteration left behind -- no reset needed between them.
  for (let i = 0; i < 10; i++) {
    const a = new LocalStore()
    const b = new LocalStore()
    await Promise.all([
      a.putDraft({ armored: "new", baseSha: "s", savedAt: 2000 }),
      b.putDraft({ armored: "old", baseSha: "s", savedAt: 1000 }),
    ])
    expect((await a.getDraft())!.armored).toBe("new")
  }
})

// Task 6 review item 1: "I could not find a way to test it" and "it is not
// testable" are different claims -- the original report asserted the
// second while having established only the first. A value that
// type-checks solely via a cast through `unknown` but is not
// structured-cloneable (a function) goes straight through the existing
// public setters, with no test-only hook needed, and IndexedDB itself
// rejects the write with a DataCloneError. This is the real,
// non-contrived way to prove a store method actually rejects instead of
// hanging forever -- which matters because a method that never settled
// would freeze the editor's autosave with no error.
//
// Fix round 2: tightened from a bare `.rejects.toThrow()` (which would
// also pass if the rejection ever started coming from some unrelated
// cause) to asserting the actual error identity -- a DOMException named
// "DataCloneError" -- so the test fails loudly if the real behaviour
// drifts instead of quietly continuing to pass.
test("putDraft rejects with a DataCloneError, not just any error, when given a non-cloneable value", async () => {
  // The non-cloneable value goes in `armored`, not `savedAt`: `savedAt`
  // now has its own dedicated finite-number validation (fix round 2, item
  // 2 below), which would intercept a non-numeric `savedAt` before the
  // clone ever runs -- that is a real and separately-tested path, but it
  // is NOT this test's subject, so `savedAt` here is a plain valid number.
  const store = new LocalStore()
  const caught = await catchError(
    store.putDraft({ armored: (() => {}) as unknown as string, baseSha: "y", savedAt: 123 }),
  )
  expect(caught).toBeInstanceOf(DOMException)
  expect((caught as DOMException).name).toBe("DataCloneError")
})

test("putToken also rejects with a DataCloneError when given a non-cloneable value", async () => {
  // Same shape against a different setter -- one that takes a bare string
  // rather than an object -- so the coverage is not specific to putDraft's
  // particular argument shape.
  const store = new LocalStore()
  const caught = await catchError(store.putToken((() => {}) as unknown as string))
  expect(caught).toBeInstanceOf(DOMException)
  expect((caught as DOMException).name).toBe("DataCloneError")
})

test("putDraft rejects a non-numeric savedAt instead of silently skipping the write", async () => {
  // Task 6 review item 2: the guard `!existing || d.savedAt >= existing.savedAt`
  // is simply `false` when `d.savedAt` is not a number and a draft with a
  // real numeric savedAt already exists -- so, unvalidated, this would
  // resolve normally having written nothing and thrown nothing. Silent
  // data loss: the user's keystrokes dropped with no error shown. This
  // must reject instead, and must leave the existing draft untouched.
  const store = new LocalStore()
  const goodDraft: Draft = { armored: "real-draft", baseSha: "s", savedAt: 123 }
  await store.putDraft(goodDraft)

  await expect(
    store.putDraft({ armored: "bad", baseSha: "s", savedAt: (() => {}) as unknown as number }),
  ).rejects.toThrow(/savedAt/i)

  expect(await store.getDraft()).toEqual(goodDraft)
})

test("clear() removes every slot", async () => {
  const store = new LocalStore()
  await store.putWrappedIdentity("wrapped-identity-armor")
  await store.putToken("token-armor")
  await store.putDraft({ armored: "draft-armor", baseSha: "base-sha-3", savedAt: 1 })
  await store.putCachedVault({ armored: "vault-armor", sha: "vault-sha-3" })
  await store.enqueuePendingCommit({ armored: "pending-armor", baseSha: "base-sha-3", message: "save" })

  await store.clear()

  expect(await store.getWrappedIdentity()).toBeNull()
  expect(await store.getToken()).toBeNull()
  expect(await store.getDraft()).toBeNull()
  expect(await store.getCachedVault()).toBeNull()
  expect(await store.getPendingCommits()).toEqual([])
})
