// Setup wizard (spec §9's one-click onboarding; §5.5's acknowledgement and passphrase floor;
// §13's visibility guard). The only UI a first-time user ever sees, and the thing every later
// view's own structure follows (this is the first UI task). No framework (spec §4) -- plain DOM
// APIs, matching the Vite template's original innerHTML-template-plus-addEventListener
// convention (src/main.ts). One step's markup mounted in `root` at a time; earlier steps are discarded, not
// hidden, so there is never more than one of a repeated control (e.g. "Continue") in the DOM --
// this is what lets a test select `getByRole("button", { name: /continue/i })` with no extra
// scoping.
//
// This file has no Node types available (tsconfig.app.json covers `src/`) and must stay that way.

import type { GithubStore } from "../store/github"
import type { LocalStore } from "../store/local"
import type { Session } from "../session/unlock"
import { repoOwner, repoSlug, VAULT_PATH } from "../config"
import { generateDeviceIdentity, wrapIdentity } from "../vault/identity"
import { encryptVault, encryptToRecipient } from "../vault/crypto"
import { generatePassphrase, checkPassphrase, normalizePassphrase } from "../vault/passphrase"
import { TokenError, RepoPublicError } from "../store/errors"

/** What the wizard needs from the rest of the app, and nothing it can import directly instead
 * (spec §9/§13). `makeStore` mirrors src/session/unlock.ts's own `makeStore: (token: string) =>
 * GithubStore` (ruling R3, same project) -- the same seam, for the same reason: this is the one
 * other place in the app that builds a `GithubStore` from a token it has only just received, and
 * keeping that construction in the caller (src/main.ts) rather than importing `GithubStore`
 * directly here means every view that ever needs one wires it the same way. `onComplete` is how
 * this file hands off without knowing anything about what "the editor" (Task 14) actually is --
 * src/main.ts supplies it and decides. */
export interface Deps {
  local: LocalStore
  makeStore: (token: string) => GithubStore
  onComplete: (session: Session) => void
}

const TOTAL_STEPS = 6

/** Threaded through every step's render function. The device identity is generated once, up
 * front (spec §5.1) -- it needs no input, nothing it produces is secret until it is wrapped under
 * the user's eventual passphrase (step 4 onward), and X25519 keygen is fast with no scrypt
 * involved, so starting it immediately costs nothing and means step 6 almost never actually waits
 * on it. Stored as a `Promise`, not awaited here, so {@link renderSetup}'s own synchronous `void`
 * return is honoured (the very first paint -- step 1's acknowledgement gate -- must not wait on
 * anything async): step 6 is the one place that awaits it, by which point a human has spent at
 * least long enough reading three screens and typing two fields for it to have long since
 * resolved. */
interface WizardState {
  identityPromise: Promise<{ identity: string; recipient: string }>
  token: string
  store: GithubStore | null
  passphrase: string
}

/** Entry point (src/main.ts calls this when {@link Deps.local}'s `getWrappedIdentity()` is
 * `null`). Declared to return `void`, not `Promise<void>`: the first step's DOM must be mounted
 * synchronously on this call, matching the Interfaces block's own signature -- see
 * {@link WizardState}'s own doc comment for why generating the device identity does not block
 * that. */
export function renderSetup(root: HTMLElement, deps: Deps): void {
  const state: WizardState = {
    identityPromise: generateDeviceIdentity(),
    token: "",
    store: null,
    passphrase: "",
  }
  renderWelcomeStep(root, deps, state)
}

/** Common chrome for every step: a "Step N of 6" progress line (spec §9's "six steps" framing,
 * made visible to the person actually clicking through them) plus a heading, wrapping
 * step-specific body markup. */
function shell(step: number, title: string, bodyHtml: string): string {
  return `
    <section class="wizard-step" aria-label="${title}">
      <p class="wizard-progress">Step ${step} of ${TOTAL_STEPS}</p>
      <h1>${title}</h1>
      ${bodyHtml}
    </section>
  `
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector)
  if (!el) throw new Error(`setup wizard: expected to find "${selector}" in the current step`)
  return el
}

