// Named failure modes this app needs a specific, actionable response to -- never a bare
// generic throw. Each class names exactly one row of spec §13's table; src/ui/ (Task 19)
// switches on class identity to pick the matching recovery affordance. Most of these are
// thrown by GithubStore (src/store/github.ts); two (PendingQueueFullError,
// ReplayRepeatedlyUnreachableError) are thrown by the offline-commit-queue machinery instead
// (src/store/local.ts, src/session/sync.ts) -- collected here anyway, in the one place anyone
// has to look, because ALL_ERROR_CLASSES' whole purpose (below) is "every failure mode needing
// a UI affordance", not "every failure mode specifically from GithubStore". Both classes were
// created in review round 1 (living in local.ts/sync.ts at the time); review round 2 caught
// both of those two missing from this file/array entirely: a class that exists but
// isn't enumerated here gets no affordance from Task 19's exhaustive test, and nobody finds out
// -- self-defeating for ReplayRepeatedlyUnreachableError especially, which exists specifically
// because a queue retrying forever behind "offline, will sync" is the dead end spec §13
// forbids.
//
// Every constructor takes an optional message (with a sensible default)
// and options, the same shape as src/vault/crypto.ts's WrongPassphraseError
// -- so a throw site can either use the default or say exactly what went
// wrong, while Task 19's exhaustive test can still construct every class
// with zero arguments (see ALL_ERROR_CLASSES below).
//
// PendingQueueFullError's and ReplayRepeatedlyUnreachableError's own DEFAULT messages below are
// deliberately generic, with no specific number baked in, even though both describe a genuinely
// numeric condition (a queue capacity, a retry count). The real, number-including message is
// supplied explicitly at each actual throw site instead (src/store/local.ts's
// `enqueuePendingCommit`, src/session/sync.ts's `replayPendingCommits`), which already has that
// number in scope as its own local constant (`MAX_PENDING_COMMITS`, `MAX_REPLAY_ATTEMPTS`).
// This is not a stylistic choice: giving either class's DEFAULT message that number directly
// would mean this file importing the constant FROM local.ts/sync.ts, while local.ts/sync.ts
// each already need to import the ERROR CLASS from this file to throw it -- a genuine circular
// import, not a hypothetical one. Confirmed directly before writing this, not assumed: sync.ts
// already imports from `../store/errors` (for StaleWriteError); local.ts did not before this
// change and now does too (for PendingQueueFullError). Either file additionally importing a
// numeric constant back out of this one would complete a two-file cycle. Keeping this file's
// own classes free of any dependency on the numeric policy constants that happen to motivate
// them avoids that entirely, at zero real cost: the generic default is only ever actually seen
// by Task 19's exhaustive `new ErrorClass()` construction test, never by a real user, who only
// ever sees the specific, number-including message each real throw site supplies.

/** A write (or the orphan-branch creation) was rejected because the
 * caller's base commit is no longer the branch tip -- spec §6.4's
 * `force: false` guarantee surfacing as a thrown error instead of a silent
 * overwrite or merge. GitHub documents both 409 and 422 as possible
 * statuses for a rejected non-fast-forward ref update without saying which
 * applies (spec §12); both map here. */
export class StaleWriteError extends Error {
  constructor(
    message = "the data branch moved since this edit was based — refusing to overwrite it",
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "StaleWriteError"
  }
}

/** The GitHub token is missing, expired, malformed, or -- per spec §6.7 --
 * lacks the repo permissions this app needs (`Contents: Read and write`). */
export class TokenError extends Error {
  constructor(message = "the GitHub token is missing or invalid", options?: ErrorOptions) {
    super(message, options)
    this.name = "TokenError"
  }
}

/** The repo is not `private: true` -- spec §13's blocking guard against
 * storing ciphertext somewhere world-readable and offline-grindable. */
export class RepoPublicError extends Error {
  constructor(message = "the repo must be private", options?: ErrorOptions) {
    super(message, options)
    this.name = "RepoPublicError"
  }
}

/** The `data` branch (spec §6.1) does not exist yet, or its tip commit's
 * tree has no `vault.age` entry -- both mean there is nothing yet to read,
 * and spec §9/§13's answer is the same either way: offer to initialize it. */
export class BranchMissingError extends Error {
  constructor(message = "the data branch does not exist yet", options?: ErrorOptions) {
    super(message, options)
    this.name = "BranchMissingError"
  }
}

/** GitHub's rate limit (secondary or primary; 403 or 429, generally with a
 * `Retry-After` header) was hit -- spec Review Focus 5. */
export class RateLimitedError extends Error {
  constructor(message = "rate limited by GitHub — retrying shortly", options?: ErrorOptions) {
    super(message, options)
    this.name = "RateLimitedError"
  }
}

