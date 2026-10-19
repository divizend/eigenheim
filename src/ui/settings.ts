// Settings (spec §9's second-device transfer, §5.5's passphrase rotation, §10.2's supply-chain
// integrity display, §13's every-failure-has-a-way-forward).
//
// Four unrelated jobs share one screen because each is rare, each is consequential, and none
// deserves its own permanent chrome next to the document: move this vault to another device,
// replace the GitHub token, change the passphrase, and check what code is actually running.
//
// Ruling R28: decisions are DOM-free exports; `renderSettings` is wiring.
// Ruling R32: the claims below that assert a set or a count carry the command that establishes
// them. This file has no Node types available (tsconfig.app.json covers `src/`).

import QRCode from "qrcode"
import type { GithubStore } from "../store/github"
import type { LocalStore } from "../store/local"
import type { Session } from "../session/unlock"
import { BUILD_COMMIT, repoOwner, repoSlug, VAULT_PATH } from "../config"
import { encryptVault, encryptToRecipient } from "../vault/crypto"
import { wrapIdentity, recipientFor } from "../vault/identity"
import { checkPassphrase, normalizePassphrase } from "../vault/passphrase"
import { commit } from "../session/sync"
import type { SessionIO } from "./editor"

/** The payload a second device needs to join this vault (spec §9). Deliberately the smallest
 * set that works: the repo coordinates are already baked into the deployed bundle, but a
 * transfer that carries them is one that still works if the second device opens a different
 * deployment of the same app. The passphrase is NOT here and never will be -- it is the one
 * secret this project never transmits, by design (spec §5). */
export interface TransferPayload {
  owner: string
  repo: string
  token: string
}

/** Serialises the transfer payload. JSON rather than a bespoke encoding so task 18's parser on
 * the receiving side is `JSON.parse` plus validation, with no format to get subtly wrong. */
export function transferPayload(token: string): string {
  return JSON.stringify({ owner: repoOwner(), repo: repoSlug(), token } satisfies TransferPayload)
}

/** What a token replacement can end as. */
export type TokenChange = { kind: "stored" } | { kind: "rejected"; message: string }

/** Validates a replacement token against the real repo BEFORE storing it.
 *
 * Validated first, deliberately: storing an unchecked token would replace a working credential
 * with a broken one and only reveal it at the next save. `ensureSetup` is the same check the
 * setup wizard's token step runs, so a token accepted here is accepted on exactly the same
 * terms as one accepted at onboarding. */
export async function replaceToken(
  typed: string,
  makeStore: (token: string) => GithubStore,
  storeToken: (token: string) => Promise<void>,
): Promise<TokenChange> {
  const token = typed.trim()
  if (token.length === 0) return { kind: "rejected", message: "Paste a token first." }

  try {
    await makeStore(token).ensureSetup()
  } catch (err) {
    return { kind: "rejected", message: err instanceof Error ? err.message : String(err) }
  }
  await storeToken(token)
  return { kind: "stored" }
}

/** What a passphrase rotation can end as. */
export type PassphraseChange =
  | { kind: "changed" }
  | { kind: "rejected"; message: string }
  | { kind: "failed"; message: string }

/** Changes the passphrase: re-encrypt the vault, re-wrap the device identity, commit, then
 * replace both local slots.
 *
 * The ORDER is the whole design, and it is chosen so that every point at which this can fail
 * leaves a device that still works under one passphrase -- never one that works under neither:
 *
 *   1. Check the new passphrase against the floor. Nothing has changed if it fails.
 *   2. Encrypt the current text under the new passphrase, and wrap the identity under it. Both
 *      are pure computations; still nothing has changed anywhere.
 *   3. Commit the re-encrypted vault to GitHub. THIS is the irreversible step, and it is taken
 *      before any local write: if it fails, the old passphrase still opens everything, here and
 *      on every other device.
 *   4. Replace the two local passphrase-protected slots in ONE IndexedDB transaction (see
 *      `LocalStore.putRotatedPassphraseSlots` for why that atomicity is not optional).
 *
 * `token.age` and `draft.age` are deliberately untouched: both are encrypted to the device
 * IDENTITY rather than the passphrase, so a rotation does not invalidate them -- verified by
 * reading the writers, `grep -n 'encryptToRecipient' src/` reports exactly src/ui/setup.ts,
 * src/ui/editor.ts and src/vault/crypto.ts's own definition, and neither caller passes a
 * passphrase.
 *
 * What this honestly cannot do, and what the UI must therefore say (spec §13): every EARLIER
 * commit in the git history stays encrypted under the old passphrase. Nothing rewrites history
 * here, so the old passphrase remains the only way to read those versions. */
