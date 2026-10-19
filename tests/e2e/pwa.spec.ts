// E2E: the offline shell and approval-gated updates (spec §10.1, §5.3).
import { test, expect } from "@playwright/test"

test.describe("PWA", () => {
  test("the service worker registers and activates", async ({ page }) => {
    await page.goto("/")
    // Polled, not read once: `navigator.serviceWorker.ready` resolves as soon as there IS an
    // active worker, which can still be in state "activating" for a moment afterwards.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const reg = await navigator.serviceWorker.ready
            return reg.active?.state ?? null
          }),
        { timeout: 30_000 },
      )
      .toBe("activated")
  })

  test("the app shell loads with the network offline after one visit", async ({ page, context }) => {
    await page.goto("/")
    await page.evaluate(() => navigator.serviceWorker.ready)
    // Second visit while online, so every shell asset is certainly in the cache before the
    // network is cut (the first navigation races the worker's own activation).
    await page.reload()
    await page.evaluate(() => navigator.serviceWorker.ready)
    await expect(page.getByRole("checkbox")).toBeVisible()

    await context.setOffline(true)
    await page.reload()

    // The whole point of spec §5.3's "unlock requires no network at all": with the shell
    // cached, the app is fully usable from here.
    await expect(page.getByRole("checkbox")).toBeVisible({ timeout: 30_000 })
    await context.setOffline(false)
  })

  test("sw.js, as actually served, never calls skipWaiting during install", async ({ page, request }) => {
    // Asserted against the SERVED file rather than the repo source, because what protects the
    // user is what the browser gets. This is the single regression that would silently undo
    // spec §10.1: a `skipWaiting()` in the install handler makes a swapped bundle activate
    // under a user who is already unlocked, between two keystrokes.
    await page.goto("/")
    const raw = await (await request.get("/sw.js")).text()

    // Comments stripped FIRST. The first version of this test did not, and failed against
    // sw.js's own line "Deliberately NO self.skipWaiting() here" -- i.e. it was asserting on
    // prose rather than on code, and would equally have been satisfied by a file that merely
    // never mentioned the word while calling it.
    const body = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

    const install = /addEventListener\(\s*["']install["'][\s\S]*?\n\}\)/.exec(body)
    expect(install, "no install handler found in the served sw.js").not.toBeNull()
    expect(install?.[0]).not.toContain("skipWaiting")

    // And it is reachable exactly once in the whole file, from the message handler -- the
    // user's click.
    expect(body.match(/skipWaiting/g)?.length).toBe(1)
    const message = /addEventListener\(\s*["']message["'][\s\S]*?\n\}\)/.exec(body)
    expect(message?.[0]).toContain("skipWaiting")
  })

  test("a new build does NOT activate silently; it asks first", async ({ page }) => {
    // A real second build cannot be produced mid-test against `vite preview`, so the WAITING
    // state is injected at the registration seam and the app's own real code path runs from
    // there -- what is under test is this app's response to a waiting worker, which is the half
    // that lives in src/ui/update.ts.
    await page.addInitScript(() => {
      const posted: string[] = []
      ;(window as unknown as { __posted: string[] }).__posted = posted
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          register: async () => ({
            waiting: { postMessage: (m: string) => posted.push(m) },
            installing: null,
            addEventListener: () => {},
          }),
        },
      })
    })
    await page.goto("/")

    await expect(page.getByTestId("update-prompt")).toBeVisible({ timeout: 30_000 })
    // It says the running code has not changed -- the fact the user cannot otherwise know.
    await expect(page.getByTestId("update-prompt")).toContainText(/not running yet|still running the code/i)
    // And nothing was activated merely by showing the prompt.
    expect(await page.evaluate(() => (window as unknown as { __posted: string[] }).__posted)).toEqual([])
  })

  test("accepting the prompt is what activates the new build", async ({ page }) => {
    // Recorded through sessionStorage rather than a window property, because accepting also
    // reloads the page -- which re-runs this init script and would wipe an in-memory array,
    // destroying the very evidence under test. sessionStorage survives the reload.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          register: async () => ({
            waiting: { postMessage: (m: string) => sessionStorage.setItem("posted", m) },
            installing: null,
            addEventListener: () => {},
          }),
        },
      })
    })
    await page.goto("/")
    await expect(page.getByTestId("update-prompt")).toBeVisible({ timeout: 30_000 })
    expect(await page.evaluate(() => sessionStorage.getItem("posted"))).toBeNull()

    await page.getByTestId("update-accept").click()
    // SKIP_WAITING is sent only as a direct consequence of the click -- the one path to
    // activation that exists anywhere in this app.
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem("posted")), { timeout: 30_000 })
      .toBe("SKIP_WAITING")
  })

  test("dismissing leaves the old build running and removes the prompt", async ({ page }) => {
    await page.addInitScript(() => {
      const posted: string[] = []
      ;(window as unknown as { __posted: string[] }).__posted = posted
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          register: async () => ({
            waiting: { postMessage: (m: string) => posted.push(m) },
            installing: null,
            addEventListener: () => {},
          }),
        },
      })
    })
    await page.goto("/")
    await expect(page.getByTestId("update-prompt")).toBeVisible({ timeout: 30_000 })

    await page.getByTestId("update-dismiss").click()
    await expect(page.getByTestId("update-prompt")).toHaveCount(0)
    // "Not now" means not now: still nothing activated.
    expect(await page.evaluate(() => (window as unknown as { __posted: string[] }).__posted)).toEqual([])
  })

  test("a browser that refuses service workers still gets a fully working app", async ({ page }) => {
    // Firefox private browsing really does this. Offline support is an enhancement; losing it
    // silently is correct, where failing to start would not be.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          register: async () => {
            throw new DOMException("refused", "SecurityError")
          },
        },
      })
    })
    await page.goto("/")
    await expect(page.getByRole("checkbox")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("update-prompt")).toHaveCount(0)
  })

  test("the prompt never covers a control -- it reserves its own space", async ({ page }) => {
    // Regression test for a real defect this suite caught: the prompt is `position: fixed` at
    // the bottom, and with no space reserved for it Playwright reported
    // "<div class=\"update-prompt\"> intercepts pointer events" on the setup wizard's own
    // button -- a user would press a visible control and watch nothing happen, with no error
    // anywhere to explain it.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          register: async () => ({
            waiting: { postMessage: () => {} },
            installing: null,
            addEventListener: () => {},
          }),
        },
      })
    })
    await page.goto("/")
    await expect(page.getByTestId("update-prompt")).toBeVisible({ timeout: 30_000 })

    // Space is reserved at the bottom of the page for exactly this reason.
    const reserved = await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom))
    const promptHeight = await page
      .getByTestId("update-prompt")
      .evaluate((el) => el.getBoundingClientRect().height)
    expect(reserved).toBeGreaterThanOrEqual(promptHeight)

    // And the wizard's own controls really are clickable with the prompt on screen.
    await page.getByRole("checkbox").check()
    await page.getByRole("button", { name: /continue/i }).click()
    await expect(page.getByRole("button", { name: /continue/i })).toBeVisible()
  })

  test("the manifest is served and describes an installable app", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest")
    expect(res.ok()).toBe(true)
    const manifest = (await res.json()) as Record<string, unknown>
    expect(manifest.name).toBe("eigenheim")
    expect(manifest.start_url).toBe("/")
    expect(manifest.display).toBe("standalone")
    expect(Array.isArray(manifest.icons) && (manifest.icons as unknown[]).length).toBeGreaterThan(0)
  })
})