// ---------------------------------------------------------------------------------------------
// Step 1: Welcome + acknowledgement (spec §5.5 -- the one irreversible property, not softened).
// ---------------------------------------------------------------------------------------------

function renderWelcomeStep(root: HTMLElement, deps: Deps, state: WizardState): void {
  root.innerHTML = shell(
    1,
    "Welcome to eigenheim",
    `
      <p>eigenheim stores one text file, encrypted in your own browser, inside your own private
      GitHub repository. Nobody else -- not GitHub, not the people who wrote this app -- can ever
      read it.</p>
      <p><strong>There is no password reset and no recovery key.</strong> The passphrase you
      choose in a few steps is the only way back in. If it is forgotten, the data is gone --
      permanently, with no appeal.</p>
      <label class="wizard-checkbox">
        <input type="checkbox" id="ack-checkbox">
        I understand that if I forget my passphrase, my data cannot be recovered.
      </label>
      <div class="wizard-actions">
        <button type="button" id="continue-btn" disabled>Continue</button>
      </div>
    `,
  )

  const checkbox = required<HTMLInputElement>(root, "#ack-checkbox")
  const continueBtn = required<HTMLButtonElement>(root, "#continue-btn")
  checkbox.addEventListener("change", () => {
    continueBtn.disabled = !checkbox.checked
  })
  continueBtn.addEventListener("click", () => renderRepoIdentityStep(root, deps, state))
}

// ---------------------------------------------------------------------------------------------
// Step 2: Repo identity, shown not asked (spec §9 step 2 -- repoOwner()/repoSlug() come from
// Task 1's build-time injection; the user never types their own repo name).
// ---------------------------------------------------------------------------------------------

function renderRepoIdentityStep(root: HTMLElement, deps: Deps, state: WizardState): void {
  root.innerHTML = shell(
    2,
    "Your repository",
    `
      <p>Your vault will live in the private GitHub repository this app was deployed from:</p>
      <p class="wizard-repo"><code>${repoOwner()}/${repoSlug()}</code></p>
      <p>GitHub only ever stores the encrypted file -- never your passphrase, never the plain
      text.</p>
      <div class="wizard-actions">
        <button type="button" id="continue-btn">Continue</button>
      </div>
    `,
  )

  required<HTMLButtonElement>(root, "#continue-btn").addEventListener("click", () =>
    renderTokenStep(root, deps, state),
  )
}

// ---------------------------------------------------------------------------------------------
// Step 3: Token walkthrough (spec §9 step 3, §6.7). Validated by `ensureSetup()`; the repo-public
// and bad-token states render inline, right here, with the action that fixes them (spec §13).
// ---------------------------------------------------------------------------------------------

const TOKEN_CREATE_URL = "https://github.com/settings/personal-access-tokens/new"