export async function changePassphrase(
  typed: string,
  session: Session,
  io: SessionIO,
  text: string,
): Promise<PassphraseChange> {
  const next = normalizePassphrase(typed)
  const check = checkPassphrase(next)
  if (!check.ok) return { kind: "rejected", message: check.reason }
  if (next === session.passphrase) {
    return { kind: "rejected", message: "That is already your passphrase." }
  }
  if (session.token === null) {
    return {
      kind: "failed",
      message:
        "This device has no usable GitHub token, so the re-encrypted vault cannot be saved. Replace the token above first — changing the passphrase locally alone would leave this device unable to read its own vault on GitHub.",
    }
  }

  // Sequential, never Promise.all: two logN=17 scrypt runs (spec §5.4), which must never be
  // concurrent on pain of a mobile tab being discarded mid-rotation.
  const armored = await encryptVault(text, next)
  const wrapped = await wrapIdentity(session.identity, next)

  let sha: string
  try {
    const result = await commit({ ...session, passphrase: next }, text, io.makeStore(session.token), io.local)
    if ("conflict" in result) {
      return {
        kind: "failed",
        message:
          "Another device saved while the passphrase was being changed, so nothing was changed. Go back to the editor, save or resolve that first, then try again — your old passphrase still works everywhere.",
      }
    }
    if ("queued" in result) {
      return {
        kind: "failed",
        message:
          "GitHub could not be reached, so the passphrase was NOT changed. Your old passphrase still works everywhere. Try again once you are back online.",
      }
    }
    sha = result.sha
  } catch (err) {
    return { kind: "failed", message: err instanceof Error ? err.message : String(err) }
  }

  await io.local.putRotatedPassphraseSlots({ wrappedIdentity: wrapped, cachedVault: { armored, sha } })
  session.passphrase = next
  session.baseSha = sha
  session.text = text
  return { kind: "changed" }
}

// ---------------------------------------------------------------------------------------------
// Supply-chain integrity (spec §10.2, ruling R2)
// ---------------------------------------------------------------------------------------------

/** SHA-256 of the bundle this page is ACTUALLY running, as lowercase hex.
 *
 * Measured, never baked in: ruling R2 established that a bundle cannot contain the hash of
 * itself, so the displayed value has to be computed at runtime from the running file. `url`
 * defaults to `import.meta.url`, which in a Vite ESM build is the bundle's own URL, and is
 * injectable so this is testable without a browser. */
