import "fake-indexeddb/auto"
import { diffLines, isUnchanged, loadVersion, restoreVersion, formatDate, HISTORY_PAGE } from "../../src/ui/history"
import type { Session } from "../../src/session/unlock"
import { LocalStore } from "../../src/store/local"
import { GithubStore } from "../../src/store/github"
import { generateDeviceIdentity } from "../../src/vault/identity"
import { encryptVault, decryptVault } from "../../src/vault/crypto"

// Ruling R28: the history view's decisions are DOM-free, so they are unit tests here.
// tests/e2e/history.spec.ts covers the rendering and the real restore round trip.

const PASS = "a-sufficiently-long-history-test-passphrase"
const OTHER_PASS = "a-different-long-passphrase-from-before-rotation"
const OWNER = "o"
const REPO = "r"

beforeEach(async () => {
  await new LocalStore().clear()
})

async function sessionFor(text: string): Promise<Session> {
  const { identity } = await generateDeviceIdentity()
  return { text, baseSha: "sha-current", token: "t", identity, passphrase: PASS }
}

test("a diff marks only what changed, and leaves everything else as context", () => {
  const diff = diffLines("one\ntwo\nthree\n", "one\nTWO\nthree\n")
  expect(diff.filter((l) => l.kind === "removed").map((l) => l.text)).toEqual(["two\n"])
  expect(diff.filter((l) => l.kind === "added").map((l) => l.text)).toEqual(["TWO\n"])
  expect(diff.filter((l) => l.kind === "same").map((l) => l.text)).toEqual(["one\n", "three\n"])
})

test("a CRLF document does not diff as every line changed", () => {
  // The reason `splitLines` is shared with src/vault/merge.ts rather than re-split here: a split
  // that drops each line's own terminator makes every CRLF line differ from its CRLF twin, and
  // the whole diff becomes noise. Identical CRLF documents must produce NO changes at all.
  const crlf = "alpha\r\nbeta\r\ngamma\r\n"
  expect(isUnchanged(diffLines(crlf, crlf))).toBe(true)

  // And a real one-line change in a CRLF document is still exactly one change.
  const changed = "alpha\r\nBETA\r\ngamma\r\n"
  const diff = diffLines(crlf, changed)
  expect(diff.filter((l) => l.kind !== "same")).toHaveLength(2)
})

test("an identical version is reported as unchanged rather than rendered as a diff", () => {
  expect(isUnchanged(diffLines("same\n", "same\n"))).toBe(true)
  expect(isUnchanged(diffLines("same\n", "different\n"))).toBe(false)
})

test("an empty document against a non-empty version is all additions, with nothing lost", () => {
  const diff = diffLines("", "added line\n")
  expect(diff.filter((l) => l.kind === "added").map((l) => l.text)).toEqual(["added line\n"])
})

/** A store serving one armored blob at one commit sha. */
function storeServing(armored: string, opts: { readFails?: boolean } = {}): GithubStore {
  return new GithubStore({
    owner: OWNER,
    repo: REPO,
    token: "t",
    fetch: (async (input: RequestInfo | URL) => {
      if (opts.readFails) throw new Error("GitHub said no")
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const { pathname } = new URL(url)
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } })
      if (pathname.includes("/git/commits/")) return json({ sha: "sha-old", tree: { sha: "tree-old" } })
      if (pathname.includes("/git/trees/")) {
        return json({ tree: [{ path: "vault.age", type: "blob", sha: "blob-old", size: armored.length }] })
      }
      if (pathname.includes("/git/blobs/")) {
        return json({ content: Buffer.from(armored, "utf-8").toString("base64"), encoding: "base64" })
      }
      throw new Error(`history.test.ts: unmocked ${pathname}`)
    }) as typeof fetch,
  })
}

test("loading a version decrypts it under the session passphrase", async () => {
  const session = await sessionFor("current\n")
  const load = await loadVersion("sha-old", session, storeServing(await encryptVault("older version\n", PASS)))
  expect(load).toEqual({ kind: "text", text: "older version\n" })
})

