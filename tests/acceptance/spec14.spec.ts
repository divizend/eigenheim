// The acceptance run (spec §14). NOTHING here is mocked: a real private GitHub repository, a
// real token, the real production bundle in a real browser, and the real `age` binary.
//
// What this deliberately does NOT claim to cover, because none of them is something a script
// can honestly perform — and asserting them anyway would be exactly the kind of "verified" that
// is not:
//
//   §14.1  Click Deploy, get a Vercel URL        — needs a human with a Vercel account.
//   §14.2  Create the token in GitHub's web UI   — needs a logged-in human browser session.
//          GitHub has no API for minting a personal access token, by design.
//   §14.11 Point a personal domain at it         — needs the domain owner's DNS.
//
// And one honest consequence of §14.2: the setup WIZARD refuses classic (`ghp_`) tokens outright
// (spec §6.7 requires a fine-grained one), so a live run of the wizard's own token step needs a
// fine-grained PAT that only a human can create. That path — §14.3's floor and sheet, and
// §14.7's second-device join — is covered against the real production bundle in a real browser
// by tests/e2e/setup.spec.ts, tests/e2e/settings.spec.ts and tests/e2e/second-device.spec.ts.
// What runs HERE is everything downstream of it, against real GitHub: §14.4, §14.5, §14.6,
// §14.8, §14.9 and §14.10.
//
// §14.6 — "the one that matters most: the difference between sovereignty and a slogan" — is
// done in full, with the official binary, against the bytes actually committed to GitHub.
import { test, expect, type BrowserContext, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encryptVault, encryptToRecipient } from "../../src/vault/crypto"
import { generateDeviceIdentity, wrapIdentity } from "../../src/vault/identity"
import { GithubStore } from "../../src/store/github"
import { DB_NAME } from "../../src/store/local"

const TOKEN = process.env.EIGENHEIM_IT_TOKEN ?? ""
const AGE_BIN = process.env.EIGENHEIM_AGE_BIN ?? ""
const OWNER = process.env.EIGENHEIM_ACCEPTANCE_OWNER ?? ""
const REPO = process.env.EIGENHEIM_ACCEPTANCE_REPO ?? ""

const TEXT = "the only file\n\nwith ünïcödé, 日本語 and an emoji 🔐\n"
const REPORT = "docs/acceptance-run.md"

/** Appends one verified step to the report, so the artifact is written as the run proves each
 * claim rather than summarised afterwards from memory. */
function record(step: string, detail: string): void {
  appendFileSync(REPORT, `- **${step}** ${detail}\n`)
}

async function gh(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

let passphrase = ""
let identity = ""

/** Seeds a browser profile as a device that has already completed setup against the REAL repo.
 *
 * This is the only thing standing in for a human: the wizard's token step requires a
 * fine-grained PAT (see the header), so the slots the wizard WOULD have written are written
 * here instead, through LocalStore's own contract. Everything afterwards -- every save, every
 * read, every conflict -- runs the real app against real GitHub. */
async function seedDevice(context: BrowserContext, cachedVault: { armored: string; sha: string }): Promise<Page> {
  const page = await context.newPage()
  await page.goto("/")
  const wrapped = await wrapIdentity(identity, passphrase)
  const token = await encryptToRecipient(TOKEN, await (await import("../../src/vault/identity")).recipientFor(identity))
  await page.evaluate(
    async ({ dbName, wrapped, token, cachedVault }) => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1)
        req.onupgradeneeded = () => req.result.createObjectStore("slots")
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction("slots", "readwrite")
          const s = tx.objectStore("slots")
          s.put(token, "token")
          s.put(cachedVault, "cachedVault")
          s.put(wrapped, "wrappedIdentity")
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      })
    },
    { dbName: DB_NAME, wrapped, token, cachedVault },
  )
  await page.reload()
  return page
}

