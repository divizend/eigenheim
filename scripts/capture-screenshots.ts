// Captures the onboarding screenshots the README references, by driving the REAL app in a real
// browser (spec §9's "screenshots are a maintained asset", not an archaeology project).
//
// Run with:  npm run capture:screenshots
//
// Scope, stated plainly because it is a real limit rather than an omission: this captures THIS
// APP's own screens, which is everything the README shows. It deliberately does not capture
// GitHub's fine-grained-token UI. Those would need a browser logged into a real GitHub account,
// which is a human credential this script has no business holding and CI has no way to supply;
// the wizard therefore walks the user through that UI in words, with a direct link, rather than
// with pictures that would also go stale on GitHub's schedule rather than ours.
import { chromium, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const OUT = join(process.cwd(), "docs", "onboarding")
const BASE = process.env.EIGENHEIM_BASE_URL ?? "http://127.0.0.1:4173"
const API = "https://api.github.com"
const OWNER = "test-owner"
const REPO = "test-repo"

function cors(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-github-api-version",
  }
}

/** The repo looks brand new: private, writable, no data branch yet. */
async function mockGithub(page: Page): Promise<void> {
  await page.route(`${API}/**`, async (route) => {
    const { pathname } = new URL(route.request().url())
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors() })
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers: { "content-type": "application/json", ...cors() }, body: JSON.stringify(body) })
    const base = `/repos/${OWNER}/${REPO}`
    if (pathname === base) return json(200, { private: true, permissions: { push: true } })
    if (pathname === `${base}/git/ref/heads/data`) return json(404, { message: "Not Found" })
    if (pathname === `${base}/git/blobs`) return json(201, { sha: "blob" })
    if (pathname === `${base}/git/trees`) return json(201, { sha: "tree" })
    if (pathname === `${base}/git/commits`) return json(201, { sha: "commit" })
    if (pathname === `${base}/git/refs`) return json(201, { ref: "refs/heads/data" })
    return json(404, { message: `unmocked ${pathname}` })
  })
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, name), fullPage: true })
  // eslint-disable-next-line no-console
  console.log(`captured docs/onboarding/${name}`)
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })

  // Suppress the service worker for the capture only. A previous run can leave a worker in
  // `waiting`, and the update prompt then floats over every screenshot -- correct behaviour in
  // the app, pure noise in documentation. Registration is the only thing stubbed out; every
  // screen below is otherwise the real app.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: async () => { throw new Error("disabled for screenshots") } },
    })
  })

  await mockGithub(page)

  await page.goto(BASE)
  await page.getByRole("checkbox").waitFor()
  await shot(page, "01-what-this-is.png")

  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: /continue/i }).click()
  await page.getByRole("button", { name: /continue/i }).click()
  await page.getByLabel(/personal access token/i).waitFor()
  await shot(page, "02-connect-your-repository.png")

  await page.getByLabel(/personal access token/i).fill("github_pat_" + "x".repeat(22))
  await page.getByRole("button", { name: /continue/i }).click()
  await page.getByLabel(/^passphrase$/i).waitFor({ timeout: 60_000 })
  await shot(page, "03-choose-your-passphrase.png")

  const generated = await page.getByLabel(/^passphrase$/i).inputValue()
  await page.getByLabel(/confirm passphrase/i).fill(generated)
  await page.getByRole("button", { name: /continue/i }).click()
  await page.getByTestId("recovery-sheet").waitFor()
  await shot(page, "04-recovery-sheet.png")

  await page.getByRole("button", { name: /continue/i }).click()
  await page.getByRole("button", { name: /create my vault/i }).click()
  await page.getByTestId("editor").waitFor({ timeout: 60_000 })
  await page.getByTestId("editor").fill("The only file.\n\nOne monospace text file, encrypted in this browser,\nstored as ciphertext in your own GitHub repository.\n")
  await shot(page, "05-the-editor.png")

  await page.getByTestId("open-settings").click()
  await page.getByTestId("reveal-qr").waitFor()
  await page.getByTestId("reveal-qr").click()
  await page.getByTestId("qr-canvas").waitFor()
  await shot(page, "06-settings.png")

  await browser.close()
}

await main()
