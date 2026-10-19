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
//
// Review round 1 found two Criticals and an Important in this file's first version, both
// Criticals reproduced live (not theorised) against a scratch copy of the project -- see this
// task's fix report for the full detail. The short version, since it shapes several choices
// below: (1) the original single-slot offline queue let a second tab's own queued commit
// silently destroy a first tab's, when both diverged from the same base without ever seeing
// each other's edit -- fixed by making the queue an append-only list, replayed oldest-first,
// never coalesced. (2) a successful commit unconditionally deleted the draft, destroying any
// newer draft an autosave had landed while the write was still in flight (0.4-2s of scrypt plus
// a network round trip) -- fixed by capturing the draft's `savedAt` before the write starts and
// only clearing if it is unchanged after, rebasing it onto the new commit otherwise. (3)
// `isUnreachable` classified "GitHub could not be reached" by EXCLUSION (not one of
// GithubStore's own named error classes) rather than by a positive test, so a genuine but
// unmapped GitHub HTTP error (e.g. a transient 500) was misclassified as offline and queued
// forever with no distinguishing diagnostic -- fixed by testing positively for a real network
// failure (`TypeError`, confirmed empirically to be the actual shape `fetch` itself throws).

import type { Session } from "./unlock"
import type { GithubStore } from "../store/github"
// `Draft` is imported only so the doc comments below can `{@link}` it -- it is never written
// out as an explicit type annotation anywhere in this file, since every local inferred from
// LocalStore's own getters already has the right shape.
import type { LocalStore, Draft } from "../store/local"
import { StaleWriteError, ReplayRepeatedlyUnreachableError } from "../store/errors"
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

/** `replayPendingCommits`' own result -- see that function's doc comment. `committedShas` lists
 * every queued entry successfully written during this one call, oldest first (each is a real,
 * independent commit -- review round 1's own ruling: "N queued entries replaying as N commits
 * gives a truthful history", not one squashed commit). Processing stops at the first entry that
 * either conflicts or finds GitHub unreachable again, leaving any later entries still queued
 * for a future call -- at most one of `conflict`/`unreachable` is ever set. Both unset (and
 * `committedShas` covering the whole queue) means every queued entry drained cleanly. */
export interface ReplayOutcome {
  committedShas: string[]
  conflict: Conflict | null
  unreachable: boolean
}

/** Bounded retry budget for a single queued entry repeatedly failing as unreachable across
 * separate `replayPendingCommits` calls (e.g. one per `online` event, each one genuinely still
 * offline) -- mirrors `GithubStore`'s own `MAX_RATE_LIMIT_RETRIES = 5` (src/store/github.ts),
 * same "bounded, not forever" reasoning, same number for the same reason: generous enough that
 * ordinary flaky reconnects recover silently, bounded enough that "still offline" eventually
 * stops looking identical to "just reconnected a moment too soon" and says so instead (review
 * round 1, Important 3's own "cap identical repeated replay failures and surface a distinct
 * error" requirement). The entry itself is never discarded at the cap -- only
 * {@link ReplayRepeatedlyUnreachableError} is thrown in its place of the usual silent
 * `unreachable: true` outcome; the edit stays queued for whenever connectivity genuinely
 * returns. */
export const MAX_REPLAY_ATTEMPTS = 5

// {@link ReplayRepeatedlyUnreachableError} itself now lives in src/store/errors.ts (review
// round 2), alongside this app's other named failure modes, so Task 19's exhaustive
// affordance test actually covers it -- being left out of that enumeration would have
// recreated, under a better name, the exact "retries forever behind 'offline, will sync' with
// no escalation" dead end this class exists to remove. See that file's own header comment for
// why its default message carries no number, and why putting `MAX_REPLAY_ATTEMPTS` there
// directly would create a circular import between this file and that one.

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