/** `POST git/refs` for the `data` branch (task 9's orphan-branch init) was rejected because that
 * ref already exists. Deliberately a distinct class from {@link StaleWriteError}, not a reuse of
 * it, even though both stem from the same kind of GitHub rejection: `StaleWriteError` means "the
 * remote moved under you mid-edit", and its UI recovery is the three-way conflict view (spec
 * §6.5) -- which would be actively wrong here, since initialisation has no base version to merge
 * against and nothing of the caller's own to lose. The right recovery for this one is simply
 * "reload, your vault already exists", never a merge prompt. GitHub documents both `409` and
 * `422` as possible statuses for `POST git/refs` without a description specific to the
 * already-exists case (same undocumented ambiguity as `write`'s own non-fast-forward rejection,
 * spec §12); both map here, matching how task 8 handled the identical kind of ambiguity. */
export class AlreadyInitializedError extends Error {
  constructor(
    message = "the data branch already exists — reload instead of creating a new one",
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "AlreadyInitializedError"
  }
}

/** The offline-commit queue (src/store/local.ts's `LocalStore.enqueuePendingCommit`, Task 12
 * review round 1) is already at its cap -- a real, reachable state for a user who has been
 * offline long enough to queue many edits without ever reconnecting, not a theoretical one. A
 * loud, named failure here rather than the enqueue silently dropping the new edit (or evicting
 * the oldest, losing an older one instead) -- either silent option would violate this project's
 * central promise exactly as badly as the two-tab queue-overwrite bug this same review round
 * fixed. See this class's own default-message reasoning in this file's header comment for why
 * the default below carries no specific number. */
export class PendingQueueFullError extends Error {
  constructor(
    message = "the offline commit queue is full -- reconnect to let it drain before saving again",
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "PendingQueueFullError"
  }
}

/** A single queued offline commit (src/session/sync.ts's `replayPendingCommits`, Task 12
 * review round 1, Important 3) has failed to reach GitHub, as a genuine network failure rather
 * than one of this file's other named conditions, several consecutive times in a row. Distinct
 * from an ordinary, silent "still offline, will retry on the next reconnect" outcome
 * specifically so a UI can eventually say something louder than that -- without ever implying
 * the edit itself was lost, which it is not: the queue entry survives this error untouched,
 * same as every other attempt before it. Exists because a queue retrying forever behind
 * "offline, will sync" with no escalation is exactly the dead end spec §13 forbids; being
 * excluded from this file's own exhaustive enumeration would have recreated precisely that dead
 * end under a better name, which is why review round 2 (coordinator-directed) moved it here
 * from src/session/sync.ts, where review round 1 had originally defined it. */
export class ReplayRepeatedlyUnreachableError extends Error {
  constructor(
    message = "GitHub has been unreachable for several consecutive reconnect attempts -- the edit is still safely queued locally, but check your connection",
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ReplayRepeatedlyUnreachableError"
  }
}

/** Every error class this app's storage layer (GithubStore AND the offline-commit-queue
 * machinery alongside it, per this file's own header comment) can throw, listed once so Task
 * 19's failure-recovery UI can enumerate them exhaustively instead of hand-maintaining a
 * parallel list in a test, which could silently drift from this one (task 7 amendment; review
 * round 2 extended the scope of what "exhaustively" needs to cover past GithubStore alone).
 * Each constructor is callable with zero arguments (see the defaults above), which is exactly
 * what that test needs in order to instantiate one of each. */
/** Thrown when a supplied passphrase does not open an age file — as opposed to the armored
 * input being malformed, which rethrows the underlying error unchanged (see
 * src/vault/crypto.ts's `decryptVault`).
 *
 * MOVED here from src/vault/crypto.ts for ruling R26a, which required it to appear in
 * {@link ALL_ERROR_CLASSES} so task 19's exhaustive test proves it has a recovery affordance.
 * Moving it rather than importing it is what preserves this file's one structural property: it
 * has ZERO imports and must stay a leaf, because every module that throws one of these already
 * imports FROM here, so an import in the other direction would be a genuine cycle.
 * src/vault/crypto.ts re-exports it, so every existing `from "../vault/crypto"` import still
 * resolves to this same class — `grep -rn 'WrongPassphraseError' src/ tests/` was used to
 * confirm every consumer before the move. */
export class WrongPassphraseError extends Error {
  constructor(message = "wrong passphrase", options?: ErrorOptions) {
    super(message, options)
    this.name = "WrongPassphraseError"
  }
}

export const ALL_ERROR_CLASSES = [
  WrongPassphraseError,
  StaleWriteError,
  TokenError,
  RepoPublicError,
  BranchMissingError,
  RateLimitedError,
  AlreadyInitializedError,
  PendingQueueFullError,
  ReplayRepeatedlyUnreachableError,
] as const
