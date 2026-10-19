// Failure view (spec §13: "No state may dead-end"). One place that turns any error into a
// cause plus at least one action that resolves it.
//
// The governing property, and the one the exhaustive test pins: EVERY error class produces at
// least one action. The `default` branch is not a fallback nobody thought about -- it is the
// guarantee. An error class invented next year, by someone who never reads this file, still
// renders the three generic actions (download the ciphertext, open history, try again) rather
// than a blank screen, because those three are meaningful for literally any failure: the vault
// is always downloadable, always browsable, and the operation can always be retried.
//
// Ruling R28: `affordancesFor` is a DOM-free pure function, so the exhaustiveness guarantee is
// a cheap unit test over ALL_ERROR_CLASSES rather than a browser run per class.
// This file has no Node types available (tsconfig.app.json covers `src/`).

import {
  WrongPassphraseError,
  StaleWriteError,
  TokenError,
  RepoPublicError,
  BranchMissingError,
  RateLimitedError,
  AlreadyInitializedError,
  PendingQueueFullError,
  ReplayRepeatedlyUnreachableError,
} from "../store/errors"
import { repoOwner, repoSlug, VAULT_PATH } from "../config"

const TOKEN_CREATE_URL = "https://github.com/settings/personal-access-tokens/new"

/** One thing the user can do about a failure. `href` renders as a link, everything else as a
 * button the host wires up. */
export interface Affordance {
  id: "download" | "history" | "retry" | "create-token" | "repo-settings" | "create-branch" | "reload" | "settings"
  label: string
  href?: string
}

/** The three actions that are meaningful for ANY failure, and so are never absent.
 *
 * `download` matters most and is the reason this list exists: spec §13's undecryptable-vault row
 * requires that the user can always get their ciphertext out, because it is readable with
 * `age -d` independently of whether this app works at all. */
export function genericAffordances(): Affordance[] {
  return [
    { id: "download", label: `Download the raw ${VAULT_PATH}` },
    { id: "history", label: "Browse earlier versions" },
    { id: "retry", label: "Try again" },
  ]
}

/** What the user sees and can do, for one error. Total by construction: every branch appends to
 * {@link genericAffordances}, and the `default` arm returns them unchanged. */
export function affordancesFor(err: unknown): { message: string; actions: Affordance[] } {
  const generic = genericAffordances()
  const settingsUrl = `https://github.com/${repoOwner()}/${repoSlug()}/settings`

  if (err instanceof WrongPassphraseError) {
    return {
      message:
        "That passphrase did not open this vault. Nothing is lost and nothing has changed — the vault is exactly as it was. Try a different passphrase, look for an earlier version that your current one opens, or download the ciphertext and open it with `age -d` outside this app.",
      actions: generic,
    }
  }
  if (err instanceof TokenError) {
    return {
      message:
        "GitHub rejected this device's token. Your vault is untouched — this only stops saving and syncing, not reading what is already on this device.",
      actions: [
        { id: "create-token", label: "Create a replacement token", href: TOKEN_CREATE_URL },
        { id: "settings", label: "Enter a new token in Settings" },
        ...generic,
      ],
    }
  }
  if (err instanceof RepoPublicError) {
    return {
      message:
        "Your repository is public. This app refuses to write to it: an encrypted vault in a public repo is world-readable ciphertext that anyone can take away and grind offline at their leisure. Make it private, then re-check.",
      actions: [{ id: "repo-settings", label: "Open the repository settings", href: settingsUrl }, ...generic],
    }
  }
  if (err instanceof BranchMissingError) {
    return {
      message:
        "The data branch that holds your vault does not exist on this repository. If this is a new deployment it has simply never been created; if it existed before, it has been deleted on GitHub.",
      actions: [{ id: "create-branch", label: "Create the data branch now" }, ...generic],
    }
  }
  if (err instanceof RateLimitedError) {
    return {
      message:
        "GitHub is rate-limiting this token, so saves and syncs are paused for a few minutes. Your text is safe on this device and nothing has been lost — editing continues, and anything you save is queued until the limit clears.",
      actions: generic,
    }
  }
  if (err instanceof StaleWriteError) {
    return {
      message:
        "Another device saved a different version first, so this save was refused rather than overwriting it. Nothing was lost on either side — reopen the document to merge the two.",
      actions: [{ id: "reload", label: "Reopen and merge" }, ...generic],
    }
  }
  if (err instanceof AlreadyInitializedError) {
    // Ruling R18's affordance. This means the repo gained a vault between the check and the
    // write -- almost always a second device finishing setup at the same moment. Reloading is
    // genuinely the fix, because a reload now finds the vault and joins it (task 18) instead of
    // trying to create a second one.
    return {
      message:
        "This repository already has a vault — another device finished setting it up a moment ago. Nothing was overwritten. Reload, and this device will join the existing vault instead of creating a new one.",
      actions: [{ id: "reload", label: "Reload and join the existing vault" }, ...generic],
    }
  }
  if (err instanceof PendingQueueFullError) {
    return {
      message:
        "Too many saves are already waiting to reach GitHub, so this one was not added to the queue. Nothing queued has been lost. This almost always means the connection has been down for a long time — reconnect and let the queue drain, or download the ciphertext to keep a copy outside this app.",
      actions: generic,
    }
  }
  if (err instanceof ReplayRepeatedlyUnreachableError) {
    return {
      message:
        "A queued save has failed to reach GitHub too many times in a row, so it has stopped retrying silently. It has NOT been discarded — it is still queued. Check your connection and your token, then try again.",
      actions: [{ id: "settings", label: "Check the token in Settings" }, ...generic],
    }
  }

  return {
    message:
      err instanceof Error
        ? `Something went wrong: ${err.message}`
        : `Something went wrong: ${String(err)}`,
    actions: generic,
  }
}

