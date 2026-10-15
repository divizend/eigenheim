// Background sync and the commit queue (spec §5.3's "Background sync", §6.5's conflict
// resolution, §13's "Offline: editing continues; commit queues and retries on reconnect").
// This is the one place the project's central promise is kept or broken: GitHub's own
// `force: false` (src/store/github.ts's `write`) refuses any save whose parent is not the
// current branch tip, surfacing as `StaleWriteError`. Everything below exists to turn that
// refusal into a three-way merge the user resolves by hand, never a silent overwrite and never
// a silent discard.
//
// This file has no Node types available (tsconfig.app.json covers `src/`) and must stay that
// way -- nothing here needs anything beyond plain JS/TS, so this is automatic, not a constraint
// that took any work to satisfy.

import type { Session } from "./unlock"
import type { GithubStore } from "../store/github"
// `Draft`/`PendingCommit` are imported only so the doc comments below can `{@link}` them --
// neither is written out as an explicit type annotation anywhere in this file, since every
// local inferred from LocalStore's own getters already has the right shape.
import type { LocalStore, Draft, PendingCommit } from "../store/local"
import { StaleWriteError, ALL_ERROR_CLASSES } from "../store/errors"
import { decryptVault, encryptVault } from "../vault/crypto"
import { merge3 } from "../vault/merge"

/** What a stale write surfaces to the UI for a human to resolve (spec §6.5) -- never
 * auto-resolved, never discarded. Field-by-field, so a reader never has to guess which of
 * `merge3`'s own two outputs fed which field: `merged`/`conflicted` are exactly
 * {@link merge3}'s `{text, conflicted}`, renamed only because "text" alone would be ambiguous
 * next to `base`/`mine`/`theirs` (also text). */
export interface Conflict {
  base: string
  mine: string
  theirs: string
  merged: string
  conflicted: boolean
}

/** `commit`'s result is the brief's own two cases -- `{ sha }` (written) or `{ conflict }`
 * (needs a human) -- plus one this file adds, documented here rather than left as a silent
 * deviation from the brief's stated signature: `{ queued: true }`, when GitHub could not be
 * reached at all (see `commit`'s own doc comment for exactly what that means and why it is
 * distinguishable from every other failure this app names). A caller written only against the
 * brief's original two cases (none exist yet -- Task 13 onward) still type-checks against a
 * narrower union it destructures by hand; one that wants to show "saved, will sync when back
 * online" messaging switches on this third case explicitly. */
export type CommitResult = { sha: string } | { conflict: Conflict } | { queued: true }

/** Compares this session's own `baseSha` -- "the commit SHA it was read at" (see `Session`'s
 * own doc comment in src/session/unlock.ts) -- against `data`'s current head (spec §5.3's
 * "Background sync... compares the cached SHA against data head"). Deliberately reads
 * `s.baseSha`, not `local.getCachedVault()`'s own stored `sha`: the two are *usually* the same
 * value, but not provably so in the one scenario that actually matters here -- two tabs share
 * one IndexedDB (Review Focus 4), so another tab's own successful commit can advance
 * `local`'s cachedVault without this session's own in-memory `baseSha` (or its on-screen text)
 * ever having moved. Comparing against the LocalStore row in that scenario would read
 * "head.sha === cachedVault.sha" as true and wrongly report nothing to do, even though this
 * exact session is still showing stale text. Comparing against `s.baseSha` instead -- the one
 * value that actually describes what THIS session currently holds -- gets it right regardless
 * of what any other tab has already written to the shared database.
 *
 * Two outcomes once `head.sha !== s.baseSha` (spec §5.3's own two cases):
 * - **No local draft** (`local.getDraft()` is `null`, i.e. nothing written since the last
 *   commit/sync) -- there is nothing of the user's to lose, so this pulls the newer version in
 *   directly: decrypts it, updates `s.text`/`s.baseSha` in place (the caller already holds this
 *   same `Session` object, so an editor reading from it afterwards sees the new text with no
 *   extra plumbing) and writes it through to `local.getCachedVault()` so a future reload
 *   benefits too. Returns `{ updated: true, diverged: false }`.
 * - **A local draft exists** -- some uncommitted local edit is sitting in IndexedDB. Nothing is
 *   touched: not the draft, not the cached vault, not the session. The divergence is reported
 *   (`{ updated: false, diverged: true }`) and left for `commit` to discover on its own, the
 *   next time the user actually tries to save (spec §6.5) -- `s.baseSha` is deliberately left
 *   exactly as it was, since that (or the draft's own stored `baseSha`, see `commit`'s doc
 *   comment) is exactly the "base" a later three-way merge needs; advancing it here would make
 *   `commit`'s own conflict handling fetch the same "theirs" twice, as both `theirs` and
 *   `base`, silently corrupting the merge. */
