import { updateStateOf, updatePromptText } from "../../src/ui/update"

// Ruling R28: the prompt's trigger condition is a pure function, so it is testable against a
// plain object -- no test environment can produce a real waiting service worker on demand.

test("a build is only 'ready' once it is actually WAITING, never while installing", () => {
  // The distinction is the mitigation: downloading is always allowed, activating is not. A
  // prompt shown for a still-installing worker would offer to activate something that cannot
  // be activated yet.
  expect(updateStateOf({ waiting: {} })).toBe("ready")
  expect(updateStateOf({})).toBe("none")
  expect(updateStateOf(null)).toBe("none")
  expect(updateStateOf(undefined)).toBe("none")
})

test("the prompt states that the running code has NOT changed", () => {
  // The fact the whole mechanism exists to guarantee, and the one thing the user cannot
  // otherwise know. spec §10.1.
  expect(updatePromptText()).toMatch(/not running yet|still running the code/i)
})

test("the prompt does not pressure the user into clicking", () => {
  // An update prompt whose value is the deliberateness of the click must not manufacture
  // urgency, or it defeats itself.
  expect(updatePromptText()).not.toMatch(/urgent|immediately|security update|must|required|critical/i)
})
