import { GithubStore } from "../../src/store/github"
import { TokenError, RepoPublicError } from "../../src/store/errors"
import { VAULT_PATH, DATA_BRANCH } from "../../src/config"

const baseOpts = { owner: "o", repo: "r", token: "test-token" }

function repoPath(suffix: string): string {
  return `/repos/${baseOpts.owner}/${baseOpts.repo}${suffix}`
}

// A minimal, fake-but-well-formed armored age file -- this suite is about the GitHub transport
// layer (what gets sent where), not vault crypto, so it deliberately does not reuse
// github-read.test.ts's full real fixture. Mirrors github-write.test.ts's own `writeOpts.armored`
// for the same reason.
const ARMORED_FIXTURE = "-----BEGIN AGE ENCRYPTED FILE-----\nZmFrZQ==\n-----END AGE ENCRYPTED FILE-----\n"

interface FixtureResponse {
  status: number
  body: unknown
}

interface RecordedRequest {
  method: string
  path: string
  body: unknown
}

/** The "sha" this suite's fake `POST .../git/blobs` endpoint hands back for a given blob's
 * content -- deliberately not a real git SHA-1, just a content-derived, round-trippable token.
 * This is what lets a test start from a tree entry (e.g. the one named "README.md") and recover
 * the *exact content* that was uploaded for it (see blobContentForPath below), with no need to
 * track blob-call order or juggle a second, response-only recording array the way
 * github-write.test.ts's rate-limit tests juggle a response sequence -- there is nothing
 * order-sensitive under test here, only "which content ended up under which tree path". */
function fakeBlobSha(content: string): string {
  return `blobsha:${content}`
}

function decodeFakeBlobSha(sha: string): string {
  if (!sha.startsWith("blobsha:")) throw new Error(`not a fake blob sha: ${sha}`)
  return sha.slice("blobsha:".length)
}

/** Same "METHOD /path" call-recording convention as github-read.test.ts / github-write.test.ts,
 * with one addition: every `POST .../git/blobs` call is answered dynamically (see fakeBlobSha
 * above) instead of from the static `responses` map, since this suite -- unlike write()'s own
 * tests -- makes *two* blob-creation calls per `initializeDataBranch` run (one per file) that
 * need to stay distinguishable by content, not just by call order. Every other endpoint is
 * answered from `responses`, exactly as in the other two github-*.test.ts files; a call with no
 * matching fixture throws loudly, naming the call, rather than returning some default. */