test("a version encrypted under an OLD passphrase is reported, not thrown -- and names the escape hatch", async () => {
  // spec §13: a version that will not decrypt must be reported without blanking the view. This
  // is a realistic state in a long history once task 17's passphrase rotation exists, not a
  // corrupt-file edge case, so the message says which versions ARE affected and what still works.
  const session = await sessionFor("current\n")
  const load = await loadVersion("sha-old", session, storeServing(await encryptVault("ancient\n", OTHER_PASS)))

  expect(load.kind).toBe("undecryptable")
  if (load.kind !== "undecryptable") throw new Error("unreachable: asserted above")
  expect(load.message).toMatch(/passphrase change/i)
  expect(load.message).toMatch(/age -d/)
})

test("a version that cannot even be fetched is also reported rather than thrown", async () => {
  const session = await sessionFor("current\n")
  const load = await loadVersion("sha-old", session, storeServing("", { readFails: true }))
  expect(load.kind).toBe("undecryptable")
  if (load.kind !== "undecryptable") throw new Error("unreachable: asserted above")
  expect(load.message.length).toBeGreaterThan(0)
})

test("restoring writes a NEW forward commit and never asks to rewrite history", async () => {
  const local = new LocalStore()
  const session = await sessionFor("current\n")
  const bodies: Array<{ pathname: string; method: string; body: Record<string, unknown> }> = []

  const io = {
    local,
    makeStore: () =>
      new GithubStore({
        owner: OWNER,
        repo: REPO,
        token: "t",
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
          const { pathname } = new URL(url)
          if (init?.body) {
            bodies.push({ pathname, method: init.method ?? "GET", body: JSON.parse(String(init.body)) })
          }
          const json = (b: unknown, status = 200) =>
            new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } })
          if (pathname === `/repos/${OWNER}/${REPO}`) return json({ private: true, permissions: { push: true } })
          if (pathname.endsWith("/git/blobs")) return json({ sha: "blob-new" }, 201)
          if (pathname.endsWith("/git/trees")) return json({ sha: "tree-new" }, 201)
          if (pathname.endsWith("/git/commits")) return json({ sha: "commit-restored" }, 201)
          if (pathname.endsWith("/git/refs/heads/data")) return json({ object: { sha: "commit-restored" } })
          throw new Error(`history.test.ts: unmocked ${pathname}`)
        }) as typeof fetch,
      }),
  }

  const outcome = await restoreVersion("the older text\n", session, io)
  expect(outcome).toEqual({ kind: "committed", sha: "commit-restored" })

  // spec §6.6: a restore is an ordinary forward commit. Its parent is the CURRENT head, so the
  // version it replaced stays reachable directly above it -- which is what makes a restore
  // itself undoable.
  const commitPost = bodies.find((b) => b.pathname.endsWith("/git/commits"))
  expect((commitPost?.body as { parents: string[] }).parents).toEqual(["sha-current"])

  // Nothing anywhere in the flow asked to force. The no-silent-data-loss guarantee is exactly
  // this being absent, so it is asserted over EVERY recorded body, not just the ref update.
  for (const { body } of bodies) expect(body.force).not.toBe(true)

  // And the bytes committed really are the restored version.
  const blobPost = bodies.find((b) => b.pathname.endsWith("/git/blobs"))
  expect(await decryptVault(String((blobPost?.body as { content: string }).content), PASS)).toBe("the older text\n")
  expect(session.text).toBe("the older text\n")
})

test("dates render identically everywhere, and an unparseable date is shown rather than swallowed", () => {
  // Fixed locale and timezone: a log that reads differently per machine is harder to reason
  // about, and makes a test's expected value depend on where it runs.
  expect(formatDate("2026-10-19T12:34:00Z")).toBe("19 Oct 2026, 12:34 UTC")
  expect(formatDate("not a date")).toBe("not a date")
})

test("the page size is a real number the view can ask for", () => {
  expect(HISTORY_PAGE).toBeGreaterThan(0)
})
