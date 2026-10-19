// Setup wizard (spec §9's one-click onboarding; §5.5's acknowledgement and passphrase floor;
// §13's visibility guard). The only UI a first-time user ever sees, and the thing every later
// view's own structure follows (this is the first UI task). No framework (spec §4) -- plain DOM
// APIs, matching the Vite template's original innerHTML-template-plus-addEventListener
// convention (src/main.ts). One step's markup mounted in `root` at a time; earlier steps are discarded, not
// hidden, so there is never more than one of a repeated control (e.g. "Continue") in the DOM --
// this is what lets a test select `getByRole("button", { name: /continue/i })` with no extra
// scoping.
//
// Not a strictly forward-only sequence: step 6's `TokenError` recovery routes back to step 3
// (ruling R30), so any step can in principle be rendered more than once within one setup. Every
// render function therefore has to read what it needs out of `WizardState` rather than
// regenerating it -- see `prefillPassphrase`, which exists precisely because step 4 did not, and
// would have silently handed a returning user a different passphrase than the one on the recovery
// sheet they already printed. Keep that property when adding steps or back-routes here.
//
// This file has no Node types available (tsconfig.app.json covers `src/`) and must stay that way.

import type { GithubStore } from "../store/github"
import type { LocalStore } from "../store/local"
import type { Session } from "../session/unlock"
import { repoOwner, repoSlug, VAULT_PATH } from "../config"
import { generateDeviceIdentity, wrapIdentity } from "../vault/identity"
import { encryptVault, encryptToRecipient, decryptVault, WrongPassphraseError } from "../vault/crypto"
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

      <details class="wizard-transfer" data-testid="transfer-details">
        <summary>I already set this up on another device</summary>
        <p>Open <strong>Settings &rarr; Add another device</strong> there and reveal the transfer
          code. Scan it, or paste the text form below — it carries the token, so you do not need
          to create a second one.</p>
        <button type="button" id="scan-btn" data-testid="scan-btn" hidden>Scan the code with this camera</button>
        <label for="transfer-input">Transfer code</label>
        <textarea id="transfer-input" data-testid="transfer-input" rows="3" spellcheck="false"></textarea>
        <div id="transfer-feedback" class="wizard-feedback" data-testid="transfer-feedback" role="alert" hidden></div>
        <button type="button" id="use-transfer" data-testid="use-transfer">Use this code</button>
      </details>
    `,
  )

  const tokenInput = required<HTMLInputElement>(root, "#token-input")
  const feedback = required<HTMLDivElement>(root, "#token-feedback")
  const continueBtn = required<HTMLButtonElement>(root, "#continue-btn")

  tokenInput.addEventListener("input", () => {
    continueBtn.disabled = tokenInput.value.trim().length === 0
  })

  // --- transfer from an already-set-up device (task 18) --------------------------------------
  const transferInput = required<HTMLTextAreaElement>(root, "#transfer-input")
  const transferFeedback = required<HTMLDivElement>(root, "#transfer-feedback")
  const scanBtn = required<HTMLButtonElement>(root, "#scan-btn")

  // Offered only when the browser can actually do it. Never blocking on it: `BarcodeDetector` is
  // absent in Firefox and Safari entirely, and absent in Chromium without a camera, so the paste
  // field is the primary path and scanning is the shortcut -- not the other way round.
  if (barcodeScanningAvailable()) scanBtn.hidden = false

  scanBtn.addEventListener("click", () => {
    void (async () => {
      transferFeedback.hidden = true
      const scanned = await scanTransferCode()
      if (scanned === null) {
        transferFeedback.textContent =
          "The camera could not be used for scanning. Paste the text form of the code below instead — it works the same way."
        transferFeedback.hidden = false
        return
      }
      transferInput.value = scanned
    })()
  })

  required<HTMLButtonElement>(root, "#use-transfer").addEventListener("click", () => {
    const parsed = parseTransferPayload(transferInput.value)
    if (parsed.kind === "invalid") {
      transferFeedback.textContent = parsed.message
      transferFeedback.hidden = false
      return
    }
    transferFeedback.hidden = true
    // The payload's token is put through the SAME validation every manually-pasted token gets:
    // a transfer code is a convenience, not a reason to trust a credential less carefully.
    tokenInput.value = parsed.payload.token
    continueBtn.disabled = false
    void attemptValidate()
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
      state.token = tokenInput.value
      state.store = store
      if (ready) {
        // The repository already holds a vault, so there is nothing to initialise -- this device
        // JOINS it instead (task 18). This branch is also the whole of ruling R29's fix: it used
        // to dead-end here, telling the user to use the QR transfer from an already-set-up
        // device, which is unhelpful for a second device (that IS what they are doing) and
        // actively impossible for a device stranded by a mid-setup failure, where the only
        // already-set-up device is this one. Either way the way forward is the same and is now
        // taken automatically: ask for the passphrase and adopt the existing vault.
        renderAdoptStep(root, deps, state)
        return
      }
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
 * requirement does not expire after the first time an error type is shown.
 *
 * Returns HTML only, never a button: each step appends whatever affordance actually works *there*
 * (step 3 its own "Check again", which re-validates its own fields; step 6 its own route back to
 * step 3 for the one error step 6 cannot act on). The copy below is therefore written to be true
 * at BOTH call sites -- re-review NEW-1 / ruling R30 is precisely what happens when it is not:
 * the TokenError branch used to say "Follow the steps above again", which named step 3's
 * walkthrough markup and silently became a lie the moment fix round 1 reused this function at
 * step 6, where that markup does not exist. Nothing positional ("above", "below") and nothing
 * naming a control that only one step has belongs in here.
 *
 * Exported (re-review NEW-3) solely so tests/unit/setup.test.ts can cover all three branches and
 * the escaping without a browser: this is a pure `(err: unknown) => string`, and before that it
 * was reachable only through two ~6.5s Playwright tests that between them touched one branch. */
export function errorRecoveryHtml(err: unknown): string {
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
      <p>This token cannot be used as it is.
        <a href="${TOKEN_CREATE_URL}" target="_blank" rel="noopener">Create a new token</a> with
        <strong>Contents: Read and write</strong> on <code>${repoOwner()}/${repoSlug()}</code>,
        then enter it again.</p>
    `
  }
  return `<p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
}

// ---------------------------------------------------------------------------------------------
// Second-device transfer (task 18, spec §9). A transfer code carries the repo coordinates and
// the GitHub token from an already-set-up device, so a second device never has to create a
// second token. The PASSPHRASE is deliberately not in it and never will be -- it is the one
// secret this project never transmits, so joining a vault always costs the user one typed
// passphrase, which is also the only thing that can actually decrypt anything.
// ---------------------------------------------------------------------------------------------

/** What a transfer code decodes to. Mirrors `TransferPayload` in src/ui/settings.ts, which is
 * the producing side. */
export interface TransferPayload {
  owner: string
  repo: string
  token: string
}

export type TransferParse = { kind: "ok"; payload: TransferPayload } | { kind: "invalid"; message: string }

/** Parses and validates a pasted or scanned transfer code.
 *
 * Every rejection names what is actually wrong rather than "invalid code", because the realistic
 * failures here are mundane and each has a different fix: a half-copied string, a code from a
 * DIFFERENT repository's deployment, or something that is not a transfer code at all. Spec §13
 * asks for a way forward, and "invalid" is not one. */
export function parseTransferPayload(text: string): TransferParse {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { kind: "invalid", message: "Paste the transfer code first." }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return {
      kind: "invalid",
      message:
        "That does not look like a transfer code. Copy the whole text shown under the QR on your other device — it starts with { and ends with }.",
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "invalid", message: "That transfer code is not in the expected form." }
  }
  const { owner, repo, token } = parsed as Record<string, unknown>
  if (typeof owner !== "string" || typeof repo !== "string" || typeof token !== "string") {
    return {
      kind: "invalid",
      message: "That transfer code is incomplete — it is missing the repository or the token. Copy the whole thing and try again.",
    }
  }
  if (owner !== repoOwner() || repo !== repoSlug()) {
    return {
      kind: "invalid",
      message: `That code is for ${owner}/${repo}, but this app is deployed for ${repoOwner()}/${repoSlug()}. Use the deployment that matches, or take the code from a device set up for this one.`,
    }
  }
  return { kind: "ok", payload: { owner, repo, token } }
}

/** Whether this browser can scan a QR from the camera.
 *
 * `BarcodeDetector` is genuinely absent in Firefox and Safari, and absent in Chromium without a
 * camera, so this is a real branch rather than defensive decoration -- and the paste field
 * exists precisely so no part of onboarding ever depends on the answer being yes. */
export function barcodeScanningAvailable(): boolean {
  return typeof (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector !== "undefined"
}

/** Opens the camera, reads one QR, and returns its text — or null if anything at all prevents
 * that. Null rather than a throw: the caller's response is identical for every cause (fall back
 * to the paste field), and a rejected camera permission is not an error worth a stack trace. */
export async function scanTransferCode(): Promise<string | null> {
  if (!barcodeScanningAvailable()) return null
  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
    const video = document.createElement("video")
    video.srcObject = stream
    video.playsInline = true
    await video.play()

    const Detector = (globalThis as unknown as { BarcodeDetector: new (o: { formats: string[] }) => { detect(src: CanvasImageSource): Promise<Array<{ rawValue: string }>> } }).BarcodeDetector
    const detector = new Detector({ formats: ["qr_code"] })

    // Bounded: a scan that never finds a code must give the paste field back rather than hold
    // the camera open forever.
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const found = await detector.detect(video)
      if (found.length > 0) return found[0].rawValue
      await new Promise((r) => setTimeout(r, 200))
    }
    return null
  } catch {
    return null
  } finally {
    stream?.getTracks().forEach((t) => t.stop())
  }
}

/** Joins a vault that already exists on the repo: decrypt it with the passphrase the user types,
 * then store this device's own slots.
 *
 * Writes `putWrappedIdentity` LAST, after the token and the cached vault — the same ordering
 * ruling R27 established for {@link finishSetup}, for the same reason: src/main.ts's only
 * "already set up" gate is `getWrappedIdentity() !== null`, so the gating value must be the one
 * thing proven safe to write. A failure anywhere earlier leaves that null and the device simply
 * re-enters this wizard.
 *
 * A wrong passphrase is returned as an outcome rather than thrown, because it is the single most
 * likely thing to happen here and is not an error anyone needs to debug. */
export type AdoptOutcome =
  | { kind: "joined"; session: Session }
  | { kind: "wrong-passphrase" }
  | { kind: "failed"; message: string }

export async function adoptExistingVault(
  typed: string,
  params: { token: string; store: GithubStore; identityPromise: Promise<{ identity: string; recipient: string }> },
  local: LocalStore,
): Promise<AdoptOutcome> {
  const passphrase = normalizePassphrase(typed)
  if (passphrase.length === 0) return { kind: "failed", message: "Type the passphrase from your other device." }

  let head: { armored: string; sha: string }
  try {
    head = await params.store.readHead()
  } catch (err) {
    return { kind: "failed", message: err instanceof Error ? err.message : String(err) }
  }

  let text: string
  try {
    text = await decryptVault(head.armored, passphrase)
  } catch (err) {
    if (err instanceof WrongPassphraseError) return { kind: "wrong-passphrase" }
    return { kind: "failed", message: err instanceof Error ? err.message : String(err) }
  }

  const { identity, recipient } = await params.identityPromise
  const wrappedIdentity = await wrapIdentity(identity, passphrase)
  const wrappedToken = await encryptToRecipient(params.token, recipient)

  await local.putToken(wrappedToken)
  await local.putCachedVault({ armored: head.armored, sha: head.sha })
  await local.putWrappedIdentity(wrappedIdentity)

  return { kind: "joined", session: { text, baseSha: head.sha, token: params.token, identity, passphrase } }
}

/** The adopt step: the only thing left to ask for is the passphrase. */
function renderAdoptStep(root: HTMLElement, deps: Deps, state: WizardState): void {
  root.innerHTML = shell(
    4,
    "Unlock the existing vault",
    `
      <p data-testid="adopt-intro">This repository already holds a vault, so there is nothing to
        create — this device just needs to join it. Type the passphrase you chose when you first
        set it up. It is never sent anywhere.</p>
      <label for="adopt-passphrase">Passphrase</label>
      <input type="password" id="adopt-passphrase" data-testid="adopt-passphrase" autocomplete="current-password" spellcheck="false">
      <p id="adopt-feedback" class="wizard-feedback" data-testid="adopt-feedback" role="alert" hidden></p>
      <p id="adopt-progress" class="unlock-progress" data-testid="adopt-progress" role="status" hidden>Decrypting the vault…</p>
      <div class="wizard-actions">
        <button type="button" id="adopt-btn" data-testid="adopt-btn">Join this vault</button>
      </div>
    `,
  )

  const input = required<HTMLInputElement>(root, "#adopt-passphrase")
  const feedback = required<HTMLParagraphElement>(root, "#adopt-feedback")
  const progress = required<HTMLParagraphElement>(root, "#adopt-progress")
  const button = required<HTMLButtonElement>(root, "#adopt-btn")

  let running = false
  async function attempt(): Promise<void> {
    // Guarded, not merely disabled: Enter is a second trigger, and two concurrent attempts mean
    // two concurrent scrypt runs, which spec §5.4 forbids outright.
    if (running) return
    if (!state.store) throw new Error("setup wizard: no GitHub store -- the token step never completed")
    running = true
    button.disabled = true
    feedback.hidden = true
    progress.hidden = false

    const outcome = await adoptExistingVault(
      input.value,
      { token: state.token, store: state.store, identityPromise: state.identityPromise },
      deps.local,
    )

    progress.hidden = true
    running = false
    button.disabled = false

    if (outcome.kind === "joined") {
      input.value = ""
      deps.onComplete(outcome.session)
      return
    }
    feedback.textContent =
      outcome.kind === "wrong-passphrase"
        ? "That passphrase did not open this vault. Check for a typo — including capitals — and try again. It is the passphrase from your other device, not a new one."
        : outcome.message
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

// ---------------------------------------------------------------------------------------------
// Step 4: Passphrase (spec §5.5). Prefilled generated passphrase, inline floor feedback, re-type
// confirmation -- the three rules enumerated in src/vault/passphrase.ts are enforced by
// `checkPassphrase` alone; this step only surfaces its verdict.
// ---------------------------------------------------------------------------------------------

/** What step 4's passphrase field is prefilled with: the passphrase already chosen in this
 * setup, if there is one, and a freshly generated one otherwise (spec §5.5's six diceware words).
 *
 * The `existing` branch exists because of ruling R30: step 6's `TokenError` recovery routes back
 * to step 3, so step 4 can be rendered a SECOND time within one setup. Generating unconditionally
 * -- which is what this step did before -- would have walked that user forward with a different
 * passphrase than the one on the recovery sheet they already printed at step 5, silently
 * invalidating the only artifact this project offers in place of a password reset (spec §2: no
 * recovery key, no reset, ever). Making the wizard re-entrant is the point, not a side effect:
 * six more UI tasks follow this file's structure.
 *
 * A separate exported function rather than two lines inline, for ruling R28's reason: it is the
 * whole of the decision, it needs no DOM, and tests/unit/setup.test.ts can therefore pin both of
 * its branches without a browser. Deliberately NOT described as pure (re-review NEW-3 corrected
 * exactly that word here): the `generate` branch draws from `crypto.getRandomValues` via
 * `generatePassphrase`, so it returns something different on every call -- which is why the test
 * for that branch asserts the result is a valid fresh passphrase rather than any fixed value. The
 * `existing` branch is the only deterministic one. */
export function prefillPassphrase(existing: string): string {
  return existing.length > 0 ? existing : generatePassphrase()
}

function renderPassphraseStep(root: HTMLElement, deps: Deps, state: WizardState): void {
  const prefill = prefillPassphrase(state.passphrase)

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
  passphraseInput.value = prefill
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
 * concurrent (spec §5.4) -- two logN=17 runs in flight at once peak near 256 MiB and can get a
 * mobile tab discarded, which costs a user access to their own data. Spec §11 is explicit that
 * this sentence is not enough on its own, because the constraint "would read like a pointless
 * pessimisation to a future optimiser", so it is pinned by tests/unit/setup.test.ts's
 * "finishSetup never runs two scrypt operations concurrently" (re-review NEW-2 -- until that
 * test existed, nothing in the suite would have failed on a `Promise.all` of these two lines,
 * verified by making exactly that change and watching all 138 tests pass but one). */
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
        //
        // Re-review NEW-1 / ruling R30: the shared message alone is a way forward for only ONE of
        // those two. `RepoPublicError` is genuinely actionable from here as-is -- its own link
        // goes to the repo's settings, and this step's "Create my vault" button is already
        // re-clickable, so flip the repo private and click again. `TokenError` is not: a broken
        // token cannot be fixed from a step that has no token field, and re-clicking just re-runs
        // the identical attempt with the identical token, forever. So that one branch, and only
        // that one, gets its own affordance -- back to step 3, where the walkthrough and the input
        // actually are -- appended to the shared message exactly the way step 3 appends its own
        // "Check again" to it. Routing back is safe to do mid-wizard only because
        // `prefillPassphrase` makes step 4 re-entrant; see its doc comment.
        if (err instanceof TokenError) {
          feedback.innerHTML = `${errorRecoveryHtml(err)}<button type="button" id="retoken-btn">Enter a different token</button>`
          required<HTMLButtonElement>(root, "#retoken-btn").addEventListener("click", () =>
            renderTokenStep(root, deps, state),
          )
        } else {
          feedback.innerHTML = errorRecoveryHtml(err)
        }
        feedback.hidden = false
        finishBtn.disabled = false
      }
    })()
  })
}
