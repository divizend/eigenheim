// E2E: the unlock view and the editor (spec §2's save model, §5.3's sequential unlock, §8's
// one-monospace-file surface, §13's every-failure-has-a-way-forward). Runs against `vite
// preview`'s real production build in a real Chromium, with GitHub's REST API stubbed.
//
// Why this file exists even though tests/unit/editor.test.ts and tests/unit/unlock-view.test.ts
// already cover the same logic DOM-free (ruling R28): Task 13 proved that an injected-dependency
// seam every unit test uses is also a seam that HIDES the real default -- `GithubStore`'s
// unbound default `fetch` threw "Illegal invocation" in a real browser while 126 unit tests
// stayed green, because every one of them passed its own `fetch`. The unit tests here pin the
// decisions; this file is the only thing that exercises the real browser defaults, the real
// IndexedDB, the real build output and the real CSS.
import { test, expect, type Page, type Route } from "@playwright/test"
import { encryptVault, encryptToRecipient } from "../../src/vault/crypto"
import { generateDeviceIdentity, wrapIdentity } from "../../src/vault/identity"
import { DB_NAME } from "../../src/store/local"

const OWNER = "test-owner"
const REPO = "test-repo"
const API = "https://api.github.com"
const PASS = "correct-horse-battery-staple-eigenheim"
const COMMITTED_TEXT = "committed in the vault\n"
const HEAD_SHA = "commit-head"

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-github-api-version",
  }
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
    body: JSON.stringify(body),
  })
}

interface RecordedCall {
  method: string
  path: string
}

/** The already-set-up device's stored slots, computed ONCE for the whole file.
 *
 * Built here in Node rather than by driving the setup wizard in the browser, for a reason worth
 * stating: the wizard costs two sequential logN=17 scrypt runs per test, and these seven tests
 * are about what happens AFTER setup. Seeding the same slots the wizard would have written keeps
 * the single in-browser scrypt that actually matters here -- the one the unlock itself pays --
 * and drops the rest. The shapes below are `LocalStore`'s own (`putWrappedIdentity` takes the
 * armored string, `putToken` the armored string, `putCachedVault` a `{armored, sha}`), so this
 * seeds through the same contract the app reads back through. */
let seedPromise: Promise<{ wrappedIdentity: string; token: string; cachedVault: { armored: string; sha: string } }> | null = null
function seed(): Promise<{ wrappedIdentity: string; token: string; cachedVault: { armored: string; sha: string } }> {
  seedPromise ??= (async () => {
    const { identity, recipient } = await generateDeviceIdentity()
    return {
      wrappedIdentity: await wrapIdentity(identity, PASS),
      token: await encryptToRecipient("github_pat_fake_token", recipient),
      cachedVault: { armored: await encryptVault(COMMITTED_TEXT, PASS), sha: HEAD_SHA },
    }
  })()
  return seedPromise
}

/** Stubs every GitHub call this file's flows can make and records them, so a test can assert on
 * what was NOT called -- which is the whole point of spec §2's save model ("autosave is local
 * only; GitHub writes are explicit") and cannot be shown any other way. */
async function installGithubMock(page: Page, opts: { writeStatus?: number } = {}): Promise<{ calls: RecordedCall[] }> {
  const calls: RecordedCall[] = []
  await page.route(`${API}/**`, async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() })
    calls.push({ method: request.method(), path: pathname })

    const base = `/repos/${OWNER}/${REPO}`
    if (pathname === base) return fulfillJson(route, 200, { private: true, permissions: { push: true } })
    if (pathname === `${base}/git/ref/heads/data`) {
      return fulfillJson(route, 200, { object: { sha: HEAD_SHA } })
    }
    if (pathname.startsWith(`${base}/git/commits/`)) {
      return fulfillJson(route, 200, { sha: HEAD_SHA, tree: { sha: "tree-head" }, committer: { date: "2026-10-19T00:00:00Z" } })
    }
    if (pathname.startsWith(`${base}/git/trees/`)) {
      const { cachedVault } = await seed()
      return fulfillJson(route, 200, {
        tree: [{ path: "vault.age", type: "blob", sha: "blob-head", size: cachedVault.armored.length }],
      })
    }
    if (pathname.startsWith(`${base}/git/blobs/`)) {
      const { cachedVault } = await seed()
      return fulfillJson(route, 200, { content: Buffer.from(cachedVault.armored, "utf-8").toString("base64"), encoding: "base64" })
    }
    if (pathname === `${base}/git/blobs`) return fulfillJson(route, 201, { sha: "blob-new" })
    if (pathname === `${base}/git/trees`) return fulfillJson(route, 201, { sha: "tree-new" })
    if (pathname === `${base}/git/commits`) return fulfillJson(route, 201, { sha: "commit-new" })
    if (pathname === `${base}/git/refs/heads/data`) {
      const status = opts.writeStatus ?? 200
      if (status === 422) return fulfillJson(route, 422, { message: "Update is not a fast forward" })
      return fulfillJson(route, 200, { object: { sha: "commit-new" } })
    }
    if (pathname === `${base}/commits`) {
      return fulfillJson(route, 200, [{ sha: HEAD_SHA, commit: { committer: { date: "2026-10-19T00:00:00Z" } } }])
    }
    return fulfillJson(route, 404, { message: `editor.spec.ts: unmocked ${request.method()} ${pathname}` })
  })
  return { calls }
}

/** Writes the seeded slots straight into the app's own IndexedDB, then reloads so `main()` sees
 * a device that has already completed setup and routes to the unlock view. */
