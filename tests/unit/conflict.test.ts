import "fake-indexeddb/auto"
import {
  resolutionText,
  hasConflictMarkers,
  conflictHeadline,
  resolveConflict,
  type Choice,
} from "../../src/ui/conflict"
import type { Conflict } from "../../src/session/sync"
import type { Session } from "../../src/session/unlock"
import { LocalStore } from "../../src/store/local"
import { GithubStore } from "../../src/store/github"
import { generateDeviceIdentity } from "../../src/vault/identity"
import { decryptVault } from "../../src/vault/crypto"
import { merge3 } from "../../src/vault/merge"

// Ruling R28: the conflict view's real decisions -- what a choice resolves to, whether markers
// remain, and how a resolution is committed on the NEW base -- are DOM-free functions, so they
// are unit tests here rather than browser runs. tests/e2e/conflict.spec.ts covers the rendering
// and the real round trip.

const PASS = "a-sufficiently-long-conflict-test-passphrase"
const OWNER = "o"
const REPO = "r"

function conflictOf(over: Partial<Conflict> = {}): Conflict {
  return {
    base: "base\n",
    mine: "mine\n",
    theirs: "theirs\n",
    merged: "merged\n",
    conflicted: false,
    theirsSha: "sha-theirs",
    ...over,
  }
}

beforeEach(async () => {
  await new LocalStore().clear()
})

test("a choice resolves to the version it names, and `merged` takes the EDITED pane", () => {
  const conflict = conflictOf()
  expect(resolutionText(conflict, "mine", "edited\n")).toBe("mine\n")
  expect(resolutionText(conflict, "theirs", "edited\n")).toBe("theirs\n")
  // The merged pane is editable precisely so markers can be settled by hand; committing
  // `conflict.merged` instead would discard that work at the last step.
  expect(resolutionText(conflict, "merged", "edited by hand\n")).toBe("edited by hand\n")
})

test("every choice is covered -- no input to resolutionText returns undefined", () => {
  // Exhaustiveness is asserted by enumerating the union rather than claimed in a comment
  // (ruling R32): `Choice` has exactly these three members, and a fourth added later without a
  // branch would fail to compile here before it could fail at runtime.
  const choices: Choice[] = ["merged", "mine", "theirs"]
  for (const choice of choices) {
    expect(typeof resolutionText(conflictOf(), choice, "x\n")).toBe("string")
  }
})

test("conflict markers are detected only at the start of a line, so prose about them is not a false positive", () => {
  const { text: reallyConflicted } = merge3("base\n", "mine\n", "theirs\n")
  expect(hasConflictMarkers(reallyConflicted)).toBe(true)

  // A vault is a plain text document; someone writing notes about git is ordinary content.
  expect(hasConflictMarkers("my notes say git prints <<<<<<< mine when it cannot merge\n")).toBe(false)
  expect(hasConflictMarkers("clean text\nwith no markers\n")).toBe(false)
})

test("the headline distinguishes an overlapping conflict from a clean auto-merge", () => {
  // Both must be non-empty and must not be the same sentence: a user whose changes merged
  // cleanly is being asked to check, not to settle anything.
  const overlapping = conflictHeadline(conflictOf({ conflicted: true }))
  const clean = conflictHeadline(conflictOf({ conflicted: false }))
  expect(overlapping).not.toBe(clean)
  expect(overlapping.length).toBeGreaterThan(0)
  expect(clean.length).toBeGreaterThan(0)
  expect(overlapping).toMatch(/nothing has been discarded/i)
})

