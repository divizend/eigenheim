// Sequential unlock (spec §5.3): opens the vault and recovers the GitHub token without ever
// running two scrypt operations at once. This file has no Node types available
// (tsconfig.app.json covers `src/`) and must stay that way.
//
// Two scrypt runs are structurally unavoidable per unlock -- one for `vault.age` (it must be a
// passphrase-only age file, so `age -d` works with nothing else) and one for `device.age` (local
// storage must be protected to the same standard, or device theft attacks the weaker of the
// two). age's scrypt uses r=8, p=1, so memory is 128*r*N bytes -- 128 MiB per run at this
// project's SCRYPT_LOG_N=17 (src/config.ts). Two concurrent runs peak near 256 MiB, close enough
// to where mobile Safari discards a tab that a failed unlock -- the single most damaging outcome
// this design has, since there is no recovery key -- is a real risk, not a theoretical one
// (spec §5.4).
//
// So: every scrypt-protected decrypt in this file is awaited individually before the next one
// starts. No Promise.all, no concurrent starts, anywhere in this function -- including across
// the NFC/NFD passphrase candidates below, which would otherwise turn two scrypt-bearing
// ciphertexts into up to six concurrent attempts instead of up to three sequential ones.

import type { LocalStore } from "../store/local"
import type { GithubStore } from "../store/github"
import { TokenError } from "../store/errors"
import { decryptVault, decryptWithIdentity, WrongPassphraseError } from "../vault/crypto"
import { unwrapIdentity } from "../vault/identity"
import { normalizePassphrase } from "../vault/passphrase"

/** Progress stages a caller can show during unlock (spec §8's progress indicator). Each fires at
 * most once per {@link unlock} call, in one of exactly two fixed orders -- see that function's
 * own doc comment. */
export type Stage = "vault" | "token" | "fetch"

/** What a successful unlock produces:
 *
 * - `text` -- the vault's plaintext.
 * - `baseSha` -- the commit SHA it was read at, so a later write can be a conditional,
 *   fast-forward-only push against it (spec §6.4).
 * - `token` -- the GitHub token, if one is available locally; `null` if not. Reading never
 *   depends on it -- only syncing and committing do (spec §5.3/§7).
 * - `identity` -- the device identity, needed to decrypt/encrypt `draft.age`/`token.age` later
 *   in the session.
 * - `passphrase` -- the exact form of the passphrase that actually decrypted the vault:
 *   whichever of the as-typed/NFC/NFD candidates {@link resolvePassphrase} tried first and
 *   succeeded (see that function's own doc comment). **Not** necessarily the form the user
 *   typed this time -- by definition, it is the form the vault's ciphertext was produced under,
 *   since that is the only form that can ever make a passphrase-protected decrypt succeed.
 *
 *   This is why Task 12's `commit` needs it rather than re-deriving it: re-encrypting with the
 *   as-typed form instead, whenever a fallback candidate had been needed to open the vault in
 *   the first place, would produce a vault that still opens in this app (unlock retries all
 *   three forms again) but silently fails under `age -d` for the form the user actually types at
 *   a real terminal -- breaking spec §1's central promise, on the save path, with no recovery
 *   key to fall back on. Storing the resolved form here is what keeps that from being possible.
 *
 *   Kept in memory only, for the lifetime of this session object, exactly like every other
 *   in-memory passphrase-adjacent value in this project (spec §7's local-persistence table:
 *   "Passphrase | none -- memory only, for the session | n/a") -- this field does not introduce
 *   a new place the passphrase is persisted, it is the same in-memory lifetime the spec already
 *   describes, now reachable from the one object the rest of the session's code already passes
 *   around. **Never** write it to `LocalStore` (`putWrappedIdentity`/`putToken`/`putDraft`/
 *   `putCachedVault` all take ciphertext or non-secret metadata only, never this) -- Task 6's "no
 *   slot ever holds the passphrase" test (`tests/unit/local.test.ts`) is what would catch a
 *   regression that tried. */
export interface Session {
  text: string
  baseSha: string
  token: string | null
  identity: string
  passphrase: string
}

/** Builds the list of passphrase forms to try, in order, against one scrypt-protected
 * ciphertext (spec §5.5 rule 3): a visually identical passphrase can carry two different UTF-8
 * encodings (`für` is `66c3bc72` in NFC, `6675cc8872` in NFD) depending on the device's input
 * method, so a vault set up on one device can otherwise lock its own owner out on another.
 * Always starts from {@link normalizePassphrase} (trim only -- spec §5.5 rule 2 requires this
 * step never also apply Unicode normalisation, so a passphrase that needs no fallback at all is
 * tried in exactly the form the user typed, not a silently-altered one). `.normalize("NFC")` and
 * `.normalize("NFD")` follow, each included only if distinct from what is already in the list --
 * a passphrase with no decomposable characters (the common case: plain ASCII) normalises to
 * itself under both forms, so this returns a single-element list for it, not three identical,
 * wasted scrypt attempts. */
function passphraseCandidates(typed: string): string[] {
  const asTyped = normalizePassphrase(typed)
  const candidates = [asTyped]
  for (const form of [asTyped.normalize("NFC"), asTyped.normalize("NFD")]) {
    if (!candidates.includes(form)) candidates.push(form)
  }
  return candidates
}

