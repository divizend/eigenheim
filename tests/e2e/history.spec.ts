// E2E: the history view (spec §6.6's restore-as-a-new-commit, §13's no-state-dead-ends).
import { test, expect, type Page, type Route } from "@playwright/test"
import { encryptVault, encryptToRecipient } from "../../src/vault/crypto"
import { generateDeviceIdentity, wrapIdentity } from "../../src/vault/identity"
import { DB_NAME } from "../../src/store/local"

const OWNER = "test-owner"
const REPO = "test-repo"
const API = "https://api.github.com"
const PASS = "correct-horse-battery-staple-eigenheim"
const OLD_PASS = "the-passphrase-used-before-a-rotation"

const CURRENT_TEXT = "alpha\nbeta\ngamma\n"
const OLDER_TEXT = "alpha\nBETA AS IT WAS\ngamma\n"
const HEAD_SHA = "commit-head"
const OLDER_SHA = "commit-older"
const ANCIENT_SHA = "commit-ancient"

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

let seedPromise: Promise<{
  wrappedIdentity: string
  token: string
  cachedVault: { armored: string; sha: string }
  olderArmored: string
  ancientArmored: string
}> | null = null
function seed() {
  seedPromise ??= (async () => {
    const { identity, recipient } = await generateDeviceIdentity()
    return {
      wrappedIdentity: await wrapIdentity(identity, PASS),
      token: await encryptToRecipient("github_pat_fake_token", recipient),
      cachedVault: { armored: await encryptVault(CURRENT_TEXT, PASS), sha: HEAD_SHA },
      olderArmored: await encryptVault(OLDER_TEXT, PASS),
      // Encrypted under a passphrase this device no longer has -- exactly what a long history
      // contains after a passphrase rotation (task 17).
      ancientArmored: await encryptVault("from before the rotation\n", OLD_PASS),
    }
  })()
  return seedPromise
}