function recordingFetch(
  calls: string[],
  requests: RecordedRequest[],
  responses: Record<string, FixtureResponse>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const { pathname, search } = new URL(urlStr)
    const method = init?.method ?? "GET"
    const key = `${method} ${pathname}${search}`
    calls.push(key)
    const body: any = init?.body ? JSON.parse(init.body as string) : undefined
    requests.push({ method, path: pathname + search, body })

    if (method === "POST" && pathname === repoPath("/git/blobs")) {
      return new Response(JSON.stringify({ sha: fakeBlobSha(body.content) }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    }
    const fixture = responses[key]
    if (!fixture) throw new Error(`no fixture response for ${key}`)
    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

/** Looks a call string (as recorded in `calls`) back up in `requests` to return that exact
 * request's parsed body -- same helper as github-write.test.ts's makeBodyOf, duplicated rather
 * than imported (each github-*.test.ts file is self-contained, matching this project's existing
 * convention). Only ever called here with keys that occur once per test run (the repo GET, the
 * ref GET, the tree/commit/ref-create POSTs) -- the one endpoint that *can* repeat (blobs) is
 * never looked up this way, see blobContentForPath instead. Return type is deliberately `any`,
 * like the original: the caller immediately destructures GitHub-request-shaped fields
 * (`.parents`, `.tree`, `.ref`, ...) that `unknown` would require a cast for at every call site. */
function makeBodyOf(requests: RecordedRequest[]): (call: string) => any {
  return (call: string) => {
    const req = requests.find((r) => `${r.method} ${r.path}` === call)
    if (!req) throw new Error(`no recorded request for ${call}`)
    return req.body
  }
}

function pathsIn(treeBody: { tree: Array<{ path: string }> }): string[] {
  return treeBody.tree.map((e) => e.path)
}

function blobContentForPath(treeBody: { tree: Array<{ path: string; sha: string }> }, path: string): string {
  const entry = treeBody.tree.find((e) => e.path === path)
  if (!entry) throw new Error(`no "${path}" entry in tree`)
  return decodeFakeBlobSha(entry.sha)
}

function readmeContentIn(treeBody: { tree: Array<{ path: string; sha: string }> }): string {
  return blobContentForPath(treeBody, "README.md")
}

/** Builds a store wired for `ensureSetup()`'s own two fixtures: the repo-metadata GET (private +
 * push permission) and the data-ref GET (branch present/missing). Every field defaults to the
 * "fully set up, ready" shape, so each test overrides only the one thing it's actually about --
 * same spirit as github-read.test.ts's baseFixtures()/github-write.test.ts's writeFixtures(). */
function storeFor(cfg: { private: boolean; push?: boolean; refs?: string[]; token?: string }): {
  store: GithubStore
  calls: string[]
  requests: RecordedRequest[]
} {
  const push = cfg.push ?? true
  const refs = cfg.refs ?? [DATA_BRANCH]
  const calls: string[] = []
  const requests: RecordedRequest[] = []
  const responses: Record<string, FixtureResponse> = {
    [`GET ${repoPath("")}`]: { status: 200, body: { private: cfg.private, permissions: { push } } },
    [`GET ${repoPath(`/git/ref/heads/${DATA_BRANCH}`)}`]: refs.includes(DATA_BRANCH)
      ? { status: 200, body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "data-head-sha" } } }
      : { status: 404, body: { message: "Not Found" } },
  }
  const store = new GithubStore({
    ...baseOpts,
    token: cfg.token ?? baseOpts.token,
    fetch: recordingFetch(calls, requests, responses),
  })
  return { store, calls, requests }
}

/** Thin convenience wrapper over storeFor, for tests that only need the store itself chained
 * straight into `.ensureSetup()` -- matches this task's own brief almost verbatim. */
function storeWithToken(token: string): GithubStore {
  return storeFor({ private: true, token }).store
}

/** Builds a store wired for `initializeDataBranch()`'s own five calls (two blobs, tree, commit,
 * ref-create) -- deliberately carrying NO repo-GET or ref-GET fixture at all, so an accidental
 * call to either (e.g. if initializeDataBranch ever started probing state it has no business
 * probing) fails loudly via recordingFetch's "no fixture response" throw, the same way
 * github-read.test.ts's `readAt` test omits the ref fixture to catch a mistaken ref call. */
function storeForInit(): { store: GithubStore; calls: string[]; requests: RecordedRequest[] } {
  const calls: string[] = []
  const requests: RecordedRequest[] = []
  const responses: Record<string, FixtureResponse> = {
    [`POST ${repoPath("/git/trees")}`]: { status: 201, body: { sha: "data-tree-sha" } },
    [`POST ${repoPath("/git/commits")}`]: { status: 201, body: { sha: "data-commit-sha" } },
    [`POST ${repoPath("/git/refs")}`]: {
      status: 201,
      body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "data-commit-sha" } },
    },
  }
  const store = new GithubStore({ ...baseOpts, fetch: recordingFetch(calls, requests, responses) })
  return { store, calls, requests }
}

const treeCall = `POST ${repoPath("/git/trees")}`
const commitCall = `POST ${repoPath("/git/commits")}`
const createRefCall = `POST ${repoPath("/git/refs")}`

test("a public repo raises RepoPublicError and never writes", async () => {
  // spec §13 -- the only guard standing between the user and world-readable ciphertext
  const { store, calls } = storeFor({ private: false })
  await expect(store.ensureSetup()).rejects.toThrow(RepoPublicError)
  expect(calls.filter((c) => c.startsWith("POST") || c.startsWith("PATCH"))).toEqual([])
})

test("a token without push permission raises TokenError", async () => {
  const { store, calls } = storeFor({ private: true, push: false })
  await expect(store.ensureSetup()).rejects.toThrow(TokenError)
  // same guarantee as the public-repo case above: the guard fires before any write is attempted
  expect(calls.filter((c) => c.startsWith("POST") || c.startsWith("PATCH"))).toEqual([])
})

test("a private repo missing the data branch reports needsDataBranch", async () => {
  const { store } = storeFor({ private: true, refs: [] })
  expect(await store.ensureSetup()).toEqual({ ready: false, needsDataBranch: true })
})

