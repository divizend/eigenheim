// E2E: the setup wizard (spec §9's six-step onboarding; §5.5's acknowledgement and passphrase
// floor; §13's visibility guard). Runs against `vite preview`'s real production build in a real
// Chromium (playwright.config.ts's own webServer), with GitHub's REST API stubbed via
// `page.route` -- nothing here reaches the real api.github.com.
//
// `@playwright/test`'s own `test`/`expect` are imported explicitly and shadow this project's
// vitest-globals `test`/`expect` (tsconfig.test.json's ambient globals) within this file only --
// deliberately a different convention from the flat vitest-globals style every tests/unit/*.ts
// file uses, not an inconsistency.
import { test, expect, type Page, type Route } from "@playwright/test"

// Matches vite.config.ts's own fallback ("test-owner"/"test-repo", baked in whenever
// VERCEL_GIT_REPO_OWNER/VERCEL_GIT_REPO_SLUG are unset) -- confirmed unset in this box's shell
// before relying on it (`env | grep -i VERCEL` showed only VERCEL_ORG_ID/VERCEL_TOKEN, nothing
// VERCEL_GIT_*), so the production build this suite runs against always bakes in these two
// values.
const OWNER = "test-owner"
const REPO = "test-repo"
const API = "https://api.github.com"
const VALID_TOKEN = "github_pat_fake_fine_grained_token_value"

/** GitHub's REST API is same-origin-restricted from this app's own origin (`http://127.0.0.1:4173`),
 * so every mocked response below needs its own CORS headers for the browser to accept it -- a
 * route that returns the right JSON with the right status but no `access-control-allow-origin`
 * still fails client-side with a opaque network TypeError, independent of the mocked status code.
 * Confirmed empirically while first wiring this file: omitting these made every `ensureSetup()`
 * call reject with "Failed to fetch" even though the route handler itself ran and matched. The
 * real api.github.com sends exactly `access-control-allow-origin: *` (design spec §12's own
 * verified-facts table cites this), so mirroring it here is also the most faithful stub. */
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

/** One `page.route` catch-all per test, dispatching by method+path -- simpler and more robust
 * than registering one route per endpoint, and avoids depending on exactly how Playwright's glob
 * matching treats a literal path with no wildcard characters. `repoResponses` is consumed in
 * order on successive `GET /repos/{o}/{r}` calls (the public-repo-then-recheck test needs the
 * SAME endpoint to answer differently the second time); the last entry repeats for any call past
 * the end of the list. `dataRefStatus: 404` is the realistic "brand-new deployment" case this
 * wizard is built for (spec §9 step 5) -- the only case these six tests exercise. */
async function installGithubMock(
  page: Page,
  opts: {
    repoResponses: Array<{ private: boolean; permissions: { push: boolean } }>
    dataRefStatus?: number
  },
): Promise<{ calls: RecordedCall[] }> {
  const calls: RecordedCall[] = []
  let repoCallIndex = 0

  await page.route(`${API}/**`, async (route) => {
    const request = route.request()
    const method = request.method()
    const path = new URL(request.url()).pathname

    if (method === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() })
      return
    }

    calls.push({ method, path })

    if (method === "GET" && path === `/repos/${OWNER}/${REPO}`) {
      const idx = Math.min(repoCallIndex, opts.repoResponses.length - 1)
      repoCallIndex++
      await fulfillJson(route, 200, opts.repoResponses[idx])
      return
    }

    if (method === "GET" && path === `/repos/${OWNER}/${REPO}/git/ref/heads/data`) {
      const status = opts.dataRefStatus ?? 404
      if (status === 404) {
        await fulfillJson(route, 404, { message: "Not Found" })
      } else {
        await fulfillJson(route, 200, { object: { sha: "existing-data-sha" } })
      }
      return
    }

    if (method === "POST" && path === `/repos/${OWNER}/${REPO}/git/blobs`) {
      await fulfillJson(route, 201, { sha: `blob-sha-${calls.length}` })
      return
    }

    if (method === "POST" && path === `/repos/${OWNER}/${REPO}/git/trees`) {
      await fulfillJson(route, 201, { sha: "tree-sha" })
      return
    }

    if (method === "POST" && path === `/repos/${OWNER}/${REPO}/git/commits`) {
      await fulfillJson(route, 201, { sha: "commit-sha" })
      return
    }

    if (method === "POST" && path === `/repos/${OWNER}/${REPO}/git/refs`) {
      await fulfillJson(route, 201, { ref: "refs/heads/data" })
      return
    }

    throw new Error(`setup.spec.ts: unmocked GitHub API call: ${method} ${path}`)
  })

  return { calls }
}

/** Drives from a fresh load through steps 1-2 (acknowledgement, repo identity) to step 3 (the
 * token step), where every test but the "public repo" one needs to start filling in a token. */
async function driveToTokenStep(page: Page): Promise<void> {
  await page.goto("/")
  await page.getByRole("checkbox", { name: /cannot be recovered/i }).check()
  await page.getByRole("button", { name: /continue/i }).click()
  await page.getByRole("button", { name: /continue/i }).click()
}

/** Drives through the token step with a valid, already-private-and-writable repo, landing on the
 * passphrase step (step 4). */
async function driveToPassphraseStep(page: Page): Promise<void> {
  await driveToTokenStep(page)
  await page.getByLabel(/personal access token/i).fill(VALID_TOKEN)
  await page.getByRole("button", { name: /continue/i }).click()
  await expect(page.getByLabel(/^passphrase$/i)).toBeVisible()
}