async function seedDevice(page: Page): Promise<void> {
  const slots = await seed()
  await page.goto("/")
  await page.evaluate(
    async ({ dbName, slots }) => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1)
        req.onupgradeneeded = () => req.result.createObjectStore("slots")
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction("slots", "readwrite")
          const store = tx.objectStore("slots")
          store.put(slots.wrappedIdentity, "wrappedIdentity")
          store.put(slots.token, "token")
          store.put(slots.cachedVault, "cachedVault")
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      })
    },
    { dbName: DB_NAME, slots },
  )
  await page.reload()
}

async function unlockToEditor(page: Page): Promise<void> {
  await page.getByLabel(/passphrase/i).fill(PASS)
  await page.getByRole("button", { name: /^unlock$/i }).click()
  await expect(page.getByTestId("editor")).toBeVisible({ timeout: 30_000 })
}

test.describe("unlock and editor", () => {
  test("unlock shows progress and opens the editor on the cached vault with the network dead", async ({ page }) => {
    // spec §5.3: "Unlock requires no network at all", which is what the PWA story depends on.
    //
    // Proven by KILLING the network rather than by counting calls. An earlier version of this
    // test seeded the normal mock and asserted zero recorded calls, and it was testing the wrong
    // thing: it failed on three GETs that the EDITOR's own mount-time background sync makes
    // after unlock has already finished, which say nothing about whether unlock needed them.
    // Aborting every request removes the ambiguity -- if the editor still opens on the right
    // plaintext, no part of the unlock path can have depended on a response.
    await seedDevice(page)
    await page.route(`${API}/**`, (route) => route.abort())

    await expect(page.getByRole("button", { name: /^unlock$/i })).toBeVisible()
    await page.getByLabel(/passphrase/i).fill(PASS)
    await page.getByRole("button", { name: /^unlock$/i }).click()

    // The progress line is the only thing on screen during a 0.4-2s scrypt run, so it has to
    // appear; it is checked for existence rather than exact text because which stage is current
    // when Playwright looks is inherently a race.
    await expect(page.getByTestId("unlock-progress")).toBeVisible()

    await expect(page.getByTestId("editor")).toHaveValue(COMMITTED_TEXT, { timeout: 30_000 })

    // And the dead network is itself never a dead end (spec §13): the failed background sync
    // leaves the document editable, with the state saying why nothing is reaching GitHub.
    await expect(page.getByTestId("save-state")).toContainText(/offline/i)
  })

  test("a wrong passphrase says so and leaves the field to try again", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)

    await page.getByLabel(/passphrase/i).fill("definitely-not-the-right-passphrase")
    await page.getByRole("button", { name: /^unlock$/i }).click()

    await expect(page.getByTestId("unlock-feedback")).toContainText(/try again/i, { timeout: 30_000 })
    // spec §13: the way forward for a typo is the field itself, so it must still be there.
    await expect(page.getByLabel(/passphrase/i)).toBeVisible()
  })

  test("typing autosaves locally without any network call", async ({ page }) => {
    const { calls } = await installGithubMock(page)
    await seedDevice(page)
    await unlockToEditor(page)
    const before = calls.length

    await page.getByTestId("editor").fill("typed but never sent\n")
    // Comfortably past AUTOSAVE_DEBOUNCE_MS, so the draft has certainly been written.
    await page.waitForTimeout(1500)

    // spec §2's central guarantee: autosave is local only. Any non-GET during typing would mean
    // the app wrote to GitHub without being asked.
    expect(calls.slice(before).filter((c) => c.method !== "GET")).toEqual([])
  })

  test("the state indicator distinguishes local-only from committed", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)
    await unlockToEditor(page)

    await expect(page.getByTestId("save-state")).toContainText(/saved to github/i)
    await page.getByTestId("editor").fill("now dirty\n")
    await expect(page.getByTestId("save-state")).toContainText(/this device only/i)
  })

  test("Ctrl+S commits and the indicator becomes committed", async ({ page }) => {
    const { calls } = await installGithubMock(page)
    await seedDevice(page)
    await unlockToEditor(page)

    await page.getByTestId("editor").fill("explicitly saved\n")
    await expect(page.getByTestId("save-state")).toContainText(/this device only/i)

    await page.getByTestId("editor").press("Control+s")

    await expect(page.getByTestId("save-state")).toContainText(/saved to github/i, { timeout: 30_000 })
    // The write really went through the git data API, ending at the ref update.
    expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/git/refs/heads/data"))).toBe(true)
  })

  test("a reload restores the uncommitted draft, not the committed version", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)
    await unlockToEditor(page)

    await page.getByTestId("editor").fill("draft that outlives a reload\n")
    await page.waitForTimeout(1500)

    await page.reload()
    await unlockToEditor(page)

    await expect(page.getByTestId("editor")).toHaveValue("draft that outlives a reload\n")
  })

  test("the editor is monospace and fills the viewport", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)
    await unlockToEditor(page)

    const editor = page.getByTestId("editor")
    const font = await editor.evaluate((el) => getComputedStyle(el).fontFamily)
    expect(font).toMatch(/mono/i)

    // "Fills the viewport" (spec §8) measured, not assumed: the textarea's own box against the
    // window's own height, allowing only for the one status line below it.
    const { editorHeight, viewportHeight } = await editor.evaluate((el) => ({
      editorHeight: el.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
    }))
    expect(editorHeight).toBeGreaterThan(viewportHeight * 0.8)
  })

  test("going offline shows a banner and editing continues", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)
    await unlockToEditor(page)

    await page.evaluate(() => window.dispatchEvent(new Event("offline")))

    await expect(page.getByTestId("save-state")).toContainText(/offline/i)
    await expect(page.getByTestId("editor-notice")).toContainText(/offline/i)

    // spec §13: offline is never a dead end -- the document stays editable.
    await page.getByTestId("editor").fill("written while offline\n")
    await expect(page.getByTestId("editor")).toHaveValue("written while offline\n")
  })
})
