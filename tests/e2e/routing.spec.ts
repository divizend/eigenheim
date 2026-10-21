// E2E: URL routing for the views reachable once a vault is open.
//
// Reported from a real deployment: opening Settings or History changed the screen but not the
// address bar, so the two could disagree, Back did nothing useful, and neither view could be
// linked to or reloaded.
import { test, expect, type Page, type Route } from "@playwright/test"
import { encryptVault, encryptToRecipient } from "../../src/vault/crypto"
import { generateDeviceIdentity, wrapIdentity } from "../../src/vault/identity"
import { DB_NAME } from "../../src/store/local"

const OWNER = "test-owner"
const REPO = "test-repo"
const API = "https://api.github.com"
const PASS = "correct-horse-battery-staple-eigenheim"
const TEXT = "the only file\n"
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

let seedPromise: Promise<{ wrappedIdentity: string; token: string; cachedVault: { armored: string; sha: string } }> | null =
  null
function seed() {
  seedPromise ??= (async () => {
    const { identity, recipient } = await generateDeviceIdentity()
    return {
      wrappedIdentity: await wrapIdentity(identity, PASS),
      token: await encryptToRecipient("github_pat_fake_token", recipient),
      cachedVault: { armored: await encryptVault(TEXT, PASS), sha: HEAD_SHA },
    }
  })()
  return seedPromise
}

async function installGithubMock(page: Page): Promise<void> {
  await page.route(`${API}/**`, async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() })
    const { cachedVault } = await seed()
    const base = `/repos/${OWNER}/${REPO}`
    if (pathname === base) return fulfillJson(route, 200, { private: true, permissions: { push: true } })
    if (pathname === `${base}/git/ref/heads/data`) return fulfillJson(route, 200, { object: { sha: HEAD_SHA } })
    if (pathname === `${base}/commits`) {
      return fulfillJson(route, 200, [
        { sha: HEAD_SHA, commit: { author: { date: "2026-10-21T09:00:00Z" }, committer: { date: "2026-10-21T09:00:00Z" }, message: "Save" } },
      ])
    }
    if (pathname.startsWith(`${base}/git/commits/`)) {
      return fulfillJson(route, 200, { sha: HEAD_SHA, tree: { sha: "tree-head" }, committer: { date: "2026-10-21T09:00:00Z" } })
    }
    if (pathname.startsWith(`${base}/git/trees/`)) {
      return fulfillJson(route, 200, { tree: [{ path: "vault.age", type: "blob", sha: "blob-head", size: cachedVault.armored.length }] })
    }
    if (pathname.startsWith(`${base}/git/blobs/`)) {
      return fulfillJson(route, 200, { content: Buffer.from(cachedVault.armored, "utf-8").toString("base64"), encoding: "base64" })
    }
    if (pathname.endsWith("/contents/build-hash.txt")) return fulfillJson(route, 404, { message: "Not Found" })
    return fulfillJson(route, 404, { message: `routing.spec.ts: unmocked ${pathname}` })
  })
}

async function seedDevice(page: Page, startPath = "/"): Promise<void> {
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
          const s = tx.objectStore("slots")
          s.put(slots.token, "token")
          s.put(slots.cachedVault, "cachedVault")
          s.put(slots.wrappedIdentity, "wrappedIdentity")
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
  await page.goto(startPath)
}

async function unlock(page: Page): Promise<void> {
  await page.getByLabel(/passphrase/i).fill(PASS)
  await page.getByRole("button", { name: /^unlock$/i }).click()
}

function path(page: Page): string {
  return new URL(page.url()).pathname
}

