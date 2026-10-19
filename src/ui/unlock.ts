// Unlock view (spec §5.3's sequential unlock, §8's "one passphrase field", §13's every-failure-
// has-a-way-forward). The view src/main.ts routes a device to when `getWrappedIdentity()` is
// non-null -- i.e. setup already completed here, and the only thing standing between the user
// and their text is one passphrase.
//
// Ruling R28: everything this view actually DECIDES lives in the three exported, DOM-free
// functions below -- `runUnlock` (what the typed string means), `progressMessage` (what the
// stages mean) and `failureMessage` (what an outcome means) -- with `renderUnlock` reduced to
// wiring. tests/unit/unlock-view.test.ts drives all three without a browser; that is the whole
// point of the split, and it is why the wrong-passphrase and no-token cases are cheap unit tests
// rather than multi-second Playwright runs that each pay for a real scrypt.
//
// This file has no Node types available (tsconfig.app.json covers `src/`) and must stay that way.

import type { GithubStore } from "../store/github"
import type { LocalStore } from "../store/local"
import { unlock, type Session, type Stage } from "../session/unlock"
import { normalizePassphrase } from "../vault/passphrase"
import { WrongPassphraseError } from "../vault/crypto"
import { TokenError, RepoPublicError } from "../store/errors"
import { VAULT_PATH } from "../config"

/** What {@link runUnlock} needs -- the same `makeStore` seam src/session/unlock.ts takes (ruling
 * R3), since the token is inside `token.age` and cannot be read until the passphrase has already
 * unwrapped this device's identity. */
export interface UnlockIO {
  local: LocalStore
  makeStore: (token: string) => GithubStore
}

/** Every way an unlock attempt can end, as data rather than a thrown error.
 *
 * `empty` and `wrong-passphrase` are separated from `failed` deliberately: both are ordinary
 * things a person does at a passphrase field, neither is an error anyone needs to debug, and
 * each has its own specific way forward. Collapsing them into `failed` would make the view show
 * a scary message for a typo. */
export type UnlockOutcome =
  | { kind: "unlocked"; session: Session }
  | { kind: "empty" }
  | { kind: "wrong-passphrase" }
  | { kind: "failed"; err: unknown }

/** Runs one unlock attempt. Never throws: every path produces an {@link UnlockOutcome}, because
 * spec §13 requires every failure to be visible, and an outcome the caller must destructure is
 * much harder to drop than a `catch` nobody wrote.
 *
 * The empty check happens BEFORE `unlock` is called, and that ordering is the point rather than
 * a tidiness preference: a logN=17 scrypt run costs 0.4-2s (spec §5.4's measured 407 ms on an
 * idle machine, "~1.5-2 s on a phone"), so telling someone who clicked Unlock on an empty field
 * to type something must not cost them a KDF first. The test pins it by counting
 * `Decrypter.prototype.decrypt` calls, not by timing.
 *
 * Emptiness is decided after {@link normalizePassphrase}, which trims only -- so whitespace is
 * "empty" while every other Unicode string the user can type is a real passphrase attempt. */
export async function runUnlock(
  typed: string,
  io: UnlockIO,
  onStage?: (stage: Stage) => void,
): Promise<UnlockOutcome> {
  if (normalizePassphrase(typed).length === 0) return { kind: "empty" }

  try {
    const session = await unlock({
      passphrase: typed,
      local: io.local,
      makeStore: io.makeStore,
      onStage,
    })
    return { kind: "unlocked", session }
  } catch (err) {
    if (err instanceof WrongPassphraseError) return { kind: "wrong-passphrase" }
    return { kind: "failed", err }
  }
}

/** What to show while an unlock is in flight, given the stages seen so far.
 *
 * `stages[0] === "token"` is a sound test for "this is the first unlock on this device", not a
 * guess: src/session/unlock.ts emits stages in exactly two orders, and the cached branch emits
 * `vault` first while the first-unlock branch emits `token` first. Both are pinned by
 * tests/unit/unlock.test.ts, and those are the only two orders that exist -- `grep -n
 * 'expect(stages).toEqual' tests/unit/unlock.test.ts` returns exactly two lines,
 * `["vault","token"]` and `["token","fetch","vault"]`.
 *
 * Saying so matters because of what the user is about to experience: the first unlock runs TWO
 * sequential scrypt operations (unwrap this device's identity, then decrypt the fetched vault)
 * where every later unlock runs one, so spec §8 requires the indicator to say it will take
 * roughly double rather than leaving someone watching an apparently-stuck screen. */
export function progressMessage(stages: readonly Stage[]): string {
  const firstUnlock = stages[0] === "token"
  const current = stages[stages.length - 1]

  const step =
    current === "token"
      ? "Unwrapping this device's key…"
      : current === "fetch"
        ? "Fetching your vault from GitHub…"
        : current === "vault"
          ? "Decrypting your vault…"
          : "Unlocking…"

  if (!firstUnlock) return step
  return `First unlock on this device — roughly double the usual wait, because it has to unwrap this device's key and your vault. ${step}`
}

