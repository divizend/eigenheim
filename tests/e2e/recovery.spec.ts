// E2E: recovery affordances (spec §13, "No state may dead-end").
//
// The division of labour here is deliberate, and the first attempt at this file got it wrong in
// an instructive way. Per-class coverage -- "every class in ALL_ERROR_CLASSES yields at least
// one action" -- lives in tests/unit/errors-view.test.ts, because `affordancesFor` is a pure
// function and the property is far better expressed over the real array than as one browser run
// per class. The first version of this file instead tried to `import("/src/ui/errors.ts")`
// inside the page to render each class in the browser; that cannot work against what this suite
// actually runs, `vite preview`, which serves a BUILT bundle and has no `/src` to import. It
// also would not have been testing anything the unit test does not already prove.
//
// What is left here is what a unit test structurally cannot reach: that the top-level boundary
// catches a failure occurring BEFORE any view has rendered, and that the resulting screen is a
// real one with working controls rather than a blank page.
import { test, expect } from "@playwright/test"
import { DB_NAME } from "../../src/store/local"

const OWNER = "test-owner"
const REPO = "test-repo"

/** Makes `indexedDB.open` throw, the way Safari private browsing historically did. This is the
 * most realistic failure that happens before anything renders: `main()` reads
 * `getWrappedIdentity()` as its very first act, so the app cannot even decide which view to
 * show. */
async function breakIndexedDb(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    indexedDB.open = (() => {
      throw new DOMException("this browser refused to open IndexedDB", "SecurityError")
    }) as typeof indexedDB.open
  })
}

test.describe("recovery affordances", () => {
  test("a startup failure renders the failure view instead of a blank page", async ({ page }) => {
    await breakIndexedDb(page)
    await page.goto("/")

    // The one outcome this project cannot ship is a blank page: a user looking at nothing has no
    // way to know their vault is intact, let alone that it is readable without this app at all.
    await expect(page.getByTestId("failure-actions")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("failure-message")).toContainText(/refused|went wrong/i)
  })

  test("the startup failure view offers the three generic actions, as real controls", async ({ page }) => {
    await breakIndexedDb(page)
    await page.goto("/")
    await expect(page.getByTestId("failure-actions")).toBeVisible({ timeout: 30_000 })

    // download / history / retry are the generic set that makes the no-dead-end guarantee true
    // for an error nobody anticipated -- which is exactly what this one is.
    for (const id of ["download", "history", "retry"]) {
      await expect(page.locator(`[data-action="${id}"]`)).toBeVisible()
    }
  })

  test("the view states the escape hatch that does not depend on this app at all", async ({ page }) => {
    await breakIndexedDb(page)
    await page.goto("/")
    await expect(page.locator(".failure-footnote")).toBeVisible({ timeout: 30_000 })

    // Whatever is broken in the app, the vault is still an ordinary age file. Saying so is the
    // difference between a frightening screen and an inconvenient one.
    await expect(page.locator(".failure-footnote")).toContainText("age -d")
    await expect(page.locator(".failure-footnote")).toContainText("vault.age")
  })

  test("the download action is never inert, even with no ciphertext in hand", async ({ page }) => {
    await breakIndexedDb(page)
    await page.goto("/")
    await expect(page.getByTestId("failure-actions")).toBeVisible({ timeout: 30_000 })

    // With no armored text available -- which is precisely the case when the failure happened
    // before anything loaded -- download falls back to opening the file on GitHub. A generic
    // action that silently did nothing would make the guarantee a lie.
    const popupPromise = page.waitForEvent("popup")
    await page.locator('[data-action="download"]').click()
    const popup = await popupPromise
    expect(popup.url()).toBe(`https://github.com/${OWNER}/${REPO}/blob/data/vault.age`)
    await popup.close()
  })

  test("a working view is never replaced by a late rejection", async ({ page }) => {
    // The boundary must not be overeager: a rejection raised while the user is looking at their
    // own text must leave that text on screen, because the view they are in IS their way
    // forward. Only an empty root gets replaced.
    await page.goto("/")
    await expect(page.getByRole("checkbox")).toBeVisible({ timeout: 30_000 })

    await page.evaluate(() => {
      window.dispatchEvent(
        new PromiseRejectionEvent("unhandledrejection", {
          promise: Promise.reject(new Error("a late failure")),
          reason: new Error("a late failure"),
          cancelable: true,
        }),
      )
    })

    await expect(page.getByRole("checkbox")).toBeVisible()
    await expect(page.getByTestId("failure-actions")).toHaveCount(0)
  })

  test("DB_NAME is the database the app really opens", async ({ page }) => {
    // Guards the seeding every other E2E file depends on: if this constant and the real database
    // ever diverged, those files would silently seed a database nobody reads, and their setup
    // failures would look like app bugs.
    await page.goto("/")
    await expect(page.getByRole("checkbox")).toBeVisible({ timeout: 30_000 })
    const names = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
    expect(names).toContain(DB_NAME)
  })
})