export async function measureRunningBundle(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const bytes = new Uint8Array(await (await fetchImpl(url)).arrayBuffer())
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** Parses CI's published `build-hash.txt`, whose format is `<commit> <sha256-of-bundle>` on one
 * line (ruling R2; written by task 21's CI job). Returns null for anything else rather than
 * guessing, so a malformed or missing file reads as "cannot verify" rather than "mismatch". */
export function parseBuildHashFile(text: string): { commit: string; sha256: string } | null {
  const match = /^([0-9a-f]{7,40})\s+([0-9a-f]{64})\s*$/im.exec(text.trim())
  return match ? { commit: match[1], sha256: match[2] } : null
}

/** The verdict shown to the user. `unverifiable` is deliberately distinct from `mismatch`: not
 * being able to check is not the same as having checked and found a difference, and collapsing
 * them would either cry wolf on every dev build or hide a real mismatch behind a shrug. */
export type IntegrityVerdict =
  | { kind: "match"; sha256: string }
  | { kind: "mismatch"; running: string; published: string }
  | { kind: "unverifiable"; reason: string; running: string | null }

/** Compares the running bundle against what CI published for this commit. */
export function compareBuildHash(running: string | null, publishedText: string | null): IntegrityVerdict {
  if (BUILD_COMMIT === "dev") {
    return { kind: "unverifiable", reason: "This is a local development build, which CI never published a hash for.", running }
  }
  if (running === null) {
    return { kind: "unverifiable", reason: "The running bundle could not be read to hash it.", running: null }
  }
  if (publishedText === null) {
    return {
      kind: "unverifiable",
      reason: "No published hash could be fetched for this build, so there is nothing to compare against.",
      running,
    }
  }
  const published = parseBuildHashFile(publishedText)
  if (published === null) {
    return { kind: "unverifiable", reason: "The published hash file could not be understood.", running }
  }
  if (!BUILD_COMMIT.startsWith(published.commit) && !published.commit.startsWith(BUILD_COMMIT)) {
    return {
      kind: "unverifiable",
      reason: `The published hash is for commit ${published.commit.slice(0, 7)}, but this bundle was built from ${BUILD_COMMIT.slice(0, 7)}.`,
      running,
    }
  }
  return running === published.sha256
    ? { kind: "match", sha256: running }
    : { kind: "mismatch", running, published: published.sha256 }
}

// ---------------------------------------------------------------------------------------------
// DOM wiring
// ---------------------------------------------------------------------------------------------

/** What {@link renderSettings} needs. */
export interface SettingsDeps {
  session: Session
  io: SessionIO
  /** The text currently in the editor — what a passphrase rotation re-encrypts. */
  text: string
  onClose: () => void
  /** Injectable only so tests can drive the integrity panel without a network; production passes
   * nothing and the real `fetch` is used. */
  fetchImpl?: typeof fetch
  bundleUrl?: string
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector)
  if (!el) throw new Error(`settings view: expected element ${selector}`)
  return el
}

export function renderSettings(root: HTMLElement, deps: SettingsDeps): void {
  const { session, io } = deps
  const local: LocalStore = io.local

  root.classList.remove("editor-root")
  root.innerHTML = `
    <section class="settings" aria-label="Settings">
      <div class="settings-head">
        <h1>Settings</h1>
        <button type="button" id="close-settings">Back to the editor</button>
      </div>

      <section class="settings-block">
        <h2>Add another device</h2>
        <p>This code carries your repository and your GitHub token — anything that can read it
          can write to your repository. Your passphrase is <strong>not</strong> in it, and never
          leaves this device.</p>
        <button type="button" id="reveal-qr" data-testid="reveal-qr">Show the transfer code</button>
        <div id="qr-area" data-testid="qr-area" hidden>
          <canvas id="qr-canvas" data-testid="qr-canvas" aria-label="Device transfer code"></canvas>
          <p>Or copy this instead:</p>
          <textarea id="qr-text" data-testid="qr-text" readonly rows="3"></textarea>
          <button type="button" id="hide-qr">Hide it again</button>
        </div>
      </section>

      <section class="settings-block">
        <h2>Replace the GitHub token</h2>
        <p>Use this if you revoked the old token or it expired. The new one is checked against
          your repository before it is stored.</p>
        <label for="token-input">New fine-grained token</label>
        <input type="password" id="token-input" data-testid="token-input" autocomplete="off" spellcheck="false">
        <p id="token-feedback" class="wizard-feedback" data-testid="token-feedback" role="alert" hidden></p>
        <button type="button" id="save-token" data-testid="save-token">Check and store it</button>
      </section>

      <section class="settings-block">
        <h2>Change the passphrase</h2>
        <p data-testid="rotation-warning">Your vault is re-encrypted and saved as a new version.
          <strong>Earlier versions in your history stay encrypted with the old passphrase</strong>
          — nothing rewrites git history, so keep the old passphrase if you may ever want to read
          them. Your recovery sheet is out of date the moment this succeeds; print a new one.</p>
        <label for="new-passphrase">New passphrase</label>
        <input type="text" id="new-passphrase" data-testid="new-passphrase" autocomplete="off" spellcheck="false">
        <label for="confirm-passphrase">Confirm it</label>
        <input type="text" id="confirm-passphrase" data-testid="confirm-passphrase" autocomplete="off" spellcheck="false">
        <p id="passphrase-feedback" class="wizard-feedback" data-testid="passphrase-feedback" role="alert" hidden></p>
        <button type="button" id="save-passphrase" data-testid="save-passphrase">Change it</button>
      </section>

      <section class="settings-block">
        <h2>What is running</h2>
        <p>Built from commit <code data-testid="build-commit"></code>.</p>
        <p id="integrity" data-testid="integrity">Checking the running code…</p>
      </section>
    </section>
  `

  required<HTMLButtonElement>(root, "#close-settings").addEventListener("click", () => deps.onClose())
  required<HTMLElement>(root, '[data-testid="build-commit"]').textContent = BUILD_COMMIT

  // --- transfer code -------------------------------------------------------------------------
  const qrArea = required<HTMLDivElement>(root, "#qr-area")
  const revealBtn = required<HTMLButtonElement>(root, "#reveal-qr")
  revealBtn.addEventListener("click", () => {
    void (async () => {
      if (session.token === null) {
        revealBtn.disabled = true
        revealBtn.textContent = "No token on this device to transfer"
        return
      }
      const payload = transferPayload(session.token)
      required<HTMLTextAreaElement>(root, "#qr-text").value = payload
      await QRCode.toCanvas(required<HTMLCanvasElement>(root, "#qr-canvas"), payload, { width: 280 })
      qrArea.hidden = false
      revealBtn.hidden = true
    })()
  })
  required<HTMLButtonElement>(root, "#hide-qr").addEventListener("click", () => {
    qrArea.hidden = true
    revealBtn.hidden = false
  })

  // --- token ---------------------------------------------------------------------------------
  const tokenFeedback = required<HTMLParagraphElement>(root, "#token-feedback")
  required<HTMLButtonElement>(root, "#save-token").addEventListener("click", () => {
    void (async () => {
      const input = required<HTMLInputElement>(root, "#token-input")
      tokenFeedback.hidden = true
      const outcome = await replaceToken(input.value, io.makeStore, async (token) => {
        await local.putToken(await encryptToRecipient(token, await recipientFor(session.identity)))
        session.token = token
      })
      tokenFeedback.textContent =
        outcome.kind === "stored" ? "Stored. This device will use the new token from now on." : outcome.message
      tokenFeedback.hidden = false
      if (outcome.kind === "stored") input.value = ""
    })()
  })

  // --- passphrase ----------------------------------------------------------------------------
  const passFeedback = required<HTMLParagraphElement>(root, "#passphrase-feedback")
  required<HTMLButtonElement>(root, "#save-passphrase").addEventListener("click", () => {
    void (async () => {
      const next = required<HTMLInputElement>(root, "#new-passphrase").value
      const confirm = required<HTMLInputElement>(root, "#confirm-passphrase").value
      passFeedback.hidden = true
      if (normalizePassphrase(next) !== normalizePassphrase(confirm)) {
        passFeedback.textContent = "The two passphrases do not match yet."
        passFeedback.hidden = false
        return
      }
      const outcome = await changePassphrase(next, session, io, deps.text)
      passFeedback.textContent =
        outcome.kind === "changed"
          ? "Changed. Print a new recovery sheet — your old one no longer opens the current version."
          : outcome.message
      passFeedback.hidden = false
    })()
  })

  // --- integrity -----------------------------------------------------------------------------
  void (async () => {
    const out = required<HTMLParagraphElement>(root, "#integrity")
    const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis)
    const bundleUrl = deps.bundleUrl ?? import.meta.url

    let running: string | null = null
    try {
      running = await measureRunningBundle(bundleUrl, fetchImpl)
    } catch {
      running = null
    }

    let publishedText: string | null = null
    try {
      const res = await fetchImpl(
        `https://raw.githubusercontent.com/${repoOwner()}/${repoSlug()}/main/build-hash.txt`,
      )
      publishedText = res.ok ? await res.text() : null
    } catch {
      publishedText = null
    }

    const verdict = compareBuildHash(running, publishedText)
    out.textContent =
      verdict.kind === "match"
        ? `This page is running exactly the code CI published for this commit (SHA-256 ${verdict.sha256.slice(0, 16)}…).`
        : verdict.kind === "mismatch"
          ? `WARNING: the code running in this page does not match what CI published for this commit. Running ${verdict.running.slice(0, 16)}…, published ${verdict.published.slice(0, 16)}…. Your vault is still encrypted, but do not type your passphrase here until you have checked why.`
          : `Cannot verify the running code: ${verdict.reason}${verdict.running ? ` Running SHA-256 ${verdict.running.slice(0, 16)}….` : ""} Your vault is unaffected either way — it is also readable with \`age -d ${VAULT_PATH}\`.`
    out.dataset.verdict = verdict.kind
  })()
}