async function unlock(page: Page, expected: string): Promise<void> {
  await page.getByLabel(/passphrase/i).fill(passphrase)
  await page.getByRole("button", { name: /^unlock$/i }).click()
  await expect(page.getByTestId("editor")).toHaveValue(expected, { timeout: 180_000 })
}

async function saveToGithub(page: Page): Promise<void> {
  await page.getByTestId("editor").press("Control+s")
  await expect(page.getByTestId("save-state")).toContainText(/saved to github/i, { timeout: 180_000 })
}

test.describe.configure({ mode: "serial" })

test.describe("spec §14 acceptance", () => {
  test.skip(!TOKEN || !AGE_BIN || !OWNER || !REPO, "run via ./scripts/acceptance.sh with a real token and the age binary")

  test("§14 setup — initialise a real vault on a real private repository", async () => {
    writeFileSync(
      REPORT,
      `# Acceptance run (spec §14)\n\nRun at ${new Date().toISOString()} against a REAL private GitHub repository ` +
        `(\`${OWNER}/${REPO}\`, deleted at the end), a REAL Chromium running the production bundle, and the REAL ` +
        `\`age\` binary. Nothing below was mocked.\n\n` +
        `Not covered here, because no script can honestly perform them: §14.1 (a human clicking Deploy on Vercel), ` +
        `§14.2 (creating a fine-grained token in GitHub's web UI — GitHub has no API for minting one), and §14.11 ` +
        `(pointing a personal domain at the deployment). Because the wizard correctly refuses classic tokens, §14.3 ` +
        `and §14.7 are covered against the production bundle in a real browser by the E2E suite rather than live here.\n\n`,
    )

    passphrase = `acceptance-${Math.random().toString(36).slice(2)}-sovereign-vault-passphrase`
    const generated = await generateDeviceIdentity()
    identity = generated.identity

    const store = new GithubStore({ owner: OWNER, repo: REPO, token: TOKEN })
    const armored = await encryptVault("", passphrase)
    const { sha } = await store.initializeDataBranch({ armored })
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    record("§14 setup", `created the orphan \`data\` branch on \`${OWNER}/${REPO}\` through the app's own storage layer (commit \`${sha.slice(0, 7)}\`).`)
  })

  test("§14.4 — type, commit, reload, and see the text", async ({ browser }) => {
    const store = new GithubStore({ owner: OWNER, repo: REPO, token: TOKEN })
    const head = await store.readHead()
    const context = await browser.newContext()
    const page = await seedDevice(context, { armored: head.armored, sha: head.sha })

    await unlock(page, "")
    await page.getByTestId("editor").fill(TEXT)
    await saveToGithub(page)

    await page.reload()
    await unlock(page, TEXT)
    record("§14.4", "typed text into the editor, saved it to GitHub with Ctrl+S, reloaded the page, unlocked again — and the same text came back, decrypted in the browser.")
    await context.close()
  })

  test("§14.5 — the repository contains only an armored blob and a plaintext README", async () => {
    const tree = (await (await gh("GET", `/repos/${OWNER}/${REPO}/git/trees/data`)).json()) as {
      tree: Array<{ path: string }>
    }
    const paths = tree.tree.map((t) => t.path).sort()
    expect(paths).toEqual(["README.md", "vault.age"])

    const blob = (await (await gh("GET", `/repos/${OWNER}/${REPO}/contents/vault.age?ref=data`)).json()) as {
      content: string
    }
    const armored = Buffer.from(blob.content, "base64").toString("utf-8")
    expect(armored.startsWith("-----BEGIN AGE ENCRYPTED FILE-----")).toBe(true)

    // The assertion that matters: no fragment of the plaintext survives into what GitHub holds.
    for (const fragment of ["the only file", "日本語", "🔐"]) {
      expect(armored, `"${fragment}" appears in the committed ciphertext`).not.toContain(fragment)
    }

    const readme = (await (await gh("GET", `/repos/${OWNER}/${REPO}/contents/README.md?ref=data`)).json()) as {
      content: string
    }
    const readmeText = Buffer.from(readme.content, "base64").toString("utf-8")
    record(
      "§14.5",
      `the \`data\` branch holds exactly \`README.md\` and \`vault.age\`. The blob begins ` +
        `\`-----BEGIN AGE ENCRYPTED FILE-----\` and contains no fragment of the plaintext (checked for ` +
        `"the only file", "日本語" and the emoji). The README is plaintext: "${readmeText.split("\n")[0]}".`,
    )
  })

  test("§14.6 — download the blob and decrypt it with the official age CLI, passphrase only", async () => {
    const work = mkdtempSync(join(tmpdir(), "eigenheim-acceptance-"))
    try {
      const blob = (await (await gh("GET", `/repos/${OWNER}/${REPO}/contents/vault.age?ref=data`)).json()) as {
        content: string
      }
      const vault = join(work, "vault.age")
      const out = join(work, "decrypted.txt")
      writeFileSync(vault, Buffer.from(blob.content, "base64").toString("utf-8"))

      execFileSync("python3", ["scripts/age-pty.py", AGE_BIN, "-d", "-o", out, vault], {
        env: { ...process.env, AGE_PASSPHRASE: passphrase },
      })

      // Byte-for-byte against what was typed in the browser.
      expect(readFileSync(out)).toEqual(Buffer.from(TEXT, "utf-8"))
      const version = execFileSync(AGE_BIN, ["--version"], { encoding: "utf-8" }).trim()
      record(
        "§14.6",
        `**downloaded the committed blob from github.com and decrypted it with the official \`age\` ${version} ` +
          `binary, using only the passphrase — no part of this app involved.** It returned the exact bytes typed ` +
          `in the browser, byte-for-byte, including Unicode and the emoji. This is the step the spec calls "the ` +
          `difference between sovereignty and a slogan".`,
      )
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test("§14.8 — two devices edit concurrently, conflict, and resolve with nothing lost", async ({ browser }) => {
    const store = new GithubStore({ owner: OWNER, repo: REPO, token: TOKEN })
    const head = await store.readHead()

    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const page1 = await seedDevice(ctx1, { armored: head.armored, sha: head.sha })
    const page2 = await seedDevice(ctx2, { armored: head.armored, sha: head.sha })
    await unlock(page1, TEXT)
    await unlock(page2, TEXT)

    // Device two gets there first. Confirmed against GitHub itself rather than against device
    // two's own indicator: what makes device one's next save a conflict is the state of the
    // BRANCH, so that is what has to be true before continuing.
    await page2.getByTestId("editor").fill(TEXT + "device two wrote this line\n")
    await saveToGithub(page2)

    const { decryptVault } = await import("../../src/vault/crypto")
    const afterTwo = await new GithubStore({ owner: OWNER, repo: REPO, token: TOKEN }).readHead()
    expect(afterTwo.sha).not.toBe(head.sha)
    expect(await decryptVault(afterTwo.armored, passphrase)).toContain("device two")

    // Device one is now editing from a base that has been superseded.
    await page1.getByTestId("editor").fill(TEXT + "device one wrote a different line\n")
    await page1.getByTestId("editor").press("Control+s")
    await expect(page1.getByTestId("pane-merged")).toBeVisible({ timeout: 180_000 })

    await expect(page1.getByTestId("pane-mine")).toContainText("device one")
    await expect(page1.getByTestId("pane-theirs")).toContainText("device two")

    await page1.getByRole("button", { name: /save merged/i }).click()
    await expect(page1.getByTestId("editor")).toBeVisible({ timeout: 180_000 })
    const merged = await page1.getByTestId("editor").inputValue()
    expect(merged).toContain("device one")
    expect(merged).toContain("device two")
    record(
      "§14.8",
      "two independent browser profiles edited from the same base. GitHub refused the second write rather than " +
        "overwriting (fast-forward-only), the conflict view showed both versions side by side, and the resolution " +
        "kept BOTH lines. Nothing was lost or silently discarded.",
    )
    await ctx1.close()
    await ctx2.close()
  })

  test("§14.9 — go offline, edit, reconnect, and the queued save lands", async ({ browser }) => {
    const store = new GithubStore({ owner: OWNER, repo: REPO, token: TOKEN })
    const head = await store.readHead()
    const current = await (await import("../../src/vault/crypto")).decryptVault(head.armored, passphrase)

    const context = await browser.newContext()
    const page = await seedDevice(context, { armored: head.armored, sha: head.sha })
    await unlock(page, current)

    await context.setOffline(true)
    await page.evaluate(() => window.dispatchEvent(new Event("offline")))
    await expect(page.getByTestId("save-state")).toContainText(/offline/i, { timeout: 60_000 })

    const offlineText = current + "written while offline\n"
    await page.getByTestId("editor").fill(offlineText)
    await page.getByTestId("editor").press("Control+s")

    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event("online")))
    await expect(page.getByTestId("save-state")).toContainText(/saved to github/i, { timeout: 180_000 })

    // Confirmed on GitHub's side, not just in the UI.
    const after = await new GithubStore({ owner: OWNER, repo: REPO, token: TOKEN }).readHead()
    const landed = await (await import("../../src/vault/crypto")).decryptVault(after.armored, passphrase)
    expect(landed).toBe(offlineText)
    record(
      "§14.9",
      "went offline, kept editing, saved into the local queue, then reconnected — the queued save reached GitHub " +
        "on its own, confirmed by reading the branch head back and decrypting it.",
    )
    await context.close()
  })

  test("§14.10 — restore an earlier version as a new commit", async ({ browser }) => {
    const store = new GithubStore({ owner: OWNER, repo: REPO, token: TOKEN })
    const head = await store.readHead()
    const current = await (await import("../../src/vault/crypto")).decryptVault(head.armored, passphrase)
    const before = await store.history(100)

    const context = await browser.newContext()
    const page = await seedDevice(context, { armored: head.armored, sha: head.sha })
    await unlock(page, current)

    await page.getByTestId("open-history").click()
    // Waits for ENTRIES, not for the container: the list element exists immediately and is
    // filled once GitHub answers, so asserting on the container counted zero rows every time.
    await expect(page.locator(".history-entry").first()).toBeVisible({ timeout: 120_000 })
    const count = await page.locator(".history-entry").count()
    expect(count).toBeGreaterThan(1)

    // The oldest version on the branch -- the empty vault the setup step created.
    await page.locator(".history-entry").nth(count - 1).click()
    await expect(page.getByTestId("restore-btn")).toBeVisible({ timeout: 180_000 })
    await page.getByTestId("restore-btn").click()
    await expect(page.getByTestId("editor")).toHaveValue("", { timeout: 180_000 })

    const after = await new GithubStore({ owner: OWNER, repo: REPO, token: TOKEN }).history(100)
    expect(after.length).toBe(before.length + 1)
    record(
      "§14.10",
      `restored the oldest version from history and got its exact contents back. It was written as a NEW commit: ` +
        `the branch went from ${before.length} to ${after.length} commits, so nothing was rewritten and the restore ` +
        `is itself undoable.`,
    )
    await context.close()
  })

  test("§14 result", async () => {
    appendFileSync(
      REPORT,
      `\n**Result: §14.4, §14.5, §14.6, §14.8, §14.9 and §14.10 all passed against real GitHub, a real browser ` +
        `running the production bundle, and the real age binary.** §14.3 and §14.7 are covered against the same ` +
        `production bundle in a real browser by the E2E suite (a live run of the wizard's token step needs a ` +
        `fine-grained PAT, which only a human can create). §14.1, §14.2 and §14.11 need a human with a Vercel ` +
        `account, a GitHub web session and the domain's DNS respectively.\n`,
    )
    expect(readFileSync(REPORT, "utf-8")).toContain("§14.6")
  })
})