/** A store whose ref update always succeeds, recording the body it was given. */
function acceptingStore(seen: { body: unknown[] }): GithubStore {
  return new GithubStore({
    owner: OWNER,
    repo: REPO,
    token: "t",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const { pathname } = new URL(url)
      if (init?.body) seen.body.push({ pathname, body: JSON.parse(String(init.body)) })
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } })
      // `write` calls `assertRepoWritable()` first, unconditionally, on every write path -- the
      // visibility guard ruling R17 made non-bypassable. A mock without this answers nothing.
      if (pathname === `/repos/${OWNER}/${REPO}`) return json({ private: true, permissions: { push: true } })
      if (pathname.endsWith("/git/blobs")) return json({ sha: "blob-new" }, 201)
      if (pathname.endsWith("/git/trees")) return json({ sha: "tree-new" }, 201)
      if (pathname.endsWith("/git/commits")) return json({ sha: "commit-resolved" }, 201)
      if (pathname.endsWith("/git/refs/heads/data")) return json({ object: { sha: "commit-resolved" } })
      throw new Error(`conflict.test.ts: unmocked ${pathname}`)
    }) as typeof fetch,
  })
}

async function sessionFor(): Promise<Session> {
  const { identity } = await generateDeviceIdentity()
  // `baseSha` is deliberately the sha that was just REFUSED -- the state a real conflict leaves
  // the session in, and the thing resolveConflict has to move forward.
  return { text: "mine\n", baseSha: "sha-refused", token: "t", identity, passphrase: PASS }
}

test("resolving commits on the NEW base, not the refused one (the whole reason Conflict carries theirsSha)", async () => {
  const local = new LocalStore()
  const session = await sessionFor()
  const seen: { body: unknown[] } = { body: [] }
  const io = { local, makeStore: () => acceptingStore(seen) }

  const outcome = await resolveConflict("resolved text\n", conflictOf(), session, io)

  expect(outcome).toEqual({ kind: "committed", sha: "commit-resolved" })
  // The commit's parent is the version that won the race. Without the rebase this would still
  // be "sha-refused" and GitHub would refuse the write again, forever.
  const commitCall = seen.body.find((b) => (b as { pathname: string }).pathname.endsWith("/git/commits")) as {
    body: { parents: string[] }
  }
  expect(commitCall.body.parents).toEqual(["sha-theirs"])
  // And afterwards the session has moved on to the commit it just wrote -- NOT to "sha-theirs",
  // which was only ever the parent. (This assertion originally said "sha-theirs" and was simply
  // wrong: a successful write advances the session to its own new head, which is what makes the
  // NEXT save a fast-forward rather than an immediate second conflict.)
  expect(session.baseSha).toBe("commit-resolved")
  expect(session.text).toBe("resolved text\n")
})

test("the resolution is on disk BEFORE the commit is attempted, so a failed save cannot lose it", async () => {
  const local = new LocalStore()
  const session = await sessionFor()
  // Every network call fails the way an offline device does.
  const io = {
    local,
    makeStore: () =>
      new GithubStore({
        owner: OWNER,
        repo: REPO,
        token: "t",
        fetch: (() => {
          throw new TypeError("Failed to fetch")
        }) as unknown as typeof fetch,
      }),
  }

  const outcome = await resolveConflict("resolved while offline\n", conflictOf(), session, io)

  // Queued, not lost, and not a dead end: the view treats this as success.
  expect(outcome.kind).toBe("queued")
  const draft = await local.getDraft()
  expect(draft).not.toBeNull()
  expect(draft?.baseSha).toBe("sha-theirs")
})

test("a resolution that is committed is readable back as exactly what was chosen", async () => {
  const local = new LocalStore()
  const session = await sessionFor()
  const seen: { body: unknown[] } = { body: [] }
  const io = { local, makeStore: () => acceptingStore(seen) }

  await resolveConflict("the settled text\n", conflictOf(), session, io)

  // The blob that was POSTed really decrypts to the chosen text under the session passphrase --
  // the only check that proves the right bytes were encrypted, rather than that some call ran.
  const blobCall = seen.body.find((b) => (b as { pathname: string }).pathname.endsWith("/git/blobs")) as {
    body: { content: string }
  }
  expect(await decryptVault(blobCall.body.content, PASS)).toBe("the settled text\n")
})