/** Does this failure mean "GitHub could not be reached at all"? Review round 1 (Important 3)
 * overturned this function's original exclusion-based test ("not one of GithubStore's named
 * error classes") after a live reproduction: `GithubStore.request()`'s own generic fallback
 * (`if (!res.ok) throw new Error(...)`, src/store/github.ts) fires for ANY unmapped non-2xx
 * status -- a real response GitHub *did* send -- and `write()`'s blob/tree/commit POSTs pass no
 * `errorFor` at all, so a genuine, deterministic GitHub-side error (a transient 500, say) threw
 * a plain, unclassified `Error` that was indistinguishable, by exclusion, from a real network
 * failure. The old test would have queued it, and it would have failed identically on every
 * future replay -- a dead end with no diagnostic, which spec §13 forbids for any failure state.
 *
 * Fixed by testing POSITIVELY for the one shape a genuine network failure actually takes.
 * Confirmed in this project's own Node 24 runtime, not assumed: `fetch()` against an
 * unreachable host rejects with a plain `TypeError` ("fetch failed", `.cause` the underlying
 * DNS/connection error) -- and `request()`'s own generic non-2xx fallback throws `new
 * Error(...)`, a plain `Error`, never a `TypeError`. The two are different constructors, not
 * just different messages, which is what makes this a real positive test rather than a
 * relabelled exclusion: nothing else in `GithubStore.write`'s own call path throws a bare
 * `TypeError` for a reason OTHER than the underlying `fetch` call itself failing (confirmed by
 * reading `write` in full: no property access there can produce one, since nothing it reads off
 * a parsed response is ever dereferenced further than a single, directly-read field).
 *
 * This is deliberately a narrower claim than the original comment made, and is why that one was
 * wrong: this function cannot see every GithubStore-external TypeError that might theoretically
 * exist (a decrypt bug, a passphrase mismatch after some future feature) -- which is exactly why
 * `attemptWrite` below only ever consults this around the single, narrow `store.write` call, not
 * around its own conflict-resolution follow-ups, where a `TypeError` would mean something else
 * entirely. */
function isUnreachable(err: unknown): boolean {
  return err instanceof TypeError
}

/** One real write attempt, shared by `commit`'s own first attempt and `replayPendingCommits`'s
 * replay of a previously-queued one -- both need identical handling once the attempt is in
 * flight (spec §6.5).
 *
 * **On success:** advances the cached vault and updates the session in place
 * (`s.text`/`s.baseSha`) so later code sees the just-committed version. The draft is cleared
 * ONLY IF it is still exactly the one this attempt started from -- `draftSavedAtAtStart` is the
 * caller's own draft `savedAt` as read at the moment it decided what to write, captured BEFORE
 * the real time this write takes (0.4-2s of scrypt plus a network round trip, during which the
 * same tab's autosave debounce -- or another tab's -- can easily land a newer draft; spec §8
 * explicitly allows autosave to keep running while an explicit commit is in flight). Review
 * round 1 (Critical 2) found and fixed a real bug here: the original version cleared
 * unconditionally, destroying that newer draft's only persisted copy the instant the write
 * happened to resolve. The fix mirrors `putDraft`'s own existing compare-before-write discipline
 * (src/store/local.ts) -- an inconsistency in the original design, not a new mechanism: if the
 * draft is unchanged, clearing it is exactly as safe as before; if it changed, it is rebased
 * onto the sha just committed (so the user's in-flight typing does not later conflict against
 * its own prior write) rather than deleted. This does not need its own cross-tab atomicity
 * guard beyond what already exists: the rebase write goes through `local.putDraft` itself,
 * which already refuses to let an older write clobber a newer one (so a THIRD, even-newer
 * draft landing in the brief window between this function's own re-read and its rebase write
 * simply wins on its own, via that existing guard, leaving this rebase safely skipped rather
 * than corrupting anything -- the one cost is a false-positive conflict on the next commit
 * attempt against a `baseSha` that is technically one step behind, which the ordinary
 * conflict path already handles safely).
 *
 * **On a stale base:** fetches `theirs` (current head) and `base` (`readAt(baseSha)` -- the
 * version this attempt actually started from), decrypts all three versions and runs the
 * three-way merge, returning the conflict for the UI to resolve. Never retried, never
 * auto-resolved.
 *
 * **On anything else {@link isUnreachable} recognises as GitHub being unreachable:** returns
 * `{ unreachable: true }` instead of throwing -- a third, ordinary return value, not an
 * exception, specifically so neither caller has to distinguish it from a genuinely unexpected
 * failure by inspecting the error itself.
 *
 * `isUnreachable` is deliberately consulted ONLY around the initial `store.write` call, not
 * wrapped around the conflict-resolution follow-up calls below it (a first cut of this function
 * caught that whole `try` broadly instead, which conflated "the write never reached GitHub" with
 * "GitHub was reached, said stale, and THEN something else failed" -- see `isUnreachable`'s own
 * doc comment for why those are not the same thing and must not be classified the same way).
 *
 * `mineText` is passed in by the caller rather than derived from `armored` here so neither
 * caller ever pays for a redundant scrypt-protected decrypt of content it already holds as
 * plaintext: `commit` always already has it (the caller's own `text` argument); a replay does
 * not (only ciphertext survives a queued commit -- see `PendingCommit`'s own doc comment in
 * src/store/local.ts), so `replayPendingCommits` decrypts once, itself, before calling this. */
