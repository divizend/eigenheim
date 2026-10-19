// E2E: second-device onboarding (spec §9's transfer flow; ruling R29's dead-end fix).
//
// This runs the wizard on a device with EMPTY local storage against a repo that already holds a
// vault -- which is both the real second-device case and, identically, the case a device lands in
// after a mid-setup failure. Ruling R29 routed that second one here deliberately: the way forward
// is the same, so there is one flow rather than two.
import { test, expect, type Page, type Route } from "@playwright/test"
import { encryptVault } from "../../src/vault/crypto"

const OWNER = "test-owner"
const REPO = "test-repo"
const API = "https://api.github.com"
const PASS = "correct-horse-battery-staple-eigenheim"
const TEXT = "written on the first device\n"
const HEAD_SHA = "commit-existing"
const TOKEN = "github_pat_from_the_first_device"

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

let armoredPromise: Promise<string> | null = null
function armored(): Promise<string> {
  armoredPromise ??= encryptVault(TEXT, PASS)
  return armoredPromise
}

/** A repo that ALREADY has a `data` branch -- the condition that routes the wizard to the join
 * flow instead of initialisation. */
async function installExistingVaultMock(page: Page): Promise<{ calls: string[] }> {
  const calls: string[] = []
  await page.route(`${API}/**`, async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() })
    calls.push(`${request.method()} ${pathname}`)

    const vault = await armored()
    const base = `/repos/${OWNER}/${REPO}`
    if (pathname === base) return fulfillJson(route, 200, { private: true, permissions: { push: true } })
    if (pathname === `${base}/git/ref/heads/data`) return fulfillJson(route, 200, { object: { sha: HEAD_SHA } })
    if (pathname.startsWith(`${base}/git/commits/`)) {
      return fulfillJson(route, 200, { sha: HEAD_SHA, tree: { sha: "tree-head" }, committer: { date: "2026-10-19T00:00:00Z" } })
    }
    if (pathname.startsWith(`${base}/git/trees/`)) {
      return fulfillJson(route, 200, { tree: [{ path: "vault.age", type: "blob", sha: "blob-head", size: vault.length }] })
    }
    if (pathname.startsWith(`${base}/git/blobs/`)) {
      return fulfillJson(route, 200, { content: Buffer.from(vault, "utf-8").toString("base64"), encoding: "base64" })
    }
    return fulfillJson(route, 404, { message: `second-device.spec.ts: unmocked ${request.method()} ${pathname}` })
  })
  return { calls }
}

/** Drives the wizard's first two steps on a fresh device, stopping at the token step. */
async function driveToTokenStep(page: Page): Promise<void> {
  await page.goto("/")
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: /continue/i }).click()
  await page.getByRole("button", { name: /continue/i }).click()
  await expect(page.getByTestId("transfer-details")).toBeVisible()
}

test.describe("second-device onboarding", () => {
  test("offers scan-or-paste at the token step", async ({ page }) => {
    await installExistingVaultMock(page)
    await driveToTokenStep(page)

    await page.getByTestId("transfer-details").getByText(/already set this up on another device/i).click()
    await expect(page.getByTestId("transfer-input")).toBeVisible()
    await expect(page.getByTestId("use-transfer")).toBeVisible()
  })

  test("falls back to manual paste where BarcodeDetector is unavailable", async ({ page }) => {
    await installExistingVaultMock(page)
    await driveToTokenStep(page)
    await page.getByTestId("transfer-details").getByText(/already set this up on another device/i).click()

    // Chromium in this harness exposes no BarcodeDetector, which is also Firefox's and Safari's
    // behaviour -- so the scan shortcut is simply absent while the paste field, the path that
    // must always work, is present and usable.
    const hasDetector = await page.evaluate(() => "BarcodeDetector" in globalThis)
    expect(hasDetector).toBe(false)
    await expect(page.getByTestId("scan-btn")).toBeHidden()
    await expect(page.getByTestId("transfer-input")).toBeEditable()
  })

  test("a malformed transfer payload is rejected with a usable message", async ({ page }) => {
    await installExistingVaultMock(page)
    await driveToTokenStep(page)
    await page.getByTestId("transfer-details").getByText(/already set this up on another device/i).click()

    await page.getByTestId("transfer-input").fill("this is not a transfer code")
    await page.getByTestId("use-transfer").click()
    await expect(page.getByTestId("transfer-feedback")).toContainText(/starts with \{/)

    // A valid code for a DIFFERENT deployment is the subtle case: it names both repos, so the
    // user can see which one they took it from.
    await page.getByTestId("transfer-input").fill(JSON.stringify({ owner: "someone", repo: "else", token: "t" }))
    await page.getByTestId("use-transfer").click()
    await expect(page.getByTestId("transfer-feedback")).toContainText("someone/else")
    await expect(page.getByTestId("transfer-feedback")).toContainText(`${OWNER}/${REPO}`)
  })

  test("a pasted transfer payload leaves only the passphrase to enter", async ({ page }) => {
    await installExistingVaultMock(page)
    await driveToTokenStep(page)
    await page.getByTestId("transfer-details").getByText(/already set this up on another device/i).click()

    await page.getByTestId("transfer-input").fill(JSON.stringify({ owner: OWNER, repo: REPO, token: TOKEN }))
    await page.getByTestId("use-transfer").click()

    // Straight to the join step: no token to create, no passphrase to invent, no vault to
    // initialise -- exactly the point of the QR.
    await expect(page.getByTestId("adopt-passphrase")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("adopt-intro")).toContainText(/already holds a vault/i)
  })

  test("after transfer, the second device decrypts the existing vault", async ({ page }) => {
    await installExistingVaultMock(page)
    await driveToTokenStep(page)
    await page.getByTestId("transfer-details").getByText(/already set this up on another device/i).click()
    await page.getByTestId("transfer-input").fill(JSON.stringify({ owner: OWNER, repo: REPO, token: TOKEN }))
    await page.getByTestId("use-transfer").click()
    await expect(page.getByTestId("adopt-passphrase")).toBeVisible({ timeout: 30_000 })

    await page.getByTestId("adopt-passphrase").fill(PASS)
    await page.getByTestId("adopt-btn").click()

    // The first device's text, on the second device, decrypted locally.
    await expect(page.getByTestId("editor")).toHaveValue(TEXT, { timeout: 60_000 })

    // And this device is now genuinely set up: a reload goes to unlock, not back to the wizard.
    await page.reload()
    await expect(page.getByRole("button", { name: /^unlock$/i })).toBeVisible({ timeout: 30_000 })
  })

  test("a wrong passphrase at the join step says so and keeps the field (ruling R29's state is never a dead end)", async ({
    page,
  }) => {
    await installExistingVaultMock(page)
    await driveToTokenStep(page)

    // Reached WITHOUT a transfer code -- a manually pasted token against a repo that already has
    // a vault. This is exactly the state a mid-setup failure strands a device in, and it used to
    // dead-end here telling the user to transfer from a device that does not exist.
    await page.getByLabel(/personal access token/i).fill(TOKEN)
    await page.getByRole("button", { name: /continue/i }).click()
    await expect(page.getByTestId("adopt-passphrase")).toBeVisible({ timeout: 30_000 })

    await page.getByTestId("adopt-passphrase").fill("not-the-right-passphrase-at-all")
    await page.getByTestId("adopt-btn").click()
    await expect(page.getByTestId("adopt-feedback")).toContainText(/did not open this vault/i, { timeout: 60_000 })
    await expect(page.getByTestId("adopt-passphrase")).toBeVisible()
  })
})
