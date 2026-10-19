// Service-worker registration and the APPROVAL-GATED update prompt (spec §10.1).
//
// The threat this exists for: Vercel serves the JavaScript that does the decryption, so a
// compromised host could serve a bundle that exfiltrates the passphrase. A service worker that
// auto-activates whatever it downloads would make that swap instant and invisible, under a user
// who is already unlocked. So a new build is allowed to DOWNLOAD freely and is never allowed to
// ACTIVATE without a click. public/sw.js holds up the other half by never calling `skipWaiting`
// during install.
//
// Ruling R28: the decisions are DOM-free exports; `watchForUpdates` is the wiring.

/** Whether a downloaded-but-not-activated build is sitting in `waiting`. */
export type UpdateState = "none" | "ready"

/** Reads the state out of a registration. Separated from the DOM so the prompt's trigger
 * condition is unit-testable against a plain object rather than a live service worker, which no
 * test environment can produce on demand. */
export function updateStateOf(reg: { waiting?: unknown } | null | undefined): UpdateState {
  return reg?.waiting ? "ready" : "none"
}

/** The words shown when an update is waiting.
 *
 * States plainly that the running code has NOT changed, because that is the fact the whole
 * mechanism exists to guarantee and the user cannot otherwise know it. Avoids urgency language:
 * an update prompt that pressures someone into clicking defeats a mitigation whose entire value
 * is the deliberateness of the click. */
export function updatePromptText(): string {
  return "A new version of this app has been downloaded. It is not running yet — this page is still running the code it loaded with. Reload into the new version when you are ready."
}

export interface UpdateDeps {
  /** Mounted into this element; the host decides where it sits. */
  container: HTMLElement
  /** Injectable for tests; production passes nothing and the real one is used. */
  serviceWorker?: ServiceWorkerContainer
  /** Injectable so a test can observe the reload rather than losing the page. */
  reload?: () => void
}

/** Registers the service worker and shows the prompt whenever a build is waiting.
 *
 * Returns the registration (or null) so a caller can await the outcome; failures are swallowed
 * deliberately. A browser that refuses service workers — Firefox private browsing does — must
 * still get a completely working app, because nothing about reading or writing a vault depends
 * on this file. Offline support is an enhancement; losing it silently is correct, where failing
 * to start would not be.
 */
export async function watchForUpdates(deps: UpdateDeps): Promise<ServiceWorkerRegistration | null> {
  const container = deps.serviceWorker ?? (typeof navigator !== "undefined" ? navigator.serviceWorker : undefined)
  if (!container) return null

  let reg: ServiceWorkerRegistration
  try {
    reg = await container.register("/sw.js", { scope: "/" })
  } catch {
    return null
  }

  const show = (): void => {
    if (updateStateOf(reg) !== "ready") return
    if (deps.container.querySelector("[data-testid='update-prompt']")) return

    const bar = document.createElement("div")
    bar.className = "update-prompt"
    bar.dataset.testid = "update-prompt"
    bar.setAttribute("role", "status")

    const text = document.createElement("span")
    text.textContent = updatePromptText()

    const button = document.createElement("button")
    button.type = "button"
    button.dataset.testid = "update-accept"
    button.textContent = "Reload into the new version"
    button.addEventListener("click", () => {
      // The ONLY place skipWaiting is ever requested, and only from this click.
      reg.waiting?.postMessage("SKIP_WAITING")
      if (deps.reload) deps.reload()
      else window.location.reload()
    })

    const dismiss = document.createElement("button")
    dismiss.type = "button"
    dismiss.dataset.testid = "update-dismiss"
    dismiss.textContent = "Not now"
    dismiss.addEventListener("click", () => bar.remove())

    bar.append(text, button, dismiss)
    deps.container.append(bar)

    // Reserve the prompt's ACTUAL height, measured after it is in the DOM, rather than a
    // constant in the stylesheet. The prompt is `position: fixed` at the bottom, so anything it
    // overlaps stops receiving clicks -- a user presses a visible control and nothing happens,
    // with no error anywhere. A fixed reservation cannot be right, because the text wraps to a
    // different number of lines depending on viewport width: the E2E caught exactly that, with
    // a 108px prompt against a 104px constant. `16` matches the `bottom` offset in views.css.
    const reserve = (): void => {
      document.body.style.paddingBottom = `${Math.ceil(bar.getBoundingClientRect().height) + 16}px`
    }
    reserve()
    window.addEventListener("resize", reserve)

    const release = (): void => {
      window.removeEventListener("resize", reserve)
      document.body.style.paddingBottom = ""
    }
    dismiss.addEventListener("click", release)
    button.addEventListener("click", release)
  }

  show()
  reg.addEventListener("updatefound", () => {
    const installing = reg.installing
    if (!installing) return
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed") show()
    })
  })

  return reg
}
