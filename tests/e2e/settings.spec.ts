// E2E: settings (spec §9's second-device transfer, §5.5's passphrase rotation, §10.2's
// supply-chain integrity display, §13's honest statements about what rotation cannot undo).
import { test, expect, type Page, type Route } from "@playwright/test"
import { encryptVault, encryptToRecipient, decryptVault } from "../../src/vault/crypto"
import { generateDeviceIdentity, wrapIdentity, unwrapIdentity } from "../../src/vault/identity"
import { DB_NAME } from "../../src/store/local"

const OWNER = "test-owner"
const REPO = "test-repo"
const API = "https://api.github.com"
const PASS = "correct-horse-battery-staple-eigenheim"
const NEW_PASS = "an-entirely-different-long-passphrase-here"
const TEXT = "the only file\n"
const HEAD_SHA = "commit-head"
const TOKEN = "github_pat_fake_token"

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
  body: unknown
}

let seedPromise: Promise<{ wrappedIdentity: string; token: string; cachedVault: { armored: string; sha: string } }> | null =
  null
function seed() {
  seedPromise ??= (async () => {
    const { identity, recipient } = await generateDeviceIdentity()
    return {
      wrappedIdentity: await wrapIdentity(identity, PASS),
      token: await encryptToRecipient(TOKEN, recipient),
      cachedVault: { armored: await encryptVault(TEXT, PASS), sha: HEAD_SHA },
    }
  })()
  return seedPromise
}

async function installGithubMock(page: Page, opts: { tokenValid?: boolean } = {}): Promise<{ calls: RecordedCall[] }> {
  const calls: RecordedCall[] = []
  await page.route(`${API}/**`, async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() })

    let body: unknown = null
    try {
      body = request.postData() ? JSON.parse(request.postData() as string) : null
    } catch {
      body = request.postData()
    }
    calls.push({ method: request.method(), path: pathname, body })

    const { cachedVault } = await seed()
    const base = `/repos/${OWNER}/${REPO}`
    if (pathname === base) {
      // A replacement token is rejected by answering its own validation call with a 401; the
      // already-stored token keeps working because this flag only flips for the explicit
      // token-replacement test.
      const auth = request.headers()["authorization"] ?? ""
      if (opts.tokenValid === false && !auth.includes(TOKEN)) {
        return fulfillJson(route, 401, { message: "Bad credentials" })
      }
      return fulfillJson(route, 200, { private: true, permissions: { push: true } })
    }
    if (pathname === `${base}/git/ref/heads/data`) return fulfillJson(route, 200, { object: { sha: HEAD_SHA } })
    if (pathname.startsWith(`${base}/git/commits/`)) {
      const sha = pathname.split("/").pop() as string
      return fulfillJson(route, 200, { sha, tree: { sha: `tree-${sha}` }, committer: { date: "2026-10-19T00:00:00Z" } })
    }
    if (pathname.startsWith(`${base}/git/trees/`)) {
      return fulfillJson(route, 200, {
        tree: [{ path: "vault.age", type: "blob", sha: "blob-head", size: cachedVault.armored.length }],
      })
    }
    if (pathname.startsWith(`${base}/git/blobs/`)) {
      return fulfillJson(route, 200, {
        content: Buffer.from(cachedVault.armored, "utf-8").toString("base64"),
        encoding: "base64",
      })
    }
    if (pathname === `${base}/git/blobs`) return fulfillJson(route, 201, { sha: "blob-new" })
    if (pathname === `${base}/git/trees`) return fulfillJson(route, 201, { sha: "tree-new" })
    if (pathname === `${base}/git/commits`) return fulfillJson(route, 201, { sha: "commit-rotated" })
    if (pathname === `${base}/git/refs/heads/data`) return fulfillJson(route, 200, { object: { sha: "commit-rotated" } })
    return fulfillJson(route, 404, { message: `settings.spec.ts: unmocked ${request.method()} ${pathname}` })
  })
  return { calls }
}

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

async function openSettings(page: Page): Promise<void> {
  await page.getByLabel(/passphrase/i).fill(PASS)
  await page.getByRole("button", { name: /^unlock$/i }).click()
  await expect(page.getByTestId("editor")).toHaveValue(TEXT, { timeout: 30_000 })
  await page.getByTestId("open-settings").click()
  await expect(page.getByTestId("reveal-qr")).toBeVisible()
}

/** Reads a slot straight back out of the app's own IndexedDB. */
async function readSlot(page: Page, key: string): Promise<unknown> {
  return page.evaluate(
    ({ dbName, key }) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const get = db.transaction("slots", "readonly").objectStore("slots").get(key)
          get.onsuccess = () => {
            db.close()
            resolve(get.result ?? null)
          }
          get.onerror = () => reject(get.error)
        }
      }),
    { dbName: DB_NAME, key },
  )
}