async function attemptWrite(
  s: Session,
  store: GithubStore,
  local: LocalStore,
  pending: { mineText: string; armored: string; baseSha: string; message: string },
  draftSavedAtAtStart: number | null,
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
  const draftNow = await local.getDraft()
  if (draftNow === null || draftNow.savedAt === draftSavedAtAtStart) {
    await local.clearDraft()
  } else {
    await local.putDraft({ ...draftNow, baseSha: sha })
  }
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
 * - **Written.** The common case: `store.write` succeeds, the cached vault advances, and
 *   `{ sha }` is returned. See `attemptWrite`'s own doc comment for exactly when the draft is
 *   cleared vs. rebased.
 * - **Conflict.** `store.write` is rejected as a non-fast-forward (`StaleWriteError`, spec
 *   §6.4's `force: false` guarantee) -- some other device committed since this edit's base.
 *   Never retried and never auto-resolved: `attemptWrite` fetches `theirs`/`base`, merges
 *   locally, and this returns `{ conflict }` for the UI to show (spec §6.5).
 * - **Queued.** `store.write` fails for a reason {@link isUnreachable} recognises as "GitHub
 *   could not be reached at all". Rather than losing the edit or surfacing a raw network error,
 *   it is encrypted and appended to the offline queue (`local.enqueuePendingCommit`, an
 *   append-only list -- see that method's own doc comment in src/store/local.ts for why review
 *   round 1 replaced the original single-slot design: a second tab independently queuing from
 *   the same base must never destroy a first tab's own still-unreplayed entry). Can itself throw
 *   `PendingQueueFullError` if the queue is already at capacity -- left to propagate unchanged;
 *   the edit is not lost either way, since a failed enqueue never touches the draft, but it
 *   cannot be queued for automatic replay until the queue drains. Every other named
 *   `GithubStore` error (an invalid token, a now-public repo, an exhausted rate limit, a
 *   genuine-but-unmapped HTTP error, ...) propagates unchanged instead -- each has its own
 *   specific UI recovery affordance (Task 19), or at minimum a visible, distinguishable failure,
 *   and silently queuing one of those would retry something retrying can never fix.
 *
 * `baseSha` -- what this edit actually started from -- is read from the stored {@link Draft}
 * (`local.getDraft()`) when one exists, not from `s.baseSha` directly: see
 * {@link syncFromRemote}'s own doc comment for why the two are not provably the same value
 * (two tabs, one IndexedDB). Falls back to `s.baseSha` only when there is no stored draft at
 * all -- e.g. committing immediately after unlock, before any autosave has run -- where the
 * session's own base is the only "what was this built from" the app has. The same `draft` read
 * also captures `savedAt` for `attemptWrite`'s own clear-vs-rebase decision (one read serving
 * both purposes, not two). */
export async function commit(s: Session, text: string, store: GithubStore, local: LocalStore): Promise<CommitResult> {
  const draft = await local.getDraft()
  const baseSha = draft?.baseSha ?? s.baseSha
  const armored = await encryptVault(text, s.passphrase)
  const message = saveMessage()

  const result = await attemptWrite(s, store, local, { mineText: text, armored, baseSha, message }, draft?.savedAt ?? null)
  if ("unreachable" in result) {
    await local.enqueuePendingCommit({ armored, baseSha, message })
    return { queued: true }
  }
  return result
}

/** Replays the offline queue (`local.getPendingCommits()`, src/store/local.ts), oldest first --
 * the other half of spec §13's "commit queues and retries on reconnect". Returns `null` with no
 * network call at all when nothing is queued, so a caller (Task 14's `online` event handler) can
 * call this unconditionally on every reconnect without first checking whether anything is
 * actually pending.
 *
 * Processes entries strictly one at a time (never concurrently -- each may itself need the
 * sequential scrypt-protected decrypts `attemptWrite`'s own conflict path uses), continuing to
 * the next only after the current one is fully resolved one way or another:
 *
 * - **Success** -- dequeues that entry (`local.dequeueOldestPendingCommit`) and continues to the
 *   next queued entry, if any. A queue that drains completely with no conflicts becomes exactly
 *   that many real, independent commits (review round 1's own ruling: "N queued entries
 *   replaying as N commits gives a truthful history" -- never squashed into one).
 * - **Conflict** -- dequeues that entry too (a conflict is, per this task's own brief, "a real
 *   answer, not a transient failure", so replaying the identical stale content again later would
 *   only reproduce the same conflict forever) and STOPS, returning the conflict immediately.
 *   Any later-queued entries are left exactly as they are -- not attempted this call -- for a
 *   future replay after the user resolves this one (a normal, direct `commit` with their chosen
 *   resolution, which does not touch the rest of the queue at all; see `attemptWrite`'s own
 *   `putCachedVault`/draft handling, which was deliberately NOT extended to also clear other
 *   queued entries on an unrelated success -- review round 1 rejected exactly that kind of
 *   "these must be equivalent, so discard" reasoning for Critical 1, and the same reasoning
 *   applies here: a later entry's own real conflict, if any, is what safely discovers whether it
 *   was actually superseded, never an assumption made on its behalf).
 * - **Still unreachable** -- records the failed attempt (`local.recordPendingCommitAttemptFailed`)
 *   and STOPS, returning whatever was already committed earlier in this same call plus
 *   `unreachable: true`. The entry stays queued, exactly as it was, for a future call. If this
 *   is the entry's `MAX_REPLAY_ATTEMPTS`th consecutive unreachable result, throws
 *   {@link ReplayRepeatedlyUnreachableError} instead of returning normally -- see that class's
 *   own doc comment; the entry is still never discarded, only the silent-retry signal changes to
 *   a louder one. */
export async function replayPendingCommits(s: Session, store: GithubStore, local: LocalStore): Promise<ReplayOutcome | null> {
  let queue = await local.getPendingCommits()
  if (queue.length === 0) return null

  const committedShas: string[] = []
  for (;;) {
    if (queue.length === 0) return { committedShas, conflict: null, unreachable: false }

    const entry = queue[0]
    const mineText = await decryptVault(entry.armored, s.passphrase)
    const draftBeforeThisAttempt = await local.getDraft()
    const result = await attemptWrite(
      s,
      store,
      local,
      { mineText, armored: entry.armored, baseSha: entry.baseSha, message: entry.message },
      draftBeforeThisAttempt?.savedAt ?? null,
    )

    if ("unreachable" in result) {
      const attempts = await local.recordPendingCommitAttemptFailed(entry)
      if (attempts !== null && attempts >= MAX_REPLAY_ATTEMPTS) {
        throw new ReplayRepeatedlyUnreachableError(
          `GitHub has been unreachable for ${attempts} consecutive reconnect attempts -- the edit is still safely queued locally, but check your connection`,
        )
      }
      return { committedShas, conflict: null, unreachable: true }
    }
    if ("conflict" in result) {
      await local.dequeueOldestPendingCommit(entry)
      return { committedShas, conflict: result.conflict, unreachable: false }
    }
    committedShas.push(result.sha)
    await local.dequeueOldestPendingCommit(entry)
    queue = await local.getPendingCommits()
  }
}