test.describe("routing", () => {
  test("opening History and Settings changes the URL", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)
    await unlock(page)
    await expect(page.getByTestId("editor")).toHaveValue(TEXT, { timeout: 60_000 })
    expect(path(page)).toBe("/")

    await page.getByTestId("open-history").click()
    await expect(page.getByTestId("history-list")).toBeVisible()
    expect(path(page)).toBe("/history")

    await page.getByRole("button", { name: /back to the editor/i }).click()
    await expect(page.getByTestId("editor")).toBeVisible()
    expect(path(page)).toBe("/")

    await page.getByTestId("open-settings").click()
    await expect(page.getByTestId("reveal-qr")).toBeVisible()
    expect(path(page)).toBe("/settings")
  })

  test("Back and Forward move between views, not out of the app", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)
    await unlock(page)
    await expect(page.getByTestId("editor")).toHaveValue(TEXT, { timeout: 60_000 })

    await page.getByTestId("open-settings").click()
    await expect(page.getByTestId("reveal-qr")).toBeVisible()

    await page.goBack()
    await expect(page.getByTestId("editor")).toBeVisible()
    expect(path(page)).toBe("/")

    await page.goForward()
    await expect(page.getByTestId("reveal-qr")).toBeVisible()
    expect(path(page)).toBe("/settings")
  })

  test("a deep link lands on the gate first, then on the view it asked for", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page, "/history")

    // The gate outranks the URL: a locked device must not show a view that has no session.
    await expect(page.getByRole("button", { name: /^unlock$/i })).toBeVisible()
    await expect(page.getByTestId("history-list")).toHaveCount(0)

    await unlock(page)
    // ...and the request is honoured once there IS a session.
    await expect(page.getByTestId("history-list")).toBeVisible({ timeout: 60_000 })
    expect(path(page)).toBe("/history")
  })

  test("an unknown path opens the document rather than an error page", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page, "/nonsense")
    await unlock(page)
    await expect(page.getByTestId("editor")).toHaveValue(TEXT, { timeout: 60_000 })
  })
})

test("the history layout does not move when the detail pane changes", async ({ page }) => {
  // Reported from a real deployment: the heading and the left column visibly jumped the moment
  // "Decrypting this version…" was replaced by the diff. Measured rather than eyeballed, because
  // "looks stable" is exactly the claim that was wrong before.
  await installGithubMock(page)
  await seedDevice(page, "/history")
  await unlock(page)
  await expect(page.locator(".history-entry").first()).toBeVisible({ timeout: 60_000 })

  const geometry = async () => ({
    heading: await page.locator(".history-head h1").evaluate((el) => el.getBoundingClientRect().x),
    listX: await page.locator(".history-list").evaluate((el) => el.getBoundingClientRect().x),
    listWidth: await page.locator(".history-list").evaluate((el) => el.getBoundingClientRect().width),
    // Included so a future failure says WHICH thing moved: when this was first measured, #app
    // and the viewport were identical in both states, which is what ruled out a scrollbar and
    // pointed at the container being shrink-to-fit.
    app: await page.evaluate(() => document.querySelector("#app")!.getBoundingClientRect().width),
    scrollW: await page.evaluate(() => document.body.scrollWidth),
    clientW: await page.evaluate(() => document.documentElement.clientWidth),
  })

  const before = await geometry()
  await page.locator(".history-entry").first().click()
  // Whatever the detail pane settles on -- a diff, an "identical" note, or a problem -- the
  // left-hand geometry must be byte-identical to what it was.
  await expect(page.getByTestId("restore-btn").or(page.getByTestId("version-problem"))).toBeVisible({ timeout: 60_000 })
  expect(await geometry()).toEqual(before)
})

test.describe("settings additions", () => {
  test("links directly to the encrypted file on GitHub", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page, "/settings")
    await unlock(page)
    await expect(page.getByTestId("vault-link")).toBeVisible({ timeout: 60_000 })

    await expect(page.getByTestId("vault-link")).toHaveAttribute(
      "href",
      `https://github.com/${OWNER}/${REPO}/blob/data/vault.age`,
    )
    await expect(page.getByTestId("current-repo")).toHaveText(`${OWNER}/${REPO}`)
  })

  test("the integrity panel explains WHY no hash could be fetched", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page, "/settings")
    await unlock(page)
    await expect(page.getByTestId("integrity")).toHaveAttribute("data-verdict", "unverifiable", { timeout: 60_000 })
    // A dev build is its own, honest reason — distinct from the deployed case.
    await expect(page.getByTestId("integrity")).toContainText(/development build/i)
  })

  test("the repository can be changed, and the form starts on the current one", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page, "/settings")
    await unlock(page)
    await expect(page.getByTestId("reveal-qr")).toBeVisible({ timeout: 60_000 })

    await page.getByText(/store it in a different repository/i).click()
    await expect(page.getByTestId("repo-owner")).toHaveValue(OWNER)
    await expect(page.getByTestId("repo-slug")).toHaveValue(REPO)
  })
})