test.describe("settings", () => {
  test("the transfer code is behind an explicit reveal, not shown by default", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)
    await openSettings(page)

    // It is a bearer credential on screen: anything that can read it can write to the repo. So
    // it must not be rendered simply because someone opened Settings next to a window.
    await expect(page.getByTestId("qr-area")).toBeHidden()
    await expect(page.getByTestId("qr-canvas")).toBeHidden()
  })

  test("revealing shows a QR encoding owner, repo and token for a second device", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)
    await openSettings(page)

    await page.getByTestId("reveal-qr").click()
    await expect(page.getByTestId("qr-area")).toBeVisible()
    await expect(page.getByTestId("qr-canvas")).toBeVisible()

    // The copyable form carries exactly what task 18's receiving side parses -- and the canvas
    // really was drawn (a QR that renders as a blank element would still "be visible").
    const payload = JSON.parse(await page.getByTestId("qr-text").inputValue()) as Record<string, string>
    expect(payload).toEqual({ owner: OWNER, repo: REPO, token: TOKEN })
    const drawn = await page.getByTestId("qr-canvas").evaluate((c) => (c as HTMLCanvasElement).width > 0)
    expect(drawn).toBe(true)

    // The passphrase is never in it.
    expect(await page.getByTestId("qr-text").inputValue()).not.toContain(PASS)
  })

  test("a replaced token is validated before being stored", async ({ page }) => {
    await installGithubMock(page, { tokenValid: false })
    await seedDevice(page)
    await openSettings(page)

    const before = await readSlot(page, "token")
    await page.getByTestId("token-input").fill("github_pat_a_bad_replacement")
    await page.getByTestId("save-token").click()

    await expect(page.getByTestId("token-feedback")).toBeVisible({ timeout: 30_000 })
    // Rejected, and the working credential is untouched -- the whole point of checking first.
    expect(await readSlot(page, "token")).toEqual(before)
  })

  test("the passphrase-change screen states that old commits stay readable with the old passphrase", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)
    await openSettings(page)

    // spec §13: stated honestly and up front, not discovered later when an old version will not
    // open. Nothing rewrites git history, so this is simply true and must be said.
    await expect(page.getByTestId("rotation-warning")).toContainText(/earlier versions/i)
    await expect(page.getByTestId("rotation-warning")).toContainText(/old passphrase/i)
    await expect(page.getByTestId("rotation-warning")).toContainText(/recovery sheet/i)
  })

  test("changing the passphrase re-encrypts, re-wraps the identity, and commits", async ({ page }) => {
    const { calls } = await installGithubMock(page)
    await seedDevice(page)
    await openSettings(page)

    await page.getByTestId("new-passphrase").fill(NEW_PASS)
    await page.getByTestId("confirm-passphrase").fill(NEW_PASS)
    await page.getByTestId("save-passphrase").click()

    await expect(page.getByTestId("passphrase-feedback")).toContainText(/changed/i, { timeout: 60_000 })

    // Committed: the blob that went to GitHub opens under the NEW passphrase and not the old.
    const blobPost = calls.find((c) => c.method === "POST" && c.path.endsWith("/git/blobs"))
    const armored = String((blobPost?.body as { content: string }).content)
    expect(await decryptVault(armored, NEW_PASS)).toBe(TEXT)
    await expect(decryptVault(armored, PASS)).rejects.toThrow()

    // Re-wrapped: the stored device identity now opens under the new passphrase. Both slots
    // moved -- the pair that must never disagree.
    const wrapped = (await readSlot(page, "wrappedIdentity")) as string
    expect(await unwrapIdentity(wrapped, NEW_PASS)).toMatch(/^AGE-SECRET-KEY-/)
    const cached = (await readSlot(page, "cachedVault")) as { armored: string; sha: string }
    expect(await decryptVault(cached.armored, NEW_PASS)).toBe(TEXT)

    // And the new passphrase really is what unlocks this device from cold.
    //
    // Note the reload happens at /settings, so this also pins the routing property: the gate
    // outranks the URL (unlock is shown first), and the requested route survives it (settings
    // comes back afterwards, not the editor). A deep link that silently dropped you somewhere
    // else after unlocking would make the URL a lie.
    await page.reload()
    expect(new URL(page.url()).pathname).toBe("/settings")
    await page.getByLabel(/passphrase/i).fill(NEW_PASS)
    await page.getByRole("button", { name: /^unlock$/i }).click()
    await expect(page.getByTestId("reveal-qr")).toBeVisible({ timeout: 60_000 })

    // The vault itself still opens on the new passphrase, from the editor.
    await page.getByRole("button", { name: /back to the editor/i }).click()
    await expect(page.getByTestId("editor")).toHaveValue(TEXT, { timeout: 60_000 })
    expect(new URL(page.url()).pathname).toBe("/")
  })

  test("displays the running build and says plainly that a dev build cannot be verified", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)
    await openSettings(page)

    await expect(page.getByTestId("build-commit")).toHaveText("dev")
    // spec §10.2 / ruling R2: the hash is MEASURED from the running bundle, never baked in. A
    // preview build has no CI-published hash to compare against, and that reads as "cannot
    // verify" rather than as a mismatch warning.
    await expect(page.getByTestId("integrity")).toHaveAttribute("data-verdict", "unverifiable", { timeout: 30_000 })
    await expect(page.getByTestId("integrity")).toContainText(/development build/i)
  })
})
