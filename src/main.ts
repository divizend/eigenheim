import "./style.css"
import "./ui/views.css"
import { LocalStore } from "./store/local"
import { GithubStore } from "./store/github"
import { repoOwner, repoSlug, setRuntimeRepo } from "./config"
import { renderSetup } from "./ui/setup"
import { renderUnlock } from "./ui/unlock"
import { renderEditor } from "./ui/editor"
import { renderConflict } from "./ui/conflict"
import { renderHistory } from "./ui/history"
import { renderSettings } from "./ui/settings"
import { renderFailure } from "./ui/errors"
import { watchForUpdates } from "./ui/update"
import { startRouter, type Route } from "./ui/router"
import type { Session } from "./session/unlock"

/** The one place a `GithubStore` is constructed from a token (ruling R3's seam, used identically
 * by the setup wizard, the unlock view and the editor). Every view takes this as a dependency
 * rather than importing `GithubStore` itself, which is what lets each of them be driven in tests
 * with an injected `fetch` and no network. */
function makeStore(token: string): GithubStore {
  return new GithubStore({ owner: repoOwner(), repo: repoSlug(), token })
}

/** Mounts whichever view the URL names, for an unlocked session.
 *
 * Every view navigates by calling `go(route)` rather than rendering another view directly, so
 * the address bar and what is on screen cannot disagree — which is the whole point of having
 * routing at all. Back/Forward work for free, and a reload or a shared link lands where it says.
 *
 * One session object exists per unlock and every view shares it, mutated in place — never a
 * `{...session}` copy. `resolveConflict`, `restoreVersion` and `changePassphrase` all advance
 * fields on it, so a copy taken here would fork identity with whatever still holds the original
 * and let the two drift. */
function openApp(root: HTMLElement, local: LocalStore, session: Session): void {
  const io = { local, makeStore }

  const go = startRouter({
    render: (route: Route) => {
      if (route === "settings") {
        renderSettings(root, {
          session,
          io,
          text: session.text,
          onClose: () => go("editor"),
          // A reload, not a re-render: the open session, the cached vault and every view on
          // screen all belong to the repository that was just replaced.
          onRepoChanged: () => window.location.reload(),
          makeStoreFor: (owner, repo, token) => new GithubStore({ owner, repo, token }),
        })
        return
      }

      if (route === "history") {
        renderHistory(root, {
          session,
          io,
          onClose: (resolved) => {
            session.text = resolved
            go("editor")
          },
        })
        return
      }

      renderEditor(root, {
        local,
        makeStore,
        session,
        onConflict: (conflict, reopen) => {
          // Deliberately NOT a route: a conflict is a modal interruption of one save, not a
          // place in the app. Giving it a URL would let a reload or a shared link land on a
          // conflict whose two sides no longer exist.
          renderConflict(root, { conflict, session, io, onResolved: (text) => reopen(text) })
        },
        onOpenSettings: (text) => {
          session.text = text
          go("settings")
        },
        onOpenHistory: (text) => {
          // History diffs against what is ON SCREEN, so the session carries the unsaved text
          // across — otherwise "what would restoring change" would answer a question about the
          // last committed version rather than the one the user is looking at.
          session.text = text
          go("history")
        },
      })
    },
  })
}

async function main(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app")
  if (!root) throw new Error("no #app root element found")

  // Fire-and-forget, and deliberately not awaited: offline support is an enhancement, and a
  // browser that refuses service workers (Firefox private browsing does) must still get a fully
  // working app rather than a slower start or no start at all. The prompt mounts on <body>, not
  // on #app, so a view re-render never wipes a pending update notice off the screen.
  void watchForUpdates({ container: document.body })

  const local = new LocalStore()

  // BEFORE anything renders or any store is built: `repoOwner()`/`repoSlug()` are read from a
  // dozen places, and every one of them must already see the repository this device actually
  // points at rather than the deployment's build-time default.
  const storedRepo = await local.getRepo()
  if (storedRepo) setRuntimeRepo(storedRepo)

  // The ONE gate that decides setup-vs-unlock, and the reason src/ui/setup.ts writes
  // `putWrappedIdentity` LAST (ruling R27): a device that failed partway through setup must
  // leave this null, so it re-enters the wizard rather than landing on an unlock view with
  // nothing valid to unlock and no recovery key to fall back on.
  const wrappedIdentity = await local.getWrappedIdentity()

  // Setup and unlock outrank the URL: a deep link to /settings on a locked or un-set-up device
  // must still land on the gate, not on a view that has no session behind it. The requested
  // route is reached only after `openApp` starts the router, which re-reads the URL then.
  if (wrappedIdentity === null) {
    renderSetup(root, {
      local,
      makeStore,
      onComplete: (session) => openApp(root, local, session),
    })
    return
  }

  renderUnlock(root, {
    local,
    makeStore,
    onUnlocked: (session) => openApp(root, local, session),
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