test("initializeDataBranch creates an orphan commit and both files", async () => {
  // spec §9.5 -- no base_tree, no parents, vault.age + plaintext README.md
  const { store, requests } = storeForInit()
  expect(await store.initializeDataBranch({ armored: ARMORED_FIXTURE })).toEqual({ sha: "data-commit-sha" })
  const bodyOf = makeBodyOf(requests)
  expect(bodyOf(treeCall)).not.toHaveProperty("base_tree")
  expect(bodyOf(commitCall).parents).toEqual([])
  expect(pathsIn(bodyOf(treeCall))).toEqual(["README.md", VAULT_PATH])
  expect(blobContentForPath(bodyOf(treeCall), VAULT_PATH)).toBe(ARMORED_FIXTURE)
  expect(bodyOf(createRefCall).ref).toBe(`refs/heads/${DATA_BRANCH}`)
})

test("the data branch README names the decrypt command in plaintext", async () => {
  const { store, requests } = storeForInit()
  await store.initializeDataBranch({ armored: ARMORED_FIXTURE })
  const bodyOf = makeBodyOf(requests)
  expect(readmeContentIn(bodyOf(treeCall))).toContain("age -d vault.age")
})

test("tokens are trimmed, and a classic token is named as wrong", async () => {
  // Review Focus 3
  expect(GithubStore.normalizeToken("  ghp_abc\n")).toBe("ghp_abc")
  const r = await storeWithToken("ghp_classic")
    .ensureSetup()
    .catch((e: unknown) => e)
  expect((r as Error).message).toMatch(/fine-grained/i)
})

// Everything below closes a real coverage gap the 6 tests above leave open, each named
// explicitly rather than left silent -- tasks 7 and 8's own precedent for this exact situation
// (brief predicted 6/5 tests, both shipped more, each addition justified inline).

test("a private repo with the data branch already present reports ready", async () => {
  // The complementary case to "reports needsDataBranch" above -- nothing else proves ensureSetup
  // ever resolves to {ready: true}, only that it CAN report false.
  const { store } = storeFor({ private: true, refs: [DATA_BRANCH] })
  expect(await store.ensureSetup()).toEqual({ ready: true, needsDataBranch: false })
})

test("when both guards would fire, the repo-visibility check wins (checked first)", async () => {
  // Pins the brief's own stated order ("private !== true -> RepoPublicError; permissions.push
  // !== true -> TokenError") with a case that can actually distinguish the two: the public-repo
  // test and the no-push test above each vary only one condition, so a reversed check order
  // would still pass both of them by accident.
  const { store } = storeFor({ private: false, push: false })
  await expect(store.ensureSetup()).rejects.toThrow(RepoPublicError)
})

test("ensureSetup on a 401 raises TokenError", async () => {
  // The brief's own first-listed check, never exercised by name among the 6 named tests. The
  // general 401 -> TokenError mapping lives in shared `request()` code and is already proven by
  // github-read.test.ts against a different endpoint -- this proves THIS call site (GET
  // /repos/{o}/{r}) actually goes through it too, rather than some bespoke bypass.
  const responses: Record<string, FixtureResponse> = {
    [`GET ${repoPath("")}`]: { status: 401, body: { message: "Bad credentials" } },
  }
  const store = new GithubStore({ ...baseOpts, fetch: recordingFetch([], [], responses) })
  await expect(store.ensureSetup()).rejects.toThrow(TokenError)
})

test("a gho_-prefixed (OAuth) token is also named as wrong, not only ghp_", async () => {
  // The brief names both prefixes in one breath ("a ghp_/gho_ prefix") -- this is the second,
  // distinct regex branch that an implementation matching only /^ghp_/ would silently miss.
  const r = await storeWithToken("gho_something")
    .ensureSetup()
    .catch((e: unknown) => e)
  expect(r).toBeInstanceOf(TokenError)
  expect((r as Error).message).toMatch(/fine-grained/i)
})

test("initializeDataBranch's calls happen in the exact order: two blobs, tree, commit, then the ref", async () => {
  // None of the tests above pin the full call COUNT/SEQUENCE -- a stray extra call, or a skipped
  // one, could still leave every individual body assertion above passing for the wrong reason.
  const { store, calls } = storeForInit()
  await store.initializeDataBranch({ armored: ARMORED_FIXTURE })
  expect(calls).toEqual([
    "POST /repos/o/r/git/blobs",
    "POST /repos/o/r/git/blobs",
    "POST /repos/o/r/git/trees",
    "POST /repos/o/r/git/commits",
    "POST /repos/o/r/git/refs",
  ])
})