async function installGithubMock(page: Page): Promise<{ calls: RecordedCall[] }> {
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

    const { cachedVault, olderArmored, ancientArmored } = await seed()
    const base = `/repos/${OWNER}/${REPO}`
    const armoredFor = (sha: string) =>
      sha === OLDER_SHA ? olderArmored : sha === ANCIENT_SHA ? ancientArmored : cachedVault.armored

    if (pathname === base) return fulfillJson(route, 200, { private: true, permissions: { push: true } })
    if (pathname === `${base}/git/ref/heads/data`) return fulfillJson(route, 200, { object: { sha: HEAD_SHA } })

    if (pathname === `${base}/commits`) {
      // GitHub returns newest first; this list is deliberately NOT in date order in the array
      // sense beyond that, so a view that re-sorted wrongly would be caught.
      // `author.date`, not `committer.date`: GithubStore.history reads `c.commit.author.date`
      // (src/store/github.ts). A mock that supplies only `committer` makes the whole list throw
      // a TypeError and the view correctly reports "history could not be read" -- which looks
      // exactly like a broken view and is actually a broken stub. Both are supplied here, as the
      // real API does.
      const commitMeta = (date: string) => ({
        author: { date },
        committer: { date },
        message: "Save from eigenheim",
      })
      return fulfillJson(route, 200, [
        { sha: HEAD_SHA, commit: commitMeta("2026-10-19T12:00:00Z") },
        { sha: OLDER_SHA, commit: commitMeta("2026-10-18T09:30:00Z") },
        { sha: ANCIENT_SHA, commit: commitMeta("2026-01-02T08:00:00Z") },
      ])
    }
    if (pathname.startsWith(`${base}/git/commits/`)) {
      const sha = pathname.split("/").pop() as string
      return fulfillJson(route, 200, { sha, tree: { sha: `tree-${sha}` }, committer: { date: "2026-10-19T00:00:00Z" } })
    }
    if (pathname.startsWith(`${base}/git/trees/`)) {
      const sha = (pathname.split("/").pop() as string).replace("tree-", "")
      return fulfillJson(route, 200, {
        tree: [{ path: "vault.age", type: "blob", sha: `blob-${sha}`, size: armoredFor(sha).length }],
      })
    }
    if (pathname.startsWith(`${base}/git/blobs/`)) {
      const sha = (pathname.split("/").pop() as string).replace("blob-", "")
      return fulfillJson(route, 200, {
        content: Buffer.from(armoredFor(sha), "utf-8").toString("base64"),
        encoding: "base64",
      })
    }
    if (pathname === `${base}/git/blobs`) return fulfillJson(route, 201, { sha: "blob-new" })
    if (pathname === `${base}/git/trees`) return fulfillJson(route, 201, { sha: "tree-new" })
    if (pathname === `${base}/git/commits`) return fulfillJson(route, 201, { sha: "commit-restored" })
    if (pathname === `${base}/git/refs/heads/data`) return fulfillJson(route, 200, { object: { sha: "commit-restored" } })

    return fulfillJson(route, 404, { message: `history.spec.ts: unmocked ${request.method()} ${pathname}` })
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

async function openHistory(page: Page): Promise<void> {
  await page.getByLabel(/passphrase/i).fill(PASS)
  await page.getByRole("button", { name: /^unlock$/i }).click()
  await expect(page.getByTestId("editor")).toHaveValue(CURRENT_TEXT, { timeout: 30_000 })
  await page.getByTestId("open-history").click()
  await expect(page.getByTestId("history-list")).toBeVisible()
}

test.describe("history view", () => {
  test("lists commits newest first with dates", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)
    await openHistory(page)

    const entries = page.locator(".history-entry .history-when")
    await expect(entries).toHaveCount(3)
    // Fixed locale/timezone in formatDate, so these are exact rather than fuzzy.
    await expect(entries.nth(0)).toHaveText("19 Oct 2026, 12:00 UTC")
    await expect(entries.nth(1)).toHaveText("18 Oct 2026, 09:30 UTC")
    await expect(entries.nth(2)).toHaveText("2 Jan 2026, 08:00 UTC")
  })

  test("selecting a version decrypts and shows it with a diff against current", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)
    await openHistory(page)

    await page.locator(".history-entry").nth(1).click()
    await expect(page.getByTestId("version-diff")).toBeVisible({ timeout: 30_000 })

    // Only the one line that differs is marked, and the context lines are present as context --
    // the property that a shared `splitLines` buys and a naive split would destroy.
    await expect(page.locator(".diff-removed")).toHaveText(["- beta\n"])
    await expect(page.locator(".diff-added")).toHaveText(["+ BETA AS IT WAS\n"])
    await expect(page.locator(".diff-same")).toHaveCount(2)
  })

  test("restoring writes a NEW commit and never rewrites history", async ({ page }) => {
    const { calls } = await installGithubMock(page)
    await seedDevice(page)
    await openHistory(page)

    await page.locator(".history-entry").nth(1).click()
    await expect(page.getByTestId("restore-btn")).toBeVisible({ timeout: 30_000 })
    await page.getByTestId("restore-btn").click()

    // Back in the editor on the restored text.
    await expect(page.getByTestId("editor")).toHaveValue(OLDER_TEXT, { timeout: 30_000 })

    // spec §6.6: a forward commit whose parent is the CURRENT head -- the version it replaced
    // stays reachable directly above it, so the restore is itself undoable.
    const commitPost = calls.find((c) => c.method === "POST" && c.path.endsWith("/git/commits"))
    expect((commitPost?.body as { parents: string[] }).parents).toEqual([HEAD_SHA])

    // And nothing anywhere asked to force.
    for (const call of calls) {
      if (call.body && typeof call.body === "object") {
        expect((call.body as { force?: unknown }).force).not.toBe(true)
      }
    }
  })

  test("a version that will not decrypt is reported without blanking the view", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)
    await openHistory(page)

    await page.locator(".history-entry").nth(2).click()
    await expect(page.getByTestId("version-problem")).toBeVisible({ timeout: 30_000 })

    // spec §13: reported, with a way forward, and the rest of the view intact -- every other
    // version is still listed and still selectable.
    await expect(page.getByTestId("version-problem")).toContainText(/passphrase change/i)
    await expect(page.locator(".history-entry")).toHaveCount(3)

    // Proven still usable: selecting a readable version right afterwards still works.
    await page.locator(".history-entry").nth(1).click()
    await expect(page.getByTestId("version-diff")).toBeVisible({ timeout: 30_000 })
  })

  test("going back to the editor keeps the text that was on screen", async ({ page }) => {
    await installGithubMock(page)
    await seedDevice(page)

    await page.getByLabel(/passphrase/i).fill(PASS)
    await page.getByRole("button", { name: /^unlock$/i }).click()
    await expect(page.getByTestId("editor")).toHaveValue(CURRENT_TEXT, { timeout: 30_000 })

    // Unsaved typing must survive a trip through history -- history diffs against what is on
    // screen, so it has to carry that text both ways or the round trip silently reverts work.
    await page.getByTestId("editor").fill("alpha\nbeta\ngamma\nunsaved line\n")
    await page.getByTestId("open-history").click()
    await expect(page.getByTestId("history-list")).toBeVisible()

    await page.getByRole("button", { name: /back to the editor/i }).click()
    await expect(page.getByTestId("editor")).toHaveValue("alpha\nbeta\ngamma\nunsaved line\n")
  })
})
