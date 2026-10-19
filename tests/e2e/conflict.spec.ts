// E2E: the conflict view (spec §6.5's "nothing is discarded unseen", §6.6's never-rewrites-
// history). Drives a real stale-write race end to end: the app saves, GitHub refuses the
// non-fast-forward with a 422, and the three-way view opens on real decrypted versions.
import { test, expect, type Page, type Route } from "@playwright/test"
import { encryptVault, encryptToRecipient } from "../../src/vault/crypto"
import { generateDeviceIdentity, wrapIdentity } from "../../src/vault/identity"
import { DB_NAME } from "../../src/store/local"

const OWNER = "test-owner"
const REPO = "test-repo"
const API = "https://api.github.com"
const PASS = "correct-horse-battery-staple-eigenheim"

const BASE_TEXT = "line one\nline two\nline three\n"
const THEIRS_TEXT = "line one\nline two CHANGED BY THEM\nline three\n"
const MINE_SUFFIX = "line four added by me\n"
const HEAD_SHA = "commit-head"
const THEIRS_SHA = "commit-theirs"

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

let seedPromise: Promise<{
  wrappedIdentity: string
  token: string
  cachedVault: { armored: string; sha: string }
  theirsArmored: string
}> | null = null
function seed() {
  seedPromise ??= (async () => {
    const { identity, recipient } = await generateDeviceIdentity()
    return {
      wrappedIdentity: await wrapIdentity(identity, PASS),
      token: await encryptToRecipient("github_pat_fake_token", recipient),
      cachedVault: { armored: await encryptVault(BASE_TEXT, PASS), sha: HEAD_SHA },
      theirsArmored: await encryptVault(THEIRS_TEXT, PASS),
    }
  })()
  return seedPromise
}

interface RecordedCall {
  method: string
  path: string
  body: unknown
}

/** Serves a repo whose head moves the moment this app's first write is refused.
 *
 * Before the refusal, `readHead` reports the same sha the device already has cached, so the
 * editor's own mount-time background sync is a no-op and does not disturb the setup. The 422 on
 * the first ref update flips `theyWon`, after which the head is THEIR commit -- which is exactly
 * the state a real race leaves behind, and what `attemptWrite` then reads to build the
 * three-way merge. */
