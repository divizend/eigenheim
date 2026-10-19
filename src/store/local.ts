// Browser-side persistence for everything eigenheim keeps between sessions
// (spec §7): one IndexedDB database, one object store, five fixed slot
// keys. Every slot holds either ciphertext or non-secret metadata -- never
// a secret in the clear. The passphrase itself is never written here, or
// anywhere else: it lives in memory for the session only.
//
// This file has no Node types available (tsconfig.app.json covers `src/`)
// and must stay that way: the real `indexedDB` global, no `node:*`, no
// `Buffer`.

import { PendingQueueFullError } from "./errors"

/** Exported so tests can reopen the same physical database and scan its raw
 * contents directly (bypassing this class's own getters) -- see
 * tests/unit/local.test.ts's "no slot ever holds the passphrase". Not
 * otherwise meant to be used by application code, which should go through
 * {@link LocalStore} instead of touching IndexedDB itself. */
export const DB_NAME = "eigenheim"
const DB_VERSION = 1
const STORE_NAME = "slots"

type SlotKey = "wrappedIdentity" | "token" | "draft" | "cachedVault" | "pendingCommits"

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

/** A commit attempted while GitHub could not be reached (offline, or any failure this app has
 * no specific recovery story for), held until the next successful retry -- spec §13's "editing
 * continues; commit queues and retries on reconnect" (src/session/sync.ts owns deciding when
 * that is and what to do with the result, including replay). `armored` is already the FINAL
 * `vault.age` ciphertext for this attempt -- encrypted with the vault passphrase, exactly what
 * `GithubStore.write`'s own `armored` parameter needs -- never the plaintext and never the
 * passphrase, consistent with every other slot in this file: nothing here is ever a secret in
 * the clear. `baseSha`/`message` are the rest of what that same call needs to retry the exact
 * same attempt unchanged once connectivity returns. `attempts` -- how many consecutive times a
 * replay of this exact entry has failed as unreachable -- is src/session/sync.ts's own bounded
 * retry bookkeeping (mirroring GithubStore's own rate-limit retry count), not anything this
 * file interprets. This file has no dependency on src/store/github.ts and shouldn't gain one
 * just for this doc comment -- hence the plain prose reference instead of a `{@link}`. */
export interface PendingCommit {
  armored: string
  baseSha: string
  message: string
  attempts: number
}

/** Bounded capacity for the pending-commit queue (below) -- generous for any realistic amount
 * of offline editing (a single small text file, saved by an explicit Ctrl+S), but a real bound
 * rather than none: a cap with an explicit, loud {@link PendingQueueFullError} (src/store/
 * errors.ts -- review round 2 moved it there alongside this app's other named failure modes,
 * so Task 19's exhaustive affordance test actually covers it; see that file's own header
 * comment for why its default message carries no number, and why putting the number there
 * would create a circular import between this file and that one) is what review round 1
 * (Critical 1) replaced "replace the queue" with, specifically so an enqueue can never
 * silently drop an edit instead of refusing outright. */
