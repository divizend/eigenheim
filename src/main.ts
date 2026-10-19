import "./style.css"
import "./ui/views.css"
import { LocalStore } from "./store/local"
import { GithubStore } from "./store/github"
import { repoOwner, repoSlug } from "./config"
import { renderSetup } from "./ui/setup"
import type { Session } from "./session/unlock"

/** Placeholder for Task 14's real editor -- this task's own brief only requires that completing
 * setup "lands in the editor", not that the editor itself exists yet (Task 14: "Unlock view and
 * editor" creates src/ui/editor.ts). Built via DOM methods, not an innerHTML template: `session.text`
 * is decrypted vault content and, like the passphrase (src/ui/setup.ts's own recovery-sheet
 * comment), must never be interpolated into an HTML string. */
function renderEditorPlaceholder(root: HTMLElement, session: Session): void {
  const container = document.createElement("div")
  container.dataset.testid = "editor-placeholder"

  const heading = document.createElement("h1")
  heading.textContent = "Vault ready"

  const note = document.createElement("p")
  note.textContent = "Setup is complete. The real editor lands in Task 14 -- this is a placeholder."

  const pre = document.createElement("pre")
  pre.textContent = session.text

  container.append(heading, note, pre)
  root.replaceChildren(container)
}

async function main(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app")
  if (!root) throw new Error("no #app root element found")

  const local = new LocalStore()
  const wrappedIdentity = await local.getWrappedIdentity()

  if (wrappedIdentity === null) {
    renderSetup(root, {
      local,
      makeStore: (token) => new GithubStore({ owner: repoOwner(), repo: repoSlug(), token }),
      onComplete: (session) => renderEditorPlaceholder(root, session),
    })
    return
  }

  // Unlock view lands in Task 14 -- this device has already completed setup, but there is
  // nothing yet to route it to.
  root.textContent = "This device is already set up. The unlock view is not built yet (Task 14)."
}

void main()
