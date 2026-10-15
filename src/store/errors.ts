// Thrown by GithubStore (src/store/github.ts) for every named failure mode
// spec §13 requires a specific, actionable response to -- never a bare
// generic throw. Each class names exactly one row of that table; src/ui/
// (Task 19) switches on class identity to pick the matching recovery
// affordance.
//
// Every constructor takes an optional message (with a sensible default)
// and options, the same shape as src/vault/crypto.ts's WrongPassphraseError
// -- so a throw site can either use the default or say exactly what went
// wrong, while Task 19's exhaustive test can still construct every class
// with zero arguments (see ALL_ERROR_CLASSES below).

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

/** Every error class GithubStore can throw, listed once so Task 19's
 * failure-recovery UI can enumerate them exhaustively instead of
 * hand-maintaining a parallel list in a test, which could silently drift
 * from this one (task 7 amendment). Each constructor is callable with zero
 * arguments (see the defaults above), which is exactly what that test needs
 * in order to instantiate one of each. */
export const ALL_ERROR_CLASSES = [
  StaleWriteError,
  TokenError,
  RepoPublicError,
  BranchMissingError,
  RateLimitedError,
  AlreadyInitializedError,
] as const