export const MAX_PENDING_COMMITS = 50

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
 * draft, a cached vault, and a queue of offline commits -- see the module doc
 * comment above and spec §7.
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

  /** Removes the in-progress draft once it is no longer ahead of the committed vault --
   * {@link putDraft}'s own counterpart cannot express this, since {@link Draft} has no
   * optional fields and so no way to `put` "nothing is pending" through that method. Called
   * only after a commit genuinely reaches GitHub (src/session/sync.ts's `commit` and
   * `replayPendingCommits`, both on success): from that point {@link getCachedVault} and the
   * just-committed text agree, so there is no separate local-only state left to track until
   * the next edit writes a new draft. A plain key delete, not a write of some null-ish
   * sentinel value through {@link putDraft} -- {@link Draft}'s fields are all required, so a
   * sentinel would need its own special-cased shape, while deleting the key needs none and
   * leaves {@link getDraft} correctly reporting `null` (its existing "absent" behaviour, see
   * `getSlot`) with no new case for it to handle. */
  async clearDraft(): Promise<void> {
    const db = await this.db()
    const tx = db.transaction(STORE_NAME, "readwrite")
    tx.objectStore(STORE_NAME).delete("draft")
    await transactionDone(tx)
  }

  async putCachedVault(c: CachedVault): Promise<void> {
    await this.putSlot("cachedVault", c)
  }

  /** Replaces BOTH passphrase-protected slots in ONE transaction, for a passphrase rotation
   * (task 17).
   *
   * Two separate `putSlot` calls would not do, and the reason is specific rather than general
   * caution: `device.age` and `vault.age` are the only two things on this device encrypted under
   * the PASSPHRASE (`token.age` and `draft.age` are encrypted to the device identity instead, so
   * a passphrase change does not touch them). If a rotation updated one and not the other, the
   * device would hold two slots under two different passphrases, and no single passphrase would
   * open both -- `src/session/unlock.ts` decrypts the cached vault first and unwraps the identity
   * second, so the user would get their text but never their token, and recovering the token
   * needs the identity, which needs the passphrase that no longer opens it. A circular dead end,
   * in a project whose whole design has no recovery key.
   *
   * One transaction removes the state rather than documenting it: IndexedDB aborts the whole
   * transaction if any write in it fails, so the pair moves together or not at all. Same
   * single-transaction discipline as {@link putDraft} and {@link enqueuePendingCommit}, for the
   * same reason -- a partial write here is not recoverable by retrying. */
  async putRotatedPassphraseSlots(next: { wrappedIdentity: string; cachedVault: CachedVault }): Promise<void> {
    const db = await this.db()
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    store.put(next.cachedVault, "cachedVault")
    store.put(next.wrappedIdentity, "wrappedIdentity")
    await transactionDone(tx)
  }

  async getCachedVault(): Promise<CachedVault | null> {
    return this.getSlot<CachedVault>("cachedVault")
  }

  /** Appends a new commit attempt to the offline queue -- see {@link PendingCommit}. **An
   * append-only list, replayed oldest-first, never coalesced** -- review round 1 (Critical 1)
   * overturned this task's original single-slot design after a live reproduction: two tabs on
   * the same device (Review Focus 4's own threat model) can each independently go offline from
   * the SAME base, each queuing its own edit without ever having seen the other's -- "A" from
   * tab 1, then "B" from tab 2, both based on the identical `baseSha`. A single slot's own
   * unconditional overwrite made "B" silently destroy "A" with no trace in any other slot (not
   * the draft -- `commit` never writes one -- not the cached vault -- the write never
   * succeeded). The original justification ("every commit carries the full text, so a newer
   * attempt supersedes an older one") is true for ONE continuous editing stream but false
   * across two tabs that diverged from the same base without either seeing the other's change
   * -- there is no text-level relationship between "A" and "B" at all, let alone one
   * superseding the other. Two narrower fixes were considered and rejected (coordinator's own
   * ruling): merging the two entries needs the base TEXT, and offline is exactly when a
   * differing `baseSha`'s base may be unfetchable; coalescing only when `baseSha` happens to
   * match reintroduces the same "these two must be equivalent" reasoning that failed here.
   * Keeping both, replayed in order, is what the rest of this design already has a safe answer
   * for: a later one that turns out to conflict with an earlier one's own successful replay
   * goes through the ordinary three-way-merge conflict path, same as any other stale write.
   *
   * The read-current-length-then-append happens inside ONE readwrite transaction, matching
   * {@link putDraft}'s own reasoning exactly (two tabs enqueueing "simultaneously" is the same
   * shape of race `putDraft`'s own monotonic-write guard exists for, just append-don't-merge
   * instead of keep-the-larger-savedAt) -- IndexedDB's transaction mutual exclusion guarantees
   * the second transaction's read observes the first's already-committed append, so neither
   * tab's entry is ever lost to the other, regardless of which one's transaction happens to run
   * first.
   *
   * Throws {@link PendingQueueFullError} at {@link MAX_PENDING_COMMITS} rather than silently
   * dropping the new entry (or evicting the oldest) -- a cap with a loud, named failure is what
   * this review round added once "just keep everything forever" was no longer the brief's own
   * stated single-slot simplicity. */
  async enqueuePendingCommit(p: { armored: string; baseSha: string; message: string }): Promise<void> {
    const db = await this.db()
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    const existing = (await requestToPromise<PendingCommit[] | undefined>(store.get("pendingCommits"))) ?? []
    if (existing.length >= MAX_PENDING_COMMITS) {
      await transactionDone(tx)
      throw new PendingQueueFullError(
        `the offline commit queue is full (${MAX_PENDING_COMMITS}) -- reconnect to let it drain before saving again`,
      )
    }
    store.put([...existing, { ...p, attempts: 0 }], "pendingCommits")
    await transactionDone(tx)
  }

  /** The full offline-commit queue, oldest first (append order) -- empty, never `null`, when
   * nothing is queued, since "a list with nothing in it" is the natural empty state for a list
   * (unlike the single-item slots elsewhere in this file, where `null` means "absent"). */
  async getPendingCommits(): Promise<PendingCommit[]> {
    return (await this.getSlot<PendingCommit[]>("pendingCommits")) ?? []
  }

  /** Removes the front (oldest) entry once it no longer needs replaying -- either because it
   * was just written for real (src/session/sync.ts, on success), or because replaying it
   * surfaced a genuine conflict there: once shown to the user as a conflict it is "a real
   * answer, not a transient failure" (this task's own brief) and must never be replayed
   * verbatim again on a later reconnect -- the user's chosen resolution becomes a brand new,
   * ordinary commit instead, not a retry of this one.
   *
   * `expected` is the exact entry the caller just finished attempting (matched by `armored`
   * and `baseSha`, which together are unique in practice -- two genuinely different edits never
   * encrypt to the same ciphertext). Removing by VALUE rather than blindly slicing off whatever
   * is currently at index 0 is deliberate: if something else already mutated the front of the
   * queue since this caller read it (another tab's own concurrent replay of the same entry --
   * not a scenario this review round's own two reproductions needed, but one line of defence
   * is cheap given how expensive the single-slot version's equivalent blind-overwrite turned
   * out to be), this becomes a safe no-op instead of removing the wrong thing. Same
   * single-transaction read-then-write shape as {@link enqueuePendingCommit}/
   * {@link recordPendingCommitAttemptFailed}, for the same reason. */
  async dequeueOldestPendingCommit(expected: { armored: string; baseSha: string }): Promise<void> {
    const db = await this.db()
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    const existing = (await requestToPromise<PendingCommit[] | undefined>(store.get("pendingCommits"))) ?? []
    if (existing.length > 0 && existing[0].armored === expected.armored && existing[0].baseSha === expected.baseSha) {
      store.put(existing.slice(1), "pendingCommits")
    }
    await transactionDone(tx)
  }

  /** Increments the front entry's `attempts` counter (src/session/sync.ts's bounded-replay
   * bookkeeping, mirroring GithubStore's own rate-limit retry count) and persists it -- same
   * value-matched, single-transaction safety as {@link dequeueOldestPendingCommit}, and for the
   * same reason. Returns the resulting count, or `null` if `expected` no longer matched the
   * front entry (so a caller never trusts a number that was not actually the one just
   * persisted). The entry is NEVER removed here, no matter how high the count climbs -- only
   * {@link dequeueOldestPendingCommit} ever removes anything, so a repeatedly-failing replay
   * degrades to "stop retrying silently and say so" (sync.ts's own cap), never to "give up and
   * discard the edit". */
  async recordPendingCommitAttemptFailed(expected: { armored: string; baseSha: string }): Promise<number | null> {
    const db = await this.db()
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    const existing = (await requestToPromise<PendingCommit[] | undefined>(store.get("pendingCommits"))) ?? []
    if (existing.length === 0 || existing[0].armored !== expected.armored || existing[0].baseSha !== expected.baseSha) {
      await transactionDone(tx)
      return null
    }
    const attempts = existing[0].attempts + 1
    store.put([{ ...existing[0], attempts }, ...existing.slice(1)], "pendingCommits")
    await transactionDone(tx)
    return attempts
  }

  async clear(): Promise<void> {
    const db = await this.db()
    const tx = db.transaction(STORE_NAME, "readwrite")
    tx.objectStore(STORE_NAME).clear()
    await transactionDone(tx)
  }
}
