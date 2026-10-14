// Browser-side persistence for everything eigenheim keeps between sessions
// (spec §7): one IndexedDB database, one object store, four fixed slot
// keys. Every slot holds either ciphertext or non-secret metadata -- never
// a secret in the clear. The passphrase itself is never written here, or
// anywhere else: it lives in memory for the session only.
//
// This file has no Node types available (tsconfig.app.json covers `src/`)
// and must stay that way: the real `indexedDB` global, no `node:*`, no
// `Buffer`.

/** Exported so tests can reopen the same physical database and scan its raw
 * contents directly (bypassing this class's own getters) -- see
 * tests/unit/local.test.ts's "no slot ever holds the passphrase". Not
 * otherwise meant to be used by application code, which should go through
 * {@link LocalStore} instead of touching IndexedDB itself. */
export const DB_NAME = "eigenheim"
const DB_VERSION = 1
const STORE_NAME = "slots"

type SlotKey = "wrappedIdentity" | "token" | "draft" | "cachedVault"

/** The in-progress document plus the commit it was last synced against
 * (`baseSha`), and when it was saved -- `savedAt` is what lets
 * {@link LocalStore.putDraft} refuse to let a second tab's stale autosave
 * clobber a newer one (spec review focus 4). `armored` is `draft.age`'s
 * ciphertext, encrypted to the device identity (never the passphrase). */
export interface Draft {
  armored: string
  baseSha: string
  savedAt: number
}

/** The last-known `vault.age` ciphertext and the commit SHA it came from.
 * Caching ciphertext is safe by construction (spec §5.3) -- it is never
 * decrypted until the passphrase is supplied at unlock. */
export interface CachedVault {
  armored: string
  sha: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"))
  })
}

/** Wraps an IDBRequest in a promise that actually settles either way -- a
 * request that only ever resolved on success would leave a store method
 * hanging forever on failure, freezing the editor's autosave with no error. */
function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"))
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"))
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"))
  })
}

/** The browser-side persistence for everything this app keeps between
 * sessions: a wrapped device identity, a GitHub token, an in-progress
 * draft, and a cached vault -- see the module doc comment above and spec §7.
 * One instance per tab; every instance opens the same underlying database,
 * by design -- two tabs on the same device share one IndexedDB (spec review
 * focus 4), which is exactly what {@link putDraft}'s monotonic-write check
 * guards. */
export class LocalStore {
  private dbPromise: Promise<IDBDatabase> | null = null

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb()
    return this.dbPromise
  }

  private async getSlot<T>(key: SlotKey): Promise<T | null> {
    const db = await this.db()
    const tx = db.transaction(STORE_NAME, "readonly")
    const value = await requestToPromise<T | undefined>(tx.objectStore(STORE_NAME).get(key))
    await transactionDone(tx)
    return value ?? null
  }

  private async putSlot(key: SlotKey, value: unknown): Promise<void> {
    const db = await this.db()
    const tx = db.transaction(STORE_NAME, "readwrite")
    tx.objectStore(STORE_NAME).put(value, key)
    await transactionDone(tx)
  }

  async putWrappedIdentity(armored: string): Promise<void> {
    await this.putSlot("wrappedIdentity", armored)
  }

  async getWrappedIdentity(): Promise<string | null> {
    return this.getSlot<string>("wrappedIdentity")
  }

  async putToken(armored: string): Promise<void> {
    await this.putSlot("token", armored)
  }

  async getToken(): Promise<string | null> {
    return this.getSlot<string>("token")
  }

  /** Writes a draft, but never lets an older write clobber a newer one
   * already on disk (spec review focus 4: two tabs on one device share this
   * database and both autosave here). The read of the stored `savedAt` and
   * the conditional write must happen inside the SAME readwrite
   * transaction: IndexedDB serializes overlapping-scope transactions in the
   * order they were created, so a second call's read-inside-its-own-
   * transaction is guaranteed to observe a first call's already-committed
   * write before deciding. Splitting the read into its own transaction
   * (read in tx1, decide in JS, write in tx2) reopens exactly the race this
   * exists to prevent -- two concurrent calls could each read "nothing
   * newer yet" before either has written, and then both proceed to write,
   * leaving the outcome to whichever write transaction happens to commit
   * last. Verified empirically (not just reasoned about), via a standalone
   * script against this project's exact fake-indexeddb version, firing two
   * concurrent calls (no await between them, joined with Promise.all) 200
   * times each: a two-transaction implementation picked the older write
   * 200/200 times; this single-transaction version picked the newer write
   * 200/200 times. tests/unit/local.test.ts's own race test uses the same
   * no-await-then-Promise.all firing pattern, repeated 10x per run, and was
   * separately confirmed (by temporarily swapping in a two-transaction
   * `putDraft`) to fail reliably against that version too. */
  async putDraft(d: Draft): Promise<void> {
    const db = await this.db()
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    const existing = await requestToPromise<Draft | undefined>(store.get("draft"))
    if (!existing || d.savedAt >= existing.savedAt) {
      store.put(d, "draft")
    }
    await transactionDone(tx)
  }

  async getDraft(): Promise<Draft | null> {
    return this.getSlot<Draft>("draft")
  }

  async putCachedVault(c: CachedVault): Promise<void> {
    await this.putSlot("cachedVault", c)
  }

  async getCachedVault(): Promise<CachedVault | null> {
    return this.getSlot<CachedVault>("cachedVault")
  }

  async clear(): Promise<void> {
    const db = await this.db()
    const tx = db.transaction(STORE_NAME, "readwrite")
    tx.objectStore(STORE_NAME).clear()
    await transactionDone(tx)
  }
}
