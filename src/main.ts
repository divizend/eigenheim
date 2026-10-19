import "./style.css"
import "./ui/views.css"
import { LocalStore } from "./store/local"
import { GithubStore } from "./store/github"
import { repoOwner, repoSlug } from "./config"
import { renderSetup } from "./ui/setup"
import { renderUnlock } from "./ui/unlock"
import { renderEditor } from "./ui/editor"
import { renderConflict } from "./ui/conflict"
import { renderHistory } from "./ui/history"
import { renderSettings } from "./ui/settings"
import { renderFailure } from "./ui/errors"
import type { Session } from "./session/unlock"

/** The one place a `GithubStore` is constructed from a token (ruling R3's seam, used identically
 * by the setup wizard, the unlock view and the editor). Every view takes this as a dependency
 * rather than importing `GithubStore` itself, which is what lets each of them be driven in tests
 * with an injected `fetch` and no network. */
function makeStore(token: string): GithubStore {
  return new GithubStore({ owner: repoOwner(), repo: repoSlug(), token })
}

/** Mounts the editor on an unlocked session.
 *
 * `onConflict` hands off to the three-way view (task 15). The editor has already kept the user's
 * text on screen and persisted the draft before calling this, so the handoff never depends on
 * the conflict view succeeding -- and the conflict view, on resolving, calls `reopen` with the
 * settled text, which re-mounts this editor on it. */
function openEditor(root: HTMLElement, local: LocalStore, session: Session): void {
  renderEditor(root, {
    local,
    makeStore,
    session,
    onConflict: (conflict, reopen) => {
      renderConflict(root, {
        conflict,
        session,
        io: { local, makeStore },
        onResolved: (text) => reopen(text),
      })
    },
    onOpenSettings: (text) => {
      session.text = text
      renderSettings(root, {
        session,
        io: { local, makeStore },
        text,
        // `changePassphrase` may have advanced `session.text`/`baseSha`/`passphrase` in place,
        // so the editor re-opens on the session rather than on the `text` captured above.
        onClose: () => openEditor(root, local, session),
      })
    },
    onOpenHistory: (text) => {
      // History diffs against what is ON SCREEN, so the session carries the unsaved text across
      // -- otherwise "what would restoring change" would answer a question about the last
      // committed version rather than the one the user is looking at.
      session.text = text
      renderHistory(root, {
        session,
        io: { local, makeStore },
        onClose: (resolved) => {
          // The SAME session object, mutated -- never a `{...session}` copy. `resolveConflict`
          // and `restoreVersion` both advance `session.baseSha` in place, so a copy taken here
          // would fork identity with whatever still holds the original and let the two drift.
          // One session object exists per unlock, and every view shares it.
          session.text = resolved
          openEditor(root, local, session)
        },
      })
    },
  })
}

async function main(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app")
  if (!root) throw new Error("no #app root element found")

  const local = new LocalStore()

  // The ONE gate that decides setup-vs-unlock, and the reason src/ui/setup.ts writes
  // `putWrappedIdentity` LAST (ruling R27): a device that failed partway through setup must
  // leave this null, so it re-enters the wizard rather than landing on an unlock view with
  // nothing valid to unlock and no recovery key to fall back on.
  const wrappedIdentity = await local.getWrappedIdentity()

  if (wrappedIdentity === null) {
    renderSetup(root, {
      local,
      makeStore,
      onComplete: (session) => openEditor(root, local, session),
    })
    return
  }

  renderUnlock(root, {
    local,
    makeStore,
    onUnlocked: (session) => openEditor(root, local, session),
  })
}

/** The last line of defence for spec §13's "no state may dead-end".
 *
 * Everything inside the views already handles its own expected failures inline, where the
 * problem is visible. This catches what none of them did -- a bug, a browser that refuses
 * IndexedDB (Safari private browsing has historically done exactly that), a storage quota
 * refusal at startup -- and renders the failure view instead of leaving a blank page with a
 * message only in the console. A blank page is the one outcome this project cannot ship: a user
 * looking at nothing has no way to know their vault is still intact and still readable with
 * `age -d`, which the failure view tells them in every single case. */
void main().catch((err: unknown) => {
  const root = document.querySelector<HTMLDivElement>("#app")
  if (!root) throw err
  renderFailure(root, err, { onRetry: () => window.location.reload() })
})

// Same reasoning for anything thrown out of a handler after the initial render -- an unhandled
// rejection would otherwise be invisible to the user.
window.addEventListener("unhandledrejection", (event) => {
  const root = document.querySelector<HTMLDivElement>("#app")
  if (!root) return
  // Only when nothing has rendered yet: a rejection raised while a working view is on screen
  // must NOT replace it, because that view is still the user's text and their way forward.
  if (root.childElementCount > 0) return
  renderFailure(root, event.reason, { onRetry: () => window.location.reload() })
})