function renderTokenStep(root: HTMLElement, deps: Deps, state: WizardState): void {
  root.innerHTML = shell(
    3,
    "Connect your GitHub repository",
    `
      <ol class="wizard-walkthrough">
        <li>Open <a href="${TOKEN_CREATE_URL}" target="_blank" rel="noopener">GitHub's fine-grained
          token page</a>.</li>
        <li>Give it any name, e.g. "eigenheim".</li>
        <li>Under "Repository access", choose "Only select repositories" and pick
          <code>${repoOwner()}/${repoSlug()}</code>.</li>
        <li>Under "Repository permissions", set <strong>Contents</strong> to
          <strong>Read and write</strong>.</li>
        <li>Generate the token and paste it below.</li>
      </ol>
      <label for="token-input">Personal access token</label>
      <input type="text" id="token-input" autocomplete="off" spellcheck="false">
      <div id="token-feedback" class="wizard-feedback" role="alert" hidden></div>
      <div class="wizard-actions">
        <button type="button" id="continue-btn" disabled>Continue</button>
      </div>
    `,
  )

  const tokenInput = required<HTMLInputElement>(root, "#token-input")
  const feedback = required<HTMLDivElement>(root, "#token-feedback")
  const continueBtn = required<HTMLButtonElement>(root, "#continue-btn")

  tokenInput.addEventListener("input", () => {
    continueBtn.disabled = tokenInput.value.trim().length === 0
  })

  function showFeedback(html: string): void {
    feedback.innerHTML = html
    feedback.hidden = false
  }

  async function attemptValidate(): Promise<void> {
    continueBtn.disabled = true
    const store = deps.makeStore(tokenInput.value)
    try {
      const { ready } = await store.ensureSetup()
      if (ready) {
        showFeedback(
          `<p>This repository already has a vault set up. If you are adding a second device,
           use the QR transfer from Settings on your already-set-up device instead of this
           wizard.</p>`,
        )
        continueBtn.disabled = tokenInput.value.trim().length === 0
        return
      }
      state.token = tokenInput.value
      state.store = store
      renderPassphraseStep(root, deps, state)
    } catch (err) {
      if (err instanceof RepoPublicError) {
        showFeedback(`${errorRecoveryHtml(err)}<button type="button" id="recheck-btn">Check again</button>`)
        required<HTMLButtonElement>(root, "#recheck-btn").addEventListener("click", () => {
          void attemptValidate()
        })
      } else {
        showFeedback(errorRecoveryHtml(err))
        continueBtn.disabled = tokenInput.value.trim().length === 0
      }
    }
  }

  continueBtn.addEventListener("click", () => void attemptValidate())
}

/** Minimal HTML-escaping for error text before it is interpolated into an `innerHTML` template.
 * Every message passed through here originates from this project's own code (GithubStore's
 * crafted error strings, or a native `Error#message`) rather than from anything the user typed,
 * so this is defence in depth, not a closed injection vector -- the same spirit as
 * src/store/github.ts's own `repoPath` encoding its (also never user-typed) owner/repo
 * segments. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** The message plus the one link that actually fixes `err`, shared between step 3's token
 * validation and step 6's initialize attempt (review finding 3): `RepoPublicError`/`TokenError`
 * can both recur at step 6 too -- e.g. the repo flips public again in the gap between step 3's
 * check and clicking "Create my vault" at step 6 -- and spec §13's "a visible way forward"
 * requirement does not expire after the first time an error type is shown. Returns HTML only,
 * no button: step 3 appends its own "Check again" (which re-validates the token step's own
 * fields); step 6 doesn't need an equivalent button, since its own "Create my vault" button is
 * already re-clickable and re-runs the exact same attempt. */