/** Tries each candidate form of the typed passphrase against one scrypt-protected ciphertext,
 * one at a time, fully awaiting each before the next starts (never concurrently -- see this
 * file's header comment). `attempt` is {@link decryptVault} for `vault.age` or
 * {@link unwrapIdentity} for `device.age` -- both reject with {@link WrongPassphraseError} on a
 * non-matching passphrase and nothing else (crypto.ts's own contract: anything else means
 * genuinely malformed ciphertext, not a wrong guess), so that is the only rejection this
 * function treats as "try the next candidate". Any other error propagates immediately without
 * exhausting the remaining candidates -- retrying other passphrase forms against corrupt
 * ciphertext cannot help, and would only hide the real error.
 *
 * Returns both the decrypted result and the exact candidate string that worked, so the caller
 * can reuse that precise form for every other scrypt-protected decrypt in the same unlock call:
 * `vault.age` and `device.age` are always wrapped under byte-identical passphrase bytes (spec
 * §5.1/§5.3 -- one passphrase, two files, never normalised on write), so once one of them is
 * open, the other never needs its own candidate search. That keeps this unlock's worst case at
 * three sequential scrypt runs total (two ciphertexts * up to two candidates beyond the first,
 * minus whichever one the first ciphertext already resolved), not three per file.
 *
 * The `for (;;)` shape mirrors src/store/github.ts's own `request`'s retry loop -- deliberately,
 * not by coincidence: it is how this project already spells "loop until the last candidate's
 * failure propagates" in a way `tsconfig`'s strict mode accepts with no dead trailing
 * statement (every exit is a `return` or `throw`, so TypeScript can see the function never
 * falls off the end of the loop without one of those).
 *
 * Not generic over `attempt`'s return type: both of this file's call sites (`decryptVault` for
 * `vault.age`, `unwrapIdentity` for `device.age`) resolve to `Promise<string>`, so a type
 * parameter here would buy flexibility nothing yet needs. */
async function resolvePassphrase(
  typed: string,
  attempt: (passphrase: string) => Promise<string>,
): Promise<{ result: string; passphrase: string }> {
  const candidates = passphraseCandidates(typed)
  for (let i = 0; ; i++) {
    try {
      return { result: await attempt(candidates[i]), passphrase: candidates[i] }
    } catch (err) {
      if (!(err instanceof WrongPassphraseError) || i === candidates.length - 1) throw err
    }
  }
}

/** Reads the wrapped device identity out of local storage, or throws if there is none. Every
 * device that can reach {@link unlock} at all has already completed setup or device-transfer
 * pairing, both of which write `device.age` before the user can ever type a passphrase here --
 * so a missing identity means this function was called against a device that was never set up:
 * a broken precondition, not a recoverable unlock failure, so it is deliberately not folded into
 * {@link WrongPassphraseError} or any of src/store/errors.ts's GitHub-specific classes. */
async function requireWrappedIdentity(local: LocalStore): Promise<string> {
  const wrappedIdentity = await local.getWrappedIdentity()
  if (wrappedIdentity === null) {
    throw new Error("no device identity found locally -- this device has never completed setup")
  }
  return wrappedIdentity
}

/** Decrypts the locally-cached GitHub token via the (already unwrapped) device identity, or
 * returns `null` if none is stored -- shared by both branches of {@link unlock}, which reach
 * this point by different routes but need the identical "is there a token, and if so what is
 * it" question answered the same way. No candidate loop here: `token.age` is X25519-encrypted to
 * the device identity (spec §5.1), not passphrase-protected, so there is no scrypt and no
 * passphrase-form ambiguity to resolve. */
async function recoverToken(local: LocalStore, identity: string): Promise<string | null> {
  const tokenArmored = await local.getToken()
  return tokenArmored === null ? null : await decryptWithIdentity(tokenArmored, identity)
}

/** Opens the vault and recovers the GitHub token, running at most one scrypt operation at a
 * time, ever (see this file's header comment for why). Two branches, chosen by whether a cached
 * `vault.age` already sits in local storage (spec §5.3):
 *
 * - **Cached vault (the normal case).** Decrypt the cache and surface it FIRST -- the token is
 *   needed only to sync and commit, never to read, so the editor can open after just one scrypt
 *   run -- then recover the device identity and token. No network call at all in this branch.
 * - **First unlock on a device.** No cached ciphertext, so there is nothing to show yet; the
 *   order inverts to identity/token first (needed to even talk to GitHub), then a fetch, then
 *   the vault itself. This happens once per device.
 *
 * Either way, a wrong passphrase is always discovered against local ciphertext (the cached
 * vault, or failing that, `device.age`) before this function ever calls `makeStore` -- never
 * after a fetch has already happened -- so a locked-out user never pays for a network round
 * trip only to be told their passphrase was wrong. */
export async function unlock(opts: {
  passphrase: string
  local: LocalStore
  makeStore: (token: string) => GithubStore
  onStage?: (s: Stage) => void
}): Promise<Session> {
  const { passphrase, local, makeStore, onStage } = opts
  const cached = await local.getCachedVault()

  if (cached !== null) {
    onStage?.("vault")
    const { result: text, passphrase: resolved } = await resolvePassphrase(passphrase, (p) =>
      decryptVault(cached.armored, p),
    )

    onStage?.("token")
    const wrappedIdentity = await requireWrappedIdentity(local)
    const identity = await unwrapIdentity(wrappedIdentity, resolved)
    const token = await recoverToken(local, identity)

    return { text, baseSha: cached.sha, token, identity, passphrase: resolved }
  }

  onStage?.("token")
  const wrappedIdentity = await requireWrappedIdentity(local)
  const { result: identity, passphrase: resolved } = await resolvePassphrase(passphrase, (p) =>
    unwrapIdentity(wrappedIdentity, p),
  )
  const token = await recoverToken(local, identity)
  if (token === null) {
    throw new TokenError(
      "no GitHub token stored locally -- this device cannot fetch the vault for the first time without one",
    )
  }

  onStage?.("fetch")
  const head = await makeStore(token).readHead()

  onStage?.("vault")
  const text = await decryptVault(head.armored, resolved)

  return { text, baseSha: head.sha, token, identity, passphrase: resolved }
}
