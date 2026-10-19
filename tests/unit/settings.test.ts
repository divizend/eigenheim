import "fake-indexeddb/auto"
import {
  transferPayload,
  replaceToken,
  changePassphrase,
  measureRunningBundle,
  parseBuildHashFile,
  compareBuildHash,
} from "../../src/ui/settings"
import type { Session } from "../../src/session/unlock"
import { LocalStore } from "../../src/store/local"
import { GithubStore } from "../../src/store/github"
import { generateDeviceIdentity } from "../../src/vault/identity"
import { decryptVault, encryptVault } from "../../src/vault/crypto"
import { unwrapIdentity } from "../../src/vault/identity"
import { repoOwner, repoSlug, BUILD_COMMIT } from "../../src/config"

// Ruling R28: settings' decisions are DOM-free, so they are unit tests here.

const PASS = "a-sufficiently-long-settings-test-passphrase"
const NEXT_PASS = "an-entirely-different-long-passphrase-here"
const OWNER = repoOwner()
const REPO = repoSlug()

beforeEach(async () => {
  await new LocalStore().clear()
})

async function sessionFor(text = "the current text\n"): Promise<Session> {
  const { identity } = await generateDeviceIdentity()
  return { text, baseSha: "sha-current", token: "gh-token", identity, passphrase: PASS }
}

test("the transfer payload carries the repo and token -- and never the passphrase", async () => {
  const payload = JSON.parse(transferPayload("gh-token")) as Record<string, unknown>
  expect(payload).toEqual({ owner: OWNER, repo: REPO, token: "gh-token" })
  // The one secret this project never transmits. Asserted over the whole serialised string, not
  // just the parsed keys, so a future field that happens to embed it would still fail.
  expect(transferPayload("gh-token")).not.toContain(PASS)
})

/** A store whose `ensureSetup` outcome is whatever the caller wants. */
function storeWith(opts: { ok: boolean }): (token: string) => GithubStore {
  return (token: string) =>
    new GithubStore({
      owner: OWNER,
      repo: REPO,
      token,
      fetch: (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const { pathname } = new URL(url)
        const json = (b: unknown, status = 200) =>
          new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } })
        if (pathname === `/repos/${OWNER}/${REPO}`) {
          return opts.ok ? json({ private: true, permissions: { push: true } }) : json({ message: "Bad credentials" }, 401)
        }
        if (pathname.endsWith("/git/ref/heads/data")) return json({ object: { sha: "sha-current" } })
        throw new Error(`settings.test.ts: unmocked ${pathname}`)
      }) as typeof fetch,
    })
}

test("a replacement token is validated BEFORE it is stored", async () => {
  // The point of validating first: storing an unchecked token would replace a working credential
  // with a broken one and only reveal it at the next save. So a rejected token must leave the
  // store untouched -- asserted by the stored-callback never being called at all.
  let stored: string | null = null
  const outcome = await replaceToken("bad-token", storeWith({ ok: false }), async (t) => {
    stored = t
  })
  expect(outcome.kind).toBe("rejected")
  expect(stored).toBeNull()
})

test("a valid replacement token is stored", async () => {
  let stored: string | null = null
  const outcome = await replaceToken("  good-token  ", storeWith({ ok: true }), async (t) => {
    stored = t
  })
  expect(outcome).toEqual({ kind: "stored" })
  // Trimmed, like every other token entry point in this app -- a pasted token picks up
  // whitespace constantly.
  expect(stored).toBe("good-token")
})

test("an empty token is refused without a network call", async () => {
  const outcome = await replaceToken("   ", () => {
    throw new Error("must not build a store for an empty token")
  }, async () => {})
  expect(outcome.kind).toBe("rejected")
})

/** A store that accepts the rotation commit and records what was written. */
function acceptingStore(seen: { bodies: Array<{ pathname: string; body: Record<string, unknown> }> }) {
  return () =>
    new GithubStore({
      owner: OWNER,
      repo: REPO,
      token: "gh-token",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const { pathname } = new URL(url)
        if (init?.body) seen.bodies.push({ pathname, body: JSON.parse(String(init.body)) })
        const json = (b: unknown, status = 200) =>
          new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } })
        if (pathname === `/repos/${OWNER}/${REPO}`) return json({ private: true, permissions: { push: true } })
        if (pathname.endsWith("/git/blobs")) return json({ sha: "blob-new" }, 201)
        if (pathname.endsWith("/git/trees")) return json({ sha: "tree-new" }, 201)
        if (pathname.endsWith("/git/commits")) return json({ sha: "commit-rotated" }, 201)
        if (pathname.endsWith("/git/refs/heads/data")) return json({ object: { sha: "commit-rotated" } })
        throw new Error(`settings.test.ts: unmocked ${pathname}`)
      }) as typeof fetch,
    })
}

test("changing the passphrase re-encrypts the vault, re-wraps the identity, and commits", async () => {
  const local = new LocalStore()
  const session = await sessionFor("secret contents\n")
  const seen = { bodies: [] as Array<{ pathname: string; body: Record<string, unknown> }> }

  const outcome = await changePassphrase(NEXT_PASS, session, { local, makeStore: acceptingStore(seen) }, "secret contents\n")
  expect(outcome).toEqual({ kind: "changed" })

  // The committed blob really opens under the NEW passphrase, and not under the old one.
  const blob = seen.bodies.find((b) => b.pathname.endsWith("/git/blobs"))
  const armored = String((blob?.body as { content: string }).content)
  expect(await decryptVault(armored, NEXT_PASS)).toBe("secret contents\n")
  await expect(decryptVault(armored, PASS)).rejects.toThrow()

  // And the stored device identity is re-wrapped under the new passphrase -- the half that, if
  // missed, would leave this device able to read its vault but never its token.
  const wrapped = await local.getWrappedIdentity()
  expect(wrapped).not.toBeNull()
  expect(await unwrapIdentity(wrapped as string, NEXT_PASS)).toBe(session.identity)

  expect(session.passphrase).toBe(NEXT_PASS)
  expect(session.baseSha).toBe("commit-rotated")
})

