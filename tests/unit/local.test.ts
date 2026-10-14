import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import "fake-indexeddb/auto"
import { LocalStore, DB_NAME, type Draft, type CachedVault } from "../../src/store/local"
import { generateDeviceIdentity, wrapIdentity } from "../../src/vault/identity"
import { encryptToRecipient } from "../../src/vault/crypto"

async function readFixture(name: string): Promise<string> {
  return readFile(resolve(import.meta.dirname, "../fixtures", name), "utf8")
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

  const draft: Draft = { armored: "draft-armor", baseSha: "base-sha-1", savedAt: 1000 }
  const cached: CachedVault = { armored: "vault-armor", sha: "vault-sha-1" }
  await store.putWrappedIdentity("wrapped-identity-armor")
  await store.putToken("token-armor")
  await store.putDraft(draft)
  await store.putCachedVault(cached)

  expect(await store.getWrappedIdentity()).toBe("wrapped-identity-armor")
  expect(await store.getToken()).toBe("token-armor")
  expect(await store.getDraft()).toEqual(draft)
  expect(await store.getCachedVault()).toEqual(cached)
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
  // here, not a coin flip.
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

test("clear() removes every slot", async () => {
  const store = new LocalStore()
  await store.putWrappedIdentity("wrapped-identity-armor")
  await store.putToken("token-armor")
  await store.putDraft({ armored: "draft-armor", baseSha: "base-sha-3", savedAt: 1 })
  await store.putCachedVault({ armored: "vault-armor", sha: "vault-sha-3" })

  await store.clear()

  expect(await store.getWrappedIdentity()).toBeNull()
  expect(await store.getToken()).toBeNull()
  expect(await store.getDraft()).toBeNull()
  expect(await store.getCachedVault()).toBeNull()
})