export async function syncFromRemote(
  s: Session,
  store: GithubStore,
  local: LocalStore,
): Promise<{ updated: boolean; diverged: boolean }> {
  const head = await store.readHead()
  if (head.sha === s.baseSha) return { updated: false, diverged: false }

  const draft = await local.getDraft()
  if (draft !== null) return { updated: false, diverged: true }

  s.text = await decryptVault(head.armored, s.passphrase)
  s.baseSha = head.sha
  await local.putCachedVault({ armored: head.armored, sha: head.sha })
  return { updated: true, diverged: false }
}

/** Does this failure mean "GitHub could not be reached at all", as opposed to one of the
 * specific, named conditions this app already has its own recovery story for? `GithubStore`'s
 * own `request()` (src/store/github.ts) translates every GitHub-side failure this app
 * distinguishes into one of `ALL_ERROR_CLASSES` (src/store/errors.ts) -- an invalid/expired
 * token, a public repo, a missing data branch, a rate limit it already gave up retrying, a
 * duplicate branch-init -- each with its own UI recovery affordance (that file's own header
 * comment: "Task 19 switches on class identity to pick the matching recovery affordance").
 * Anything else reaching this point is, by construction, a failure from BELOW that translation
 * layer -- the `fetch` call itself never got a response to classify. Confirmed in this
 * project's own Node 24 runtime, not assumed: `fetch()` against an unreachable host rejects
 * with a plain `TypeError` ("fetch failed", `.cause` the underlying DNS/connection error),
 * never one of GithubStore's named classes. This function does not need that exact shape to be
 * correct, though -- it treats ANY error that is not one of the six named classes as
 * unreachable, which is exactly as correct against a real browser's own network-error
 * `TypeError` as it is against whatever a test injects in its place (this file's own
 * `fetchThatIsOffline` throws a plain `TypeError` for precisely this reason: it is the
 * realistic shape, not an arbitrary one). */
function isUnreachable(err: unknown): boolean {
  return !ALL_ERROR_CLASSES.some((ErrorClass) => err instanceof ErrorClass)
}

