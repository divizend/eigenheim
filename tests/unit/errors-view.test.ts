import { affordancesFor, genericAffordances } from "../../src/ui/errors"
import { ALL_ERROR_CLASSES } from "../../src/store/errors"

// Spec §13's central guarantee -- "No state may dead-end" -- as a property over the whole set of
// error classes, not a list of hand-picked examples. Ruling R28 is why this is a unit test: the
// plan put it in Playwright, which would mean one ~1s browser run per class to assert something
// that is a pure function of the error.

test("EVERY error class produces at least one action and a non-empty message", () => {
  // The exhaustive one. `ALL_ERROR_CLASSES` is itself pinned as a complete set by
  // tests/unit/github-read.test.ts, so a class that exists but is not enumerated there fails
  // THAT test -- the two together are what make this coverage real rather than nominal.
  expect(ALL_ERROR_CLASSES.length).toBeGreaterThan(0)
  for (const ErrorClass of ALL_ERROR_CLASSES) {
    const { message, actions } = affordancesFor(new ErrorClass())
    expect(message.trim().length, `${ErrorClass.name} has an empty message`).toBeGreaterThan(0)
    expect(actions.length, `${ErrorClass.name} offers no way forward`).toBeGreaterThan(0)
  }
})

test("an error class nobody anticipated still gets the generic actions, never a blank screen", () => {
  // The `default` arm is the guarantee, not a fallback nobody thought about: an error invented
  // later, by someone who never reads src/ui/errors.ts, must still produce a way forward.
  class SomeFutureError extends Error {}
  const { message, actions } = affordancesFor(new SomeFutureError("a thing that has not happened yet"))
  expect(message).toContain("a thing that has not happened yet")
  expect(actions.map((a) => a.id)).toEqual(genericAffordances().map((a) => a.id))
})

test("a thrown non-Error is handled too", () => {
  const { message, actions } = affordancesFor("just a string")
  expect(message).toContain("just a string")
  expect(actions.length).toBeGreaterThan(0)
})

test("the three generic actions are present for every single class, not just most of them", () => {
  // spec §13's undecryptable row needs download + history + retry specifically, and the
  // simplest way to guarantee it for that row is to guarantee it for all of them.
  const genericIds = genericAffordances().map((a) => a.id)
  for (const ErrorClass of ALL_ERROR_CLASSES) {
    const ids = affordancesFor(new ErrorClass()).actions.map((a) => a.id)
    for (const id of genericIds) {
      expect(ids, `${ErrorClass.name} is missing the generic "${id}" action`).toContain(id)
    }
  }
})

test("each spec §13 row gets its own specific affordance on top of the generic ones", async () => {
  const { TokenError, RepoPublicError, BranchMissingError, StaleWriteError, AlreadyInitializedError } = await import(
    "../../src/store/errors"
  )

  // Invalid/expired token -> "a direct link to create a replacement".
  const token = affordancesFor(new TokenError())
  expect(token.actions.find((a) => a.id === "create-token")?.href).toBe(
    "https://github.com/settings/personal-access-tokens/new",
  )

  // Repo is public -> "a direct link to the repo's settings".
  const pub = affordancesFor(new RepoPublicError())
  expect(pub.actions.find((a) => a.id === "repo-settings")?.href).toMatch(/github\.com\/.+\/settings$/)

  // data branch missing -> "Offer to create it, inline".
  expect(affordancesFor(new BranchMissingError()).actions.map((a) => a.id)).toContain("create-branch")

  // Stale write -> routed to the conflict view by reopening.
  expect(affordancesFor(new StaleWriteError()).actions.map((a) => a.id)).toContain("reload")

  // Ruling R18: AlreadyInitializedError had no affordance at all. Reloading IS the fix, because
  // a reload now finds the existing vault and joins it (task 18) instead of creating a second.
  const already = affordancesFor(new AlreadyInitializedError())
  expect(already.actions.map((a) => a.id)).toContain("reload")
  expect(already.message).toMatch(/join the existing vault|already has a vault/i)
})

test("no message ever tells the user that nothing can be done", () => {
  // A way forward is not just a button -- the words must not contradict it. Each of these
  // phrases would make an affordance beside it read as decoration.
  for (const ErrorClass of ALL_ERROR_CLASSES) {
    const { message } = affordancesFor(new ErrorClass())
    expect(message).not.toMatch(/nothing (you |we )?can be done|unrecoverable|permanently lost/i)
  }
})