/** What to show when an attempt did not produce a session. Total over {@link UnlockOutcome}: a
 * caller can hand it any non-success outcome and get something non-empty, which is the property
 * tests/unit/unlock-view.test.ts asserts across every case including a thrown non-Error.
 *
 * Note what this deliberately does NOT do: reuse src/ui/setup.ts's `errorRecoveryHtml`. That
 * function answers a `TokenError` with "This token cannot be used as it is ... then enter it
 * again", which is true at a wizard step that HAS a token and a field to paste a new one into.
 * Here a `TokenError` means this device holds no token at all and there is no field -- so that
 * copy would name an action the user cannot take. Ruling R30 is exactly this mistake, caught the
 * first time only after it shipped; the general rule it produced is that shared user-facing copy
 * must be true at every call site, which is why this is separate copy rather than a shared
 * helper stretched over two incompatible situations. */
export function failureMessage(outcome: UnlockOutcome): string {
  switch (outcome.kind) {
    case "unlocked":
      return ""
    case "empty":
      return "Type your passphrase to unlock this vault."
    case "wrong-passphrase":
      return "That passphrase did not open this vault. Check for a typo — including capitals and any leading or trailing spaces — and try again."
    case "failed": {
      const { err } = outcome
      if (err instanceof TokenError) {
        return (
          "This device has no usable GitHub token, so it cannot reach your vault. " +
          "Set this device up again from your own URL to store a fresh token. " +
          `Your text is not lost either way: your passphrase still opens ${VAULT_PATH} directly with \`age -d ${VAULT_PATH}\`, ` +
          "exactly as printed on your recovery sheet."
        )
      }
      if (err instanceof RepoPublicError) {
        return (
          "Your repository is public, so this app refuses to touch it — an encrypted vault in a public repo is world-readable ciphertext. " +
          "Make the repository private on GitHub, then reload this page and unlock again."
        )
      }
      return err instanceof Error ? err.message : String(err)
    }
  }
}

/** What {@link renderUnlock} needs. `onUnlocked` is how this view hands off without knowing what
 * comes next, matching src/ui/setup.ts's own `onComplete` -- src/main.ts decides. */
export interface UnlockDeps extends UnlockIO {
  onUnlocked: (session: Session) => void
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector)
  if (!el) throw new Error(`unlock view: expected element ${selector}`)
  return el
}

/** Mounts the unlock view. Wiring only -- every decision is in the three functions above. */
export function renderUnlock(root: HTMLElement, deps: UnlockDeps): void {
  root.innerHTML = `
    <section class="unlock" aria-label="Unlock your vault">
      <h1>Unlock</h1>
      <p>Your passphrase decrypts everything in this browser. It is never sent anywhere.</p>
      <label for="passphrase-input">Passphrase</label>
      <input type="password" id="passphrase-input" autocomplete="current-password" spellcheck="false" autocapitalize="off">
      <p id="unlock-feedback" class="wizard-feedback" data-testid="unlock-feedback" role="alert" hidden></p>
      <p id="unlock-progress" class="unlock-progress" data-testid="unlock-progress" role="status" hidden></p>
      <div class="wizard-actions">
        <button type="button" id="unlock-btn">Unlock</button>
      </div>
    </section>
  `

  const input = required<HTMLInputElement>(root, "#passphrase-input")
  const feedback = required<HTMLParagraphElement>(root, "#unlock-feedback")
  const progress = required<HTMLParagraphElement>(root, "#unlock-progress")
  const button = required<HTMLButtonElement>(root, "#unlock-btn")

  let running = false

  async function attempt(): Promise<void> {
    // Guarded rather than only disabling the button: Enter in the field is a second trigger, and
    // two concurrent unlocks would mean two concurrent scrypt runs -- the one thing spec §5.4
    // forbids outright, since two logN=17 runs peak near 256 MiB and can get a mobile tab
    // discarded mid-unlock.
    if (running) return
    running = true
    button.disabled = true
    feedback.hidden = true

    const stages: Stage[] = []
    progress.textContent = progressMessage(stages)
    progress.hidden = false

    const outcome = await runUnlock(input.value, deps, (stage) => {
      stages.push(stage)
      progress.textContent = progressMessage(stages)
    })

    progress.hidden = true
    running = false
    button.disabled = false

    if (outcome.kind === "unlocked") {
      // The passphrase leaves the DOM the moment it is no longer needed. It stays in the
      // returned Session (every later encrypt needs it) but nothing is served by leaving a copy
      // in a live input a later view might not unmount.
      input.value = ""
      deps.onUnlocked(outcome.session)
      return
    }

    feedback.textContent = failureMessage(outcome)
    feedback.hidden = false
    input.select()
  }

  button.addEventListener("click", () => void attempt())
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault()
      void attempt()
    }
  })
  input.focus()
}