test.describe("setup wizard", () => {
  test("the wizard refuses to finish until loss is acknowledged", async ({ page }) => {
    // spec §5.5 -- the one irreversible property, not softened
    await installGithubMock(page, { repoResponses: [{ private: true, permissions: { push: true } }] })
    await page.goto("/")

    await expect(page.getByRole("button", { name: /continue/i })).toBeDisabled()
    await page.getByRole("checkbox", { name: /cannot be recovered/i }).check()
    await expect(page.getByRole("button", { name: /continue/i })).toBeEnabled()
  })

  test("a prefilled six-word passphrase is offered and accepted", async ({ page }) => {
    await installGithubMock(page, { repoResponses: [{ private: true, permissions: { push: true } }] })
    await driveToPassphraseStep(page)

    const passphraseInput = page.getByLabel(/^passphrase$/i)
    const generated = await passphraseInput.inputValue()
    expect(generated.trim().split(" ").length).toBe(6)
    // The prefilled value must clear the floor on its own -- no rejection reason shown for it.
    await expect(page.getByTestId("passphrase-feedback")).toBeHidden()

    await page.getByLabel(/confirm passphrase/i).fill(generated)
    const continueBtn = page.getByRole("button", { name: /continue/i })
    await expect(continueBtn).toBeEnabled()
    await continueBtn.click()

    // "accepted" means it actually carries the wizard forward to the next step.
    await expect(page.getByTestId("recovery-sheet")).toBeVisible()
    await expect(page.getByTestId("recovery-sheet")).toContainText(generated)
  })

  test("a short passphrase is rejected inline with the reason", async ({ page }) => {
    await installGithubMock(page, { repoResponses: [{ private: true, permissions: { push: true } }] })
    await driveToPassphraseStep(page)

    await page.getByLabel(/^passphrase$/i).fill("too short")
    const feedback = page.getByTestId("passphrase-feedback")
    await expect(feedback).toBeVisible()
    await expect(feedback).toContainText(/too short/i)
    await expect(page.getByRole("button", { name: /continue/i })).toBeDisabled()
  })

  test("a public repo blocks setup and offers the settings link plus re-check", async ({ page }) => {
    // spec §13
    const { calls } = await installGithubMock(page, {
      repoResponses: [
        { private: false, permissions: { push: true } }, // first check: public -- blocked
        { private: true, permissions: { push: true } }, // after "check again": now private
      ],
    })
    await driveToTokenStep(page)
    await page.getByLabel(/personal access token/i).fill(VALID_TOKEN)
    await page.getByRole("button", { name: /continue/i }).click()

    await expect(page.getByRole("link", { name: /repository settings/i })).toBeVisible()
    const recheckBtn = page.getByRole("button", { name: /check again/i })
    await expect(recheckBtn).toBeVisible()

    // The re-check button must do real work, not just exist: clicking it re-validates, and with
    // the repo now reporting private the wizard actually proceeds past the block.
    await recheckBtn.click()
    await expect(page.getByLabel(/^passphrase$/i)).toBeVisible()
    expect(calls.filter((c) => c.method === "GET" && c.path === `/repos/${OWNER}/${REPO}`).length).toBe(2)
  })

  test("the printable sheet carries the passphrase, the repo, and the literal recovery command", async ({
    page,
  }) => {
    await installGithubMock(page, { repoResponses: [{ private: true, permissions: { push: true } }] })
    await driveToPassphraseStep(page)

    const generatedPassphrase = await page.getByLabel(/^passphrase$/i).inputValue()
    await page.getByLabel(/confirm passphrase/i).fill(generatedPassphrase)
    await page.getByRole("button", { name: /continue/i }).click()

    const sheet = page.getByTestId("recovery-sheet")
    await expect(sheet).toContainText(generatedPassphrase)
    await expect(sheet).toContainText(`${OWNER}/${REPO}`)
    await expect(sheet).toContainText("age -d vault.age") // spec §5.5
  })

  test("completing setup creates the data branch and lands in the editor", async ({ page }) => {
    const { calls } = await installGithubMock(page, {
      repoResponses: [{ private: true, permissions: { push: true } }],
      dataRefStatus: 404,
    })
    await driveToPassphraseStep(page)

    const generatedPassphrase = await page.getByLabel(/^passphrase$/i).inputValue()
    await page.getByLabel(/confirm passphrase/i).fill(generatedPassphrase)
    await page.getByRole("button", { name: /continue/i }).click()

    await expect(page.getByTestId("recovery-sheet")).toBeVisible()
    await page.getByRole("button", { name: /continue/i }).click()

    await page.getByRole("button", { name: /create my vault/i }).click()

    await expect(page.getByTestId("editor-placeholder")).toBeVisible({ timeout: 10_000 })

    // "creates the data branch": the real orphan-branch creation sequence actually ran, not just
    // that the UI moved on.
    const methods = (path: string) => calls.filter((c) => c.path === `/repos/${OWNER}/${REPO}${path}`).map((c) => c.method)
    expect(methods("/git/blobs")).toEqual(["POST", "POST"])
    expect(methods("/git/trees")).toEqual(["POST"])
    expect(methods("/git/commits")).toEqual(["POST"])
    expect(methods("/git/refs")).toEqual(["POST"])
  })
})