test("both passphrase-protected slots move together, so no state has them disagreeing", async () => {
  const local = new LocalStore()
  const session = await sessionFor("contents\n")
  const seen = { bodies: [] as Array<{ pathname: string; body: Record<string, unknown> }> }

  await changePassphrase(NEXT_PASS, session, { local, makeStore: acceptingStore(seen) }, "contents\n")

  // `device.age` and `vault.age` are the only two things on this device encrypted under the
  // PASSPHRASE. If a rotation updated one and not the other, no single passphrase would open
  // both and recovering the token would need the passphrase that no longer opens it -- a
  // circular dead end in a project with no recovery key. One transaction, so both or neither.
  const cached = await local.getCachedVault()
  const wrapped = await local.getWrappedIdentity()
  expect(await decryptVault(cached?.armored as string, NEXT_PASS)).toBe("contents\n")
  expect(await unwrapIdentity(wrapped as string, NEXT_PASS)).toBe(session.identity)
  expect(cached?.sha).toBe("commit-rotated")
})

test("a weak new passphrase is refused before anything is encrypted or committed", async () => {
  const local = new LocalStore()
  const session = await sessionFor()
  const outcome = await changePassphrase("short", session, {
    local,
    makeStore: () => {
      throw new Error("must not touch GitHub for a passphrase that fails the floor")
    },
  }, "x\n")
  expect(outcome.kind).toBe("rejected")
  expect(session.passphrase).toBe(PASS)
})

test("if the commit fails, NOTHING changes -- the old passphrase still works everywhere", async () => {
  // The ordering guarantee: the irreversible step (the commit) happens before any local write,
  // so a failure there leaves a completely untouched device rather than a half-rotated one.
  const local = new LocalStore()
  await local.putWrappedIdentity(await encryptVault("placeholder", PASS))
  const before = await local.getWrappedIdentity()
  const session = await sessionFor()

  const outcome = await changePassphrase(NEXT_PASS, session, {
    local,
    makeStore: () =>
      new GithubStore({
        owner: OWNER,
        repo: REPO,
        token: "gh-token",
        fetch: (() => {
          throw new TypeError("Failed to fetch")
        }) as unknown as typeof fetch,
      }),
  }, "x\n")

  expect(outcome.kind).toBe("failed")
  if (outcome.kind !== "failed") throw new Error("unreachable: asserted above")
  expect(outcome.message).toMatch(/old passphrase still works/i)
  expect(await local.getWrappedIdentity()).toBe(before)
  expect(await local.getCachedVault()).toBeNull()
  expect(session.passphrase).toBe(PASS)
})

test("a device with no token refuses to rotate, rather than locally diverging from GitHub", async () => {
  const local = new LocalStore()
  const session = { ...(await sessionFor()), token: null }
  const outcome = await changePassphrase(NEXT_PASS, session, {
    local,
    makeStore: () => {
      throw new Error("must not build a store without a token")
    },
  }, "x\n")
  expect(outcome.kind).toBe("failed")
  expect(session.passphrase).toBe(PASS)
})

test("the running bundle is hashed from the bytes actually served", async () => {
  // Ruling R2: a bundle cannot contain the SHA-256 of itself, so the displayed value is
  // measured at runtime from the running file. Checked against a hash computed independently
  // here rather than against a constant copied from the implementation.
  const body = "console.log('pretend bundle')\n"
  const fetchImpl = (async () => new Response(body)) as unknown as typeof fetch
  const measured = await measureRunningBundle("https://example.test/app.js", fetchImpl)

  const expected = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  expect(measured).toBe(expected)
})

test("the published hash file is parsed strictly, and anything else reads as unparseable", () => {
  const sha = "a".repeat(64)
  expect(parseBuildHashFile(`abc1234 ${sha}\n`)).toEqual({ commit: "abc1234", sha256: sha })
  // Strict rather than best-effort: a malformed file must read as "cannot verify" rather than
  // being coerced into a comparison that then reports a mismatch.
  expect(parseBuildHashFile("")).toBeNull()
  expect(parseBuildHashFile("not a hash at all")).toBeNull()
  expect(parseBuildHashFile(`abc1234 ${"a".repeat(63)}`)).toBeNull()
})

test("a dev build says it cannot be verified rather than crying wolf", () => {
  // This suite runs against BUILD_COMMIT === "dev" (vite.config.ts's own fallback), which is
  // exactly the case that must NOT render as a mismatch.
  expect(BUILD_COMMIT).toBe("dev")
  const verdict = compareBuildHash("a".repeat(64), `abc1234 ${"b".repeat(64)}\n`)
  expect(verdict.kind).toBe("unverifiable")
})

test("unverifiable and mismatch are distinct outcomes, never collapsed", () => {
  // Not being able to check is not the same as having checked and found a difference.
  // Collapsing them would either cry wolf on every dev build or hide a real mismatch.
  const kinds = new Set([
    compareBuildHash(null, null).kind,
    compareBuildHash("a".repeat(64), null).kind,
    compareBuildHash("a".repeat(64), "garbage").kind,
  ])
  expect(kinds).toEqual(new Set(["unverifiable"]))
})