/** One real write attempt, shared by `commit`'s own first attempt and `replayPendingCommit`'s
 * replay of a previously-queued one -- both need identical handling once the attempt is in
 * flight (spec §6.5): on success, advance the cached vault, clear BOTH the draft and any
 * queued pending commit (a direct success here means whatever this write carries supersedes
 * anything still queued from an earlier offline episode -- every commit this app makes always
 * carries the full current text, never a diff, so there is nothing left in an older queued
 * attempt that this one doesn't already include), and update the session in place so later
 * code reading `s.text`/`s.baseSha` sees the just-committed version. On a stale base, fetch
 * `theirs` (current head) and `base` (`readAt(baseSha)` -- the version this attempt actually
 * started from), decrypt all three versions and run the three-way merge, returning the
 * conflict for the UI to resolve. On anything else {@link isUnreachable} recognises as GitHub
 * being unreachable, returns `{ unreachable: true }` instead of throwing -- a third, ordinary
 * return value, not an exception, specifically so neither caller has to distinguish it from a
 * genuinely unexpected failure by inspecting the error itself (see below). Never retried here,
 * never auto-resolved, never discarded -- `commit`/`replayPendingCommit` decide what happens
 * next with any of these three outcomes, this function only produces them.
 *
 * `isUnreachable` is deliberately consulted ONLY around the initial `store.write` call, not
 * wrapped around the conflict-resolution follow-up calls below it. A first cut of this
 * function caught that whole `try` broadly instead, which silently created a real bug: once
 * `StaleWriteError` is already confirmed (meaning GitHub was DEFINITELY reached and gave a real
 * answer), a *different* failure while fetching/decrypting `theirs`/`base` -- a dropped
 * connection mid-conflict-resolution, a corrupted remote blob, a genuinely wrong passphrase
 * (e.g. after a future passphrase-change feature leaves mixed-passphrase history, spec §13's
 * last row) -- is not evidence of being offline at all, and `isUnreachable` cannot tell the
 * difference from the outside: a decrypt failure is exactly as "not one of
 * `ALL_ERROR_CLASSES`" as a real network `TypeError` is. Catching only the narrow, single
 * `store.write` call keeps that whole class of failure propagating as a genuine rejection,
 * never silently reclassified as "still offline, queue the original attempt" by a caller that
 * has no way to know better (this file's own "propagates raw, never silently queued" test
 * below is what catches a regression back to the broader `try`).
 *
 * `mineText` is passed in by the caller rather than derived from `armored` here so neither
 * caller ever pays for a redundant scrypt-protected decrypt of content it already holds as
 * plaintext: `commit` always already has it (the caller's own `text` argument); a replay does
 * not (only ciphertext survives a queued commit -- see `PendingCommit`'s own doc comment in
 * src/store/local.ts), so `replayPendingCommit` decrypts once, itself, before calling this. */
async function attemptWrite(
  s: Session,
  store: GithubStore,
  local: LocalStore,
  pending: { mineText: string; armored: string; baseSha: string; message: string },
): Promise<{ sha: string } | { conflict: Conflict } | { unreachable: true }> {
  let sha: string
  try {
    ;({ sha } = await store.write(pending))
  } catch (err) {
    if (err instanceof StaleWriteError) {
      // Sequential, deliberately never Promise.all: two scrypt-protected decrypts follow, and
      // the project's own Global Constraint (plan.md) is that the two scrypt runs must never
      // be concurrent, on pain of a mobile tab being discarded (spec §5.4). That constraint is
      // stated for unlock.ts's own two decrypts, but the underlying hazard -- two ~128 MiB
      // age-scrypt buffers alive at once -- is identical here, so this file holds to the same
      // discipline (confirmed by this file's own "never runs concurrently" test, which
      // instruments the same way unlock.test.ts's does).
      const theirs = await store.readHead()
      const baseArmored = await store.readAt(pending.baseSha)
      const theirsText = await decryptVault(theirs.armored, s.passphrase)
      const baseText = await decryptVault(baseArmored, s.passphrase)
      const { text: merged, conflicted } = merge3(baseText, pending.mineText, theirsText)
      return { conflict: { base: baseText, mine: pending.mineText, theirs: theirsText, merged, conflicted } }
    }
    if (isUnreachable(err)) return { unreachable: true }
    throw err
  }
  await local.putCachedVault({ armored: pending.armored, sha })
  await local.clearDraft()
  await local.clearPendingCommit()
  s.text = pending.mineText
  s.baseSha = sha
  return { sha }
}

/** A fixed, human-readable commit message -- no test (here or in any later task's plan) needs
 * a specific format, and Task 16's own restore path reuses `commit` directly as "a normal
 * forward commit" with no message of its own to supply, so there is nothing for a caller to
 * customize yet. Timestamped so `history` (Task 16) shows more than one identical line per
 * save. */
function saveMessage(): string {
  return `eigenheim: save ${new Date().toISOString()}`
}