function errorRecoveryHtml(err: unknown): string {
  if (err instanceof RepoPublicError) {
    const settingsUrl = `https://github.com/${repoOwner()}/${repoSlug()}/settings`
    return `
      <p>${escapeHtml(err.message)} -- a private repository is required so the encrypted
      file is never world-readable.</p>
      <p><a href="${settingsUrl}" target="_blank" rel="noopener">Repository settings</a></p>
    `
  }
  if (err instanceof TokenError) {
    return `
      <p>${escapeHtml(err.message)}</p>
      <p>Follow the steps above again, or
        <a href="${TOKEN_CREATE_URL}" target="_blank" rel="noopener">create a new token</a>.</p>
    `
  }
  return `<p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
}

// ---------------------------------------------------------------------------------------------
// Step 4: Passphrase (spec §5.5). Prefilled generated passphrase, inline floor feedback, re-type
// confirmation -- the three rules enumerated in src/vault/passphrase.ts are enforced by
// `checkPassphrase` alone; this step only surfaces its verdict.
// ---------------------------------------------------------------------------------------------

function renderPassphraseStep(root: HTMLElement, deps: Deps, state: WizardState): void {
  const generated = generatePassphrase()

  root.innerHTML = shell(
    4,
    "Choose your passphrase",
    `
      <p>This is generated for you and is safe to use as-is, or replace it with one of your own --
      either way it must be at least 20 characters and not a well-known password.</p>
      <label for="passphrase-input">Passphrase</label>
      <input type="text" id="passphrase-input" autocomplete="off" spellcheck="false">
      <p id="passphrase-feedback" class="wizard-feedback" data-testid="passphrase-feedback" role="alert" hidden></p>
      <label for="passphrase-confirm">Confirm passphrase</label>
      <input type="text" id="passphrase-confirm" autocomplete="off" spellcheck="false">
      <p id="match-feedback" class="wizard-feedback" hidden>Does not match the passphrase above yet.</p>
      <div class="wizard-actions">
        <button type="button" id="continue-btn" disabled>Continue</button>
      </div>
    `,
  )

  const passphraseInput = required<HTMLInputElement>(root, "#passphrase-input")
  passphraseInput.value = generated
  const confirmInput = required<HTMLInputElement>(root, "#passphrase-confirm")
  const floorFeedback = required<HTMLParagraphElement>(root, "#passphrase-feedback")
  const matchFeedback = required<HTMLParagraphElement>(root, "#match-feedback")
  const continueBtn = required<HTMLButtonElement>(root, "#continue-btn")

  function revalidate(): void {
    const check = checkPassphrase(passphraseInput.value)
    if (check.ok) {
      floorFeedback.hidden = true
      floorFeedback.textContent = ""
    } else {
      floorFeedback.textContent = check.reason
      floorFeedback.hidden = false
    }

    const matches = normalizePassphrase(passphraseInput.value) === normalizePassphrase(confirmInput.value)
    matchFeedback.hidden = matches || confirmInput.value.length === 0

    continueBtn.disabled = !check.ok || !matches
  }

  passphraseInput.addEventListener("input", revalidate)
  confirmInput.addEventListener("input", revalidate)
  revalidate()

  continueBtn.addEventListener("click", () => {
    state.passphrase = normalizePassphrase(passphraseInput.value)
    renderSheetStep(root, deps, state)
  })
}

// ---------------------------------------------------------------------------------------------
// Step 5: Printable sheet (spec §5.5 -- "backup hygiene for the one secret, not a second door").
// ---------------------------------------------------------------------------------------------

function renderSheetStep(root: HTMLElement, deps: Deps, state: WizardState): void {
  root.innerHTML = shell(
    5,
    "Write this down",
    `
      <p>Print this or copy it somewhere safe. It is the only way back into your data if this app
      is ever unavailable.</p>
      <div data-testid="recovery-sheet" class="wizard-sheet">
        <p>Repository: <code id="sheet-repo"></code></p>
        <p>Passphrase: <code id="sheet-passphrase"></code></p>
        <p>Recovery command (needs the <a href="https://age-encryption.org" target="_blank" rel="noopener">age</a> CLI):</p>
        <pre id="sheet-command"></pre>
      </div>
      <div class="wizard-actions">
        <button type="button" id="print-btn">Print</button>
        <button type="button" id="continue-btn">Continue</button>
      </div>
    `,
  )

  // Set via textContent, never interpolated into the innerHTML template above: the passphrase is
  // full Unicode with no character-set restriction (spec §5.5) and could contain HTML-significant
  // characters (<, &, ...) if the user replaced the generated one with their own.
  required<HTMLElement>(root, "#sheet-repo").textContent = `${repoOwner()}/${repoSlug()}`
  required<HTMLElement>(root, "#sheet-passphrase").textContent = state.passphrase
  required<HTMLElement>(root, "#sheet-command").textContent = `age -d ${VAULT_PATH}`

  required<HTMLButtonElement>(root, "#print-btn").addEventListener("click", () => window.print())
  required<HTMLButtonElement>(root, "#continue-btn").addEventListener("click", () =>
    renderInitializeStep(root, deps, state),
  )
}

// ---------------------------------------------------------------------------------------------
// Step 6: Initialize the data branch, then hand off to whatever src/main.ts does next (spec §9
// step 5-6).
// ---------------------------------------------------------------------------------------------

/** What {@link finishSetup} needs -- a narrower, explicit shape rather than {@link WizardState}
 * itself, so a non-null `store` is a type-level guarantee instead of a runtime check this
 * function has to repeat (the caller, which alone knows whether step 3 ever completed, performs
 * that narrowing once before calling this). */
export interface FinishSetupParams {
  passphrase: string
  token: string
  store: GithubStore
  identityPromise: Promise<{ identity: string; recipient: string }>
}

/** The actual work of step 6, extracted from the button click-handler so it is a plain,
 * DOM-free `async function` a unit test can call directly (review finding 2 -- every step's real
 * work used to live inline inside a DOM click-handler closure, which is why this project's only
 * regression coverage for anything in this file was a 6.5s Playwright run). Initializes the data
 * branch, wraps the device identity and token, and persists all three local writes -- in an order
 * that is itself load-bearing, not incidental (review finding 1): `putWrappedIdentity` is written
 * **last**, after `putToken` and `putCachedVault` have both durably landed, because
 * `src/main.ts`'s only "is this device already set up" gate is `getWrappedIdentity() !== null`.
 * `src/store/local.ts`'s `putSlot` opens a fresh IndexedDB transaction per call rather than
 * sharing one across the three, so any failure after the first of these writes (quota, tab
 * closed, power loss -- no network involved) can strand a device mid-sequence; writing the gating
 * value last means that failure always leaves `getWrappedIdentity()` null, so a reload cleanly
 * re-enters this wizard instead of being stuck with a routing gate that says "already set up" and
 * nothing valid to unlock with. Persists nothing at all until `initializeDataBranch` has actually
 * succeeded, for the same reason, one step earlier.
 *
 * Sequential throughout, never `Promise.all`: this project's own Global Constraint is that the
 * two scrypt runs (encrypting the empty vault, wrapping the device identity) must never be
 * concurrent (spec §5.4). */
export async function finishSetup(params: FinishSetupParams, local: LocalStore): Promise<Session> {
  const armored = await encryptVault("", params.passphrase)
  const { sha } = await params.store.initializeDataBranch({ armored })

  const { identity, recipient } = await params.identityPromise
  const wrappedIdentity = await wrapIdentity(identity, params.passphrase)
  const wrappedToken = await encryptToRecipient(params.token, recipient)

  await local.putToken(wrappedToken)
  await local.putCachedVault({ armored, sha })
  await local.putWrappedIdentity(wrappedIdentity)

  return { text: "", baseSha: sha, token: params.token, identity, passphrase: params.passphrase }
}

function renderInitializeStep(root: HTMLElement, deps: Deps, state: WizardState): void {
  root.innerHTML = shell(
    6,
    "Create your vault",
    `
      <p>This is the last step: it creates the encrypted vault on GitHub.</p>
      <div id="init-feedback" class="wizard-feedback" role="alert" hidden></div>
      <div class="wizard-actions">
        <button type="button" id="finish-btn">Create my vault</button>
      </div>
    `,
  )

  const finishBtn = required<HTMLButtonElement>(root, "#finish-btn")
  const feedback = required<HTMLDivElement>(root, "#init-feedback")

  finishBtn.addEventListener("click", () => {
    void (async () => {
      finishBtn.disabled = true
      feedback.hidden = true
      try {
        if (!state.store) throw new Error("setup wizard: no GitHub store -- the token step never completed")
        const session = await finishSetup(
          { passphrase: state.passphrase, token: state.token, store: state.store, identityPromise: state.identityPromise },
          deps.local,
        )
        deps.onComplete(session)
      } catch (err) {
        // Review finding 3: reuse step 3's own rich RepoPublicError/TokenError handling here too
        // -- the repo can flip public again, or the token can be revoked, in the gap between
        // step 3's check and clicking "Create my vault", and spec §13's "visible way forward"
        // applies on every occurrence, not just the first.
        feedback.innerHTML = errorRecoveryHtml(err)
        feedback.hidden = false
        finishBtn.disabled = false
      }
    })()
  })
}
