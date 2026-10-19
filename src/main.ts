import "./style.css"
import "./ui/views.css"
import { LocalStore } from "./store/local"
import { GithubStore } from "./store/github"
import { repoOwner, repoSlug } from "./config"
import { renderSetup } from "./ui/setup"
import { renderUnlock } from "./ui/unlock"
import { renderEditor } from "./ui/editor"
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
 * `onConflict` is Task 15's seam and is a deliberate, non-dead-ended no-op until that task lands
 * (see {@link renderEditor}'s own doc on it): by the time it is called the editor has already
 * kept the user's text on screen, persisted the draft to IndexedDB, and shown the conflict
 * notice -- so the state a user reaches here is "your edit is safe locally, another device got
 * there first", not a hole. Task 15 replaces this one line with the three-way view. */
function openEditor(root: HTMLElement, local: LocalStore, session: Session): void {
  renderEditor(root, {
    local,
    makeStore,
    session,
    onConflict: () => {
      /* Task 15: renderConflict(root, conflict, reopen). */
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

void main()
