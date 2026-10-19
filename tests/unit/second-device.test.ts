import "fake-indexeddb/auto"
import { parseTransferPayload, barcodeScanningAvailable, adoptExistingVault } from "../../src/ui/setup"
import { transferPayload } from "../../src/ui/settings"
import { LocalStore } from "../../src/store/local"
import { GithubStore } from "../../src/store/github"
import { generateDeviceIdentity, unwrapIdentity } from "../../src/vault/identity"
import { encryptVault, decryptWithIdentity } from "../../src/vault/crypto"
import { repoOwner, repoSlug } from "../../src/config"

// Ruling R28: task 18's decisions are DOM-free, so they are unit tests here.

const PASS = "a-sufficiently-long-second-device-passphrase"
const TEXT = "already in the vault\n"
const HEAD_SHA = "commit-existing"

beforeEach(async () => {
  await new LocalStore().clear()
})

test("a code produced by Settings is parsed by the receiving side -- the two halves agree", async () => {
  // The producing side is src/ui/settings.ts and the consuming side is src/ui/setup.ts. Rather
  // than asserting each against a hand-written literal (which can agree with neither), this
  // feeds one into the other.
  const parsed = parseTransferPayload(transferPayload("gh-token"))
  expect(parsed).toEqual({ kind: "ok", payload: { owner: repoOwner(), repo: repoSlug(), token: "gh-token" } })
})

test("every malformed code is rejected with a message naming what is actually wrong", () => {
  // spec §13 wants a way forward, and "invalid" is not one -- each of these has a different fix.
  const empty = parseTransferPayload("   ")
  expect(empty.kind).toBe("invalid")

  const notJson = parseTransferPayload("just some words")
  expect(notJson.kind).toBe("invalid")
  if (notJson.kind !== "invalid") throw new Error("unreachable")
  expect(notJson.message).toMatch(/starts with \{/)

  const incomplete = parseTransferPayload(JSON.stringify({ owner: repoOwner(), repo: repoSlug() }))
  expect(incomplete.kind).toBe("invalid")
  if (incomplete.kind !== "invalid") throw new Error("unreachable")
  expect(incomplete.message).toMatch(/incomplete/i)

  // A code from a DIFFERENT deployment is the subtlest failure: it is a perfectly valid code,
  // just not for this repo, and pasting it would otherwise store a token that cannot work.
  const wrongRepo = parseTransferPayload(JSON.stringify({ owner: "someone", repo: "else", token: "t" }))
  expect(wrongRepo.kind).toBe("invalid")
  if (wrongRepo.kind !== "invalid") throw new Error("unreachable")
  expect(wrongRepo.message).toContain("someone/else")
  expect(wrongRepo.message).toContain(`${repoOwner()}/${repoSlug()}`)
})

test("a null prototype or array payload is rejected rather than coerced", () => {
  expect(parseTransferPayload("null").kind).toBe("invalid")
  expect(parseTransferPayload("[1,2,3]").kind).toBe("invalid")
  expect(parseTransferPayload("42").kind).toBe("invalid")
})

test("scanning is reported unavailable when BarcodeDetector is absent, which is the test env", () => {
  // Node has no BarcodeDetector, so this asserts the real branch rather than a stubbed one --
  // and it is the branch that matters, because Firefox and Safari behave the same way. Nothing
  // in onboarding may depend on the answer being true.
  expect(typeof (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector).toBe("undefined")
  expect(barcodeScanningAvailable()).toBe(false)
})

/** A store serving one existing vault at HEAD. */
function storeServing(armored: string): GithubStore {
  return new GithubStore({
    owner: repoOwner(),
    repo: repoSlug(),
    token: "gh-token",
    fetch: (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const { pathname } = new URL(url)
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } })
      if (pathname.endsWith("/git/ref/heads/data")) return json({ object: { sha: HEAD_SHA } })
      if (pathname.includes("/git/commits/")) return json({ sha: HEAD_SHA, tree: { sha: "tree-head" } })
      if (pathname.includes("/git/trees/")) {
        return json({ tree: [{ path: "vault.age", type: "blob", sha: "blob-head", size: armored.length }] })
      }
      if (pathname.includes("/git/blobs/")) {
        return json({ content: Buffer.from(armored, "utf-8").toString("base64"), encoding: "base64" })
      }
      throw new Error(`second-device.test.ts: unmocked ${pathname}`)
    }) as typeof fetch,
  })
}

test("after transfer, the second device decrypts the existing vault and stores its own slots", async () => {
  const local = new LocalStore()
  const outcome = await adoptExistingVault(
    PASS,
    { token: "gh-token", store: storeServing(await encryptVault(TEXT, PASS)), identityPromise: generateDeviceIdentity() },
    local,
  )

  expect(outcome.kind).toBe("joined")
  if (outcome.kind !== "joined") throw new Error("unreachable: asserted above")
  expect(outcome.session.text).toBe(TEXT)
  expect(outcome.session.baseSha).toBe(HEAD_SHA)

  // This device now has its OWN identity, wrapped under the shared passphrase -- it does not
  // import the first device's identity, which is why a transfer carries no private key.
  const wrapped = await local.getWrappedIdentity()
  expect(await unwrapIdentity(wrapped as string, PASS)).toBe(outcome.session.identity)
  // And its own token copy, encrypted to that identity.
  const token = await local.getToken()
  expect(await decryptWithIdentity(token as string, outcome.session.identity)).toBe("gh-token")
})

test("a wrong passphrase is its own outcome and stores NOTHING", async () => {
  const local = new LocalStore()
  const outcome = await adoptExistingVault(
    "a-wrong-but-sufficiently-long-passphrase",
    { token: "gh-token", store: storeServing(await encryptVault(TEXT, PASS)), identityPromise: generateDeviceIdentity() },
    local,
  )
  expect(outcome).toEqual({ kind: "wrong-passphrase" })
  // Nothing partial left behind: src/main.ts routes on `wrappedIdentity !== null`, so a failed
  // join must not make this device look set up (ruling R27's property, same gate).
  expect(await local.getWrappedIdentity()).toBeNull()
  expect(await local.getToken()).toBeNull()
})

test("the routing gate is written LAST, so a failure mid-join re-enters the wizard cleanly", async () => {
  // Same property ruling R27 established for finishSetup, asserted here for the join path too.
  class FailsOnCachedVault extends LocalStore {
    override async putCachedVault(): Promise<void> {
      throw new Error("simulated: storage failed")
    }
  }
  const local = new FailsOnCachedVault()
  await expect(
    adoptExistingVault(
      PASS,
      { token: "gh-token", store: storeServing(await encryptVault(TEXT, PASS)), identityPromise: generateDeviceIdentity() },
      local,
    ),
  ).rejects.toThrow("simulated: storage failed")
  expect(await local.getWrappedIdentity()).toBeNull()
})

test("an unreachable repo is reported, never thrown at the user as a blank screen", async () => {
  const local = new LocalStore()
  const store = new GithubStore({
    owner: repoOwner(),
    repo: repoSlug(),
    token: "gh-token",
    fetch: (() => {
      throw new TypeError("Failed to fetch")
    }) as unknown as typeof fetch,
  })
  const outcome = await adoptExistingVault(PASS, { token: "gh-token", store, identityPromise: generateDeviceIdentity() }, local)
  expect(outcome.kind).toBe("failed")
  if (outcome.kind !== "failed") throw new Error("unreachable")
  expect(outcome.message.length).toBeGreaterThan(0)
})