async function installRacingMock(page: Page): Promise<{ calls: RecordedCall[] }> {
  const calls: RecordedCall[] = []
  let theyWon = false

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

    const { cachedVault, theirsArmored } = await seed()
    const base = `/repos/${OWNER}/${REPO}`
    const armoredFor = (sha: string) => (sha === THEIRS_SHA ? theirsArmored : cachedVault.armored)

    if (pathname === base) return fulfillJson(route, 200, { private: true, permissions: { push: true } })

    if (pathname === `${base}/git/ref/heads/data`) {
      return fulfillJson(route, 200, { object: { sha: theyWon ? THEIRS_SHA : HEAD_SHA } })
    }
    if (pathname.startsWith(`${base}/git/commits/`)) {
      const sha = pathname.split("/").pop() as string
      return fulfillJson(route, 200, { sha, tree: { sha: `tree-${sha}` }, committer: { date: "2026-10-19T00:00:00Z" } })
    }
    if (pathname.startsWith(`${base}/git/trees/`)) {
      const sha = pathname.split("/").pop()?.replace("tree-", "") as string
      return fulfillJson(route, 200, {
        tree: [{ path: "vault.age", type: "blob", sha: `blob-${sha}`, size: armoredFor(sha).length }],
      })
    }
    if (pathname.startsWith(`${base}/git/blobs/`)) {
      const sha = pathname.split("/").pop()?.replace("blob-", "") as string
      return fulfillJson(route, 200, {
        content: Buffer.from(armoredFor(sha), "utf-8").toString("base64"),
        encoding: "base64",
      })
    }

    if (pathname === `${base}/git/blobs`) return fulfillJson(route, 201, { sha: "blob-new" })
    if (pathname === `${base}/git/trees`) return fulfillJson(route, 201, { sha: "tree-new" })
    if (pathname === `${base}/git/commits`) return fulfillJson(route, 201, { sha: "commit-resolved" })
    if (pathname === `${base}/git/refs/heads/data`) {
      if (!theyWon) {
        theyWon = true
        return fulfillJson(route, 422, { message: "Update is not a fast forward" })
      }
      return fulfillJson(route, 200, { object: { sha: "commit-resolved" } })
    }
    return fulfillJson(route, 404, { message: `conflict.spec.ts: unmocked ${request.method()} ${pathname}` })
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

/** Unlock, type a non-overlapping edit, and save -- landing in the conflict view. */
async function raceIntoConflict(page: Page): Promise<void> {
  await page.getByLabel(/passphrase/i).fill(PASS)
  await page.getByRole("button", { name: /^unlock$/i }).click()
  await expect(page.getByTestId("editor")).toHaveValue(BASE_TEXT, { timeout: 30_000 })

  await page.getByTestId("editor").fill(BASE_TEXT + MINE_SUFFIX)
  await page.getByTestId("editor").press("Control+s")
  await expect(page.getByTestId("pane-merged")).toBeVisible({ timeout: 30_000 })
}

test.describe("conflict view", () => {
  test("a stale commit opens the conflict view showing all three versions", async ({ page }) => {
    await installRacingMock(page)
    await seedDevice(page)
    await raceIntoConflict(page)

    // spec §6.5: all three, visible, decrypted -- not a summary and not a prompt to pick blind.
    await expect(page.getByTestId("pane-mine")).toContainText("line four added by me")
    await expect(page.getByTestId("pane-theirs")).toContainText("line two CHANGED BY THEM")
    await expect(page.getByTestId("pane-base")).toContainText("line two")
    await expect(page.getByTestId("conflict-headline")).not.toBeEmpty()
  })

  test("offers merged, mine and theirs, and nothing is discarded unseen", async ({ page }) => {
    await installRacingMock(page)
    await seedDevice(page)
    await raceIntoConflict(page)

    // Every one of the three ways out is present at once -- no path leaves this view having
    // silently dropped a side (spec §6.5).
    await expect(page.getByRole("button", { name: /keep mine/i })).toBeVisible()
    await expect(page.getByRole("button", { name: /keep theirs/i })).toBeVisible()
    await expect(page.getByRole("button", { name: /save merged/i })).toBeVisible()

    // And both human-written versions are on screen, in full, at the same time.
    await expect(page.getByTestId("pane-mine")).toContainText(MINE_SUFFIX.trim())
    await expect(page.getByTestId("pane-theirs")).toContainText("CHANGED BY THEM")
  })

  test("these two edits do not overlap, so the merge keeps BOTH and shows no markers", async ({ page }) => {
    await installRacingMock(page)
    await seedDevice(page)
    await raceIntoConflict(page)

    // The real three-way merge ran: their line-two change and my appended line four both
    // survive in one document, which is the case that must NOT require a human to arbitrate.
    const merged = await page.getByTestId("pane-merged").inputValue()
    expect(merged).toContain("line two CHANGED BY THEM")
    expect(merged).toContain("line four added by me")
    await expect(page.getByTestId("marker-note")).toBeHidden()
  })

  test("choosing a resolution commits it on the new base and returns to the editor", async ({ page }) => {
    const { calls } = await installRacingMock(page)
    await seedDevice(page)
    await raceIntoConflict(page)

    await page.getByRole("button", { name: /save merged/i }).click()

    // Back in the editor, on the settled text.
    await expect(page.getByTestId("editor")).toBeVisible({ timeout: 30_000 })
    // `inputValue()`, not `toContainText`: a textarea's text CONTENT is its initial HTML (empty
    // here, since the editor sets `.value`), so `toContainText` would be asserting against the
    // wrong property and fail for a reason that has nothing to do with the app.
    expect(await page.getByTestId("editor").inputValue()).toContain("line four added by me")
    await expect(page.getByTestId("save-state")).toContainText(/saved to github/i, { timeout: 30_000 })

    // "on the new base": the resolving commit's parent is THEIR commit, the one that won the
    // race -- not the sha that was just refused, which would be refused again forever.
    const commitPosts = calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/commits"))
    const resolving = commitPosts[commitPosts.length - 1] as { body: { parents: string[] } }
    expect(resolving.body.parents).toEqual([THEIRS_SHA])

    // spec §6.6: history is never rewritten. No write anywhere in this flow asked for a force
    // update -- the whole no-silent-data-loss guarantee rests on that being false.
    for (const call of calls) {
      if (call.body && typeof call.body === "object") {
        expect((call.body as { force?: unknown }).force).not.toBe(true)
      }
    }
  })

  test("keeping one side whole commits exactly that side", async ({ page }) => {
    await installRacingMock(page)
    await seedDevice(page)
    await raceIntoConflict(page)

    await page.getByRole("button", { name: /keep theirs/i }).click()

    await expect(page.getByTestId("editor")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("editor")).toHaveValue(THEIRS_TEXT)
  })

  test("conflict markers are visible in the merged text when the edits really overlap", async ({ page }) => {
    await installRacingMock(page)
    await seedDevice(page)

    await page.getByLabel(/passphrase/i).fill(PASS)
    await page.getByRole("button", { name: /^unlock$/i }).click()
    await expect(page.getByTestId("editor")).toHaveValue(BASE_TEXT, { timeout: 30_000 })

    // Change the SAME line they changed -- the case a three-way merge cannot settle alone.
    await page.getByTestId("editor").fill("line one\nline two CHANGED BY ME\nline three\n")
    await page.getByTestId("editor").press("Control+s")
    await expect(page.getByTestId("pane-merged")).toBeVisible({ timeout: 30_000 })

    const merged = await page.getByTestId("pane-merged").inputValue()
    expect(merged).toContain("<<<<<<< mine")
    expect(merged).toContain(">>>>>>> theirs")
    // And the view says so, rather than leaving the markers to be discovered later.
    await expect(page.getByTestId("marker-note")).toBeVisible()
  })
})