/** Commits `text` as the vault's new revision (spec §6.4/§6.5). Three outcomes:
 *
 * - **Written.** The common case: `store.write` succeeds, the cached vault advances, the draft
 *   is cleared, and `{ sha }` is returned.
 * - **Conflict.** `store.write` is rejected as a non-fast-forward (`StaleWriteError`, spec
 *   §6.4's `force: false` guarantee) -- some other device committed since this edit's base.
 *   Never retried and never auto-resolved: `attemptWrite` fetches `theirs`/`base`, merges
 *   locally, and this returns `{ conflict }` for the UI to show (spec §6.5).
 * - **Queued.** `store.write` fails for a reason that is not one of GithubStore's own named,
 *   recoverable conditions (`isUnreachable` -- overwhelmingly, GitHub could not be reached at
 *   all). Rather than losing the edit or surfacing a raw network error, it is encrypted and
 *   held as the single queued {@link PendingCommit} (src/store/local.ts), ready for
 *   `replayPendingCommit` once connectivity returns (spec §13's "editing continues; commit
 *   queues and retries on reconnect"). A second commit attempted while one is already queued
 *   simply replaces it (`local.putPendingCommit` is a plain overwrite, not a list) -- every
 *   commit already carries the full current text, so the newer attempt strictly supersedes
 *   whatever the older one was trying to save; there is nothing in the first attempt that
 *   survives independently of the second one's own content. Every other named `GithubStore`
 *   error (an invalid token, a now-public repo, an exhausted rate limit, ...) propagates
 *   unchanged instead -- each has its own specific UI recovery affordance (Task 19), and
 *   silently queuing one of those would retry something retrying can never fix.
 *
 * `baseSha` -- what this edit actually started from -- is read from the stored {@link Draft}
 * (`local.getDraft()`) when one exists, not from `s.baseSha` directly: see
 * {@link syncFromRemote}'s own doc comment for why the two are not provably the same value
 * (two tabs, one IndexedDB). Falls back to `s.baseSha` only when there is no stored draft at
 * all -- e.g. committing immediately after unlock, before any autosave has run -- where the
 * session's own base is the only "what was this built from" the app has. */
export async function commit(s: Session, text: string, store: GithubStore, local: LocalStore): Promise<CommitResult> {
  const draft = await local.getDraft()
  const baseSha = draft?.baseSha ?? s.baseSha
  const armored = await encryptVault(text, s.passphrase)
  const message = saveMessage()

  const result = await attemptWrite(s, store, local, { mineText: text, armored, baseSha, message })
  if ("unreachable" in result) {
    await local.putPendingCommit({ armored, baseSha, message })
    return { queued: true }
  }
  return result
}

/** Replays the single queued {@link PendingCommit} (src/store/local.ts), if there is one --
 * the other half of spec §13's "commit queues and retries on reconnect". Returns `null` with no
 * network call at all when nothing is queued, so a caller (Task 14's `online` event handler) can
 * call this unconditionally on every reconnect without first checking whether anything is
 * actually pending.
 *
 * Shares `attemptWrite` with `commit`, so a successful replay has IDENTICAL effects to a
 * successful direct commit (cached vault advances, draft clears, session updates) -- the user
 * never sees a difference between "saved immediately" and "saved once back online" beyond the
 * `{ queued: true }` this app shows meanwhile. The one thing specific to replay: if the queued
 * attempt itself now conflicts (someone else committed while this device was offline), the
 * queue is cleared here before returning the conflict -- a conflict is, per this task's own
 * brief, "a real answer, not a transient failure", so replaying the identical stale content
 * again on a later reconnect would only reproduce the same conflict forever. The one case that
 * deliberately does NOT clear the queue: a renewed {@link isUnreachable} result (still offline,
 * or offline again) is converted back into a rejected promise here -- this function's own
 * contract has no silent "still queued" return distinct from "nothing was queued at all"
 * (`null`), so a caller must be able to tell the two apart by `await` rejecting rather than by
 * inspecting a value -- leaving the pending commit exactly where it was for a future reconnect
 * to retry. Nothing has actually been resolved yet, so nothing here is thrown away. */
export async function replayPendingCommit(
  s: Session,
  store: GithubStore,
  local: LocalStore,
): Promise<{ sha: string } | { conflict: Conflict } | null> {
  const pending = await local.getPendingCommit()
  if (pending === null) return null

  const mineText = await decryptVault(pending.armored, s.passphrase)
  const result = await attemptWrite(s, store, local, { mineText, ...pending })
  if ("unreachable" in result) {
    throw new Error("replayPendingCommit: GitHub is still unreachable -- left queued for a later retry")
  }
  if ("conflict" in result) await local.clearPendingCommit()
  return result
}