/** What {@link renderFailure} needs. Every handler is optional EXCEPT the ones that cannot be
 * done any other way: a host that wires up nothing still gets a view with a download link and a
 * reload, because the dead-end guarantee cannot depend on its caller. */
export interface FailureDeps {
  /** The raw ciphertext to offer for download, when the app has it. */
  armored?: string | null
  onRetry?: () => void
  onHistory?: () => void
  onSettings?: () => void
  onCreateBranch?: () => void
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector)
  if (!el) throw new Error(`failure view: expected element ${selector}`)
  return el
}

/** Renders the failure view. */
export function renderFailure(root: HTMLElement, err: unknown, deps: FailureDeps = {}): void {
  const { message, actions } = affordancesFor(err)

  root.classList.remove("editor-root")
  root.innerHTML = `
    <section class="failure" aria-label="Something went wrong">
      <h1>Something needs your attention</h1>
      <p data-testid="failure-message"></p>
      <div class="failure-actions" data-testid="failure-actions"></div>
      <p class="failure-footnote">However this ends, your vault is still an ordinary age file.
        With your passphrase you can always read it outside this app:
        <code>age -d ${VAULT_PATH}</code>.</p>
    </section>
  `

  // `textContent`, never interpolated: an error message can carry server-controlled text.
  required<HTMLParagraphElement>(root, '[data-testid="failure-message"]').textContent = message

  const holder = required<HTMLDivElement>(root, '[data-testid="failure-actions"]')
  for (const action of actions) {
    if (action.href) {
      const link = document.createElement("a")
      link.href = action.href
      link.target = "_blank"
      link.rel = "noopener"
      link.dataset.action = action.id
      link.textContent = action.label
      holder.append(link)
      continue
    }

    const button = document.createElement("button")
    button.type = "button"
    button.dataset.action = action.id
    button.textContent = action.label
    button.addEventListener("click", () => {
      switch (action.id) {
        case "download": {
          // Built from the ciphertext the app already holds when it has it, and from a direct
          // GitHub link when it does not -- so this action is never inert, which is the whole
          // point of it being in the generic set.
          if (deps.armored) {
            const url = URL.createObjectURL(new Blob([deps.armored], { type: "text/plain" }))
            const a = document.createElement("a")
            a.href = url
            a.download = VAULT_PATH
            a.click()
            URL.revokeObjectURL(url)
          } else {
            window.open(`https://github.com/${repoOwner()}/${repoSlug()}/blob/data/${VAULT_PATH}`, "_blank", "noopener")
          }
          return
        }
        case "history":
          deps.onHistory?.()
          return
        case "settings":
          deps.onSettings?.()
          return
        case "create-branch":
          deps.onCreateBranch?.()
          return
        case "reload":
          window.location.reload()
          return
        case "retry":
          // Falls back to a reload when the host wired nothing, so "Try again" always does
          // something rather than being a button that visibly fails to respond.
          if (deps.onRetry) deps.onRetry()
          else window.location.reload()
          return
        default:
          return
      }
    })
    holder.append(button)
  }
}
