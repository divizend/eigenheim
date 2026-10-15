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
   * the conditional write happen inside the SAME readwrite transaction.
   *
   * `d.savedAt` is validated as a finite number before anything else runs
   * (before the transaction opens, before the comparison, before the
   * clone). Without this, a non-numeric `savedAt` reaching this method
   * would make `d.savedAt >= existing.savedAt` simply evaluate to `false`
   * against any existing draft with a real numeric `savedAt` (confirmed:
   * `(() => {}) >= 123` is `false`, not a thrown `TypeError`) -- so the
   * method would resolve normally, having written nothing and thrown
   * nothing. That is silent data loss (the user's keystrokes dropped with
   * no error shown), not a safely-rejected bad call, and it is exactly the
   * failure class the monotonic-write guard below exists to prevent,
   * arriving by a different door. The other four slot setters
   * (`putWrappedIdentity`/`putToken`/`putCachedVault`, and `clear`) have no
   * equivalent risk: none of them gates a write behind a comparison on
   * caller-supplied data, so there is nothing for a malformed argument to
   * silently short-circuit -- a bad value there either clones and is
   * stored as-is (unconditional put, same as a valid value would be) or
   * fails to clone and rejects loudly (see the DataCloneError tests),
   * never a silent no-op.
   *
   * What the monotonic-write guard itself actually rests on is plain
   * atomicity and mutual exclusion:
   * every conformant IndexedDB engine guarantees that two transactions
   * with overlapping scope (here, both readwrite on the same object store)
   * never interleave below transaction granularity -- one fully commits
   * (or aborts) before the other's requests begin executing. So whichever
   * of two concurrent putDraft calls happens to execute first, the other's
   * read -- inside its own transaction -- is guaranteed to observe that
   * already-committed result before deciding.
   *
   * This is deliberately NOT a claim that IndexedDB schedules overlapping
   * transactions in creation order -- it makes no such promise, and
   * nothing here controls or observes which of two independently-opened
   * connections "goes first". What actually makes the result
   * order-independent is that the merge rule itself -- keep the larger
   * `savedAt`, ties go to whichever write applies second -- is
   * commutative: swapping which of the two transactions happens to run
   * first still yields the same max(savedAt) outcome (an exact tie only
   * changes which value wins, a case the strictly-different savedAt
   * values in the test below never exercises). A future change to a
   * non-commutative merge rule would need an actual ordering guarantee
   * this method does not currently have.
   *
   * Splitting the read into its own transaction (read in tx1, decide in
   * JS, write in tx2) reopens exactly the race this exists to prevent: two
   * concurrent calls could each read "nothing newer yet" before either has
   * committed, and both would then proceed to write -- leaving the final
   * state to whichever write transaction happens to commit last, with no
   * interleaved read left for the commutative merge rule to rescue.
   * Verified empirically (not just reasoned about): a standalone script
   * against this project's exact fake-indexeddb version, firing two
   * concurrent calls (no await between them, joined with Promise.all) 200
   * times each, found this single-transaction version picked the newer
   * write 200/200 times, while a two-transaction variant picked the older
   * write 200/200 times. tests/unit/local.test.ts's own race test uses the
   * same firing pattern, repeated 10x per run, and was separately
   * confirmed (by temporarily swapping in that same two-transaction
   * `putDraft`) to fail reliably against this file's real test too, not
   * just the standalone script. */
  async putDraft(d: Draft): Promise<void> {
    if (!Number.isFinite(d.savedAt)) {
      throw new Error(`putDraft: savedAt must be a finite number, got ${String(d.savedAt)}`)
    }
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
