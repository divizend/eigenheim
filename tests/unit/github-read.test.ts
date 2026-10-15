import { GithubStore } from "../../src/store/github"
import {
  StaleWriteError,
  TokenError,
  RepoPublicError,
  BranchMissingError,
  RateLimitedError,
  ALL_ERROR_CLASSES,
} from "../../src/store/errors"
import { VAULT_PATH, DATA_BRANCH } from "../../src/config"

const opts = { owner: "o", repo: "r", token: "test-token" }

function repoPath(suffix: string): string {
  return `/repos/${opts.owner}/${opts.repo}${suffix}`
}

// A real armored age file (the exact bytes of tests/fixtures/cli-auto.age,
// inlined rather than read from disk so this file -- about the GitHub
// transport layer, not vault crypto -- has no dependency on a fixture
// another task owns the lifecycle of). Multi-line on purpose: the body
// itself wraps at 48 bytes/64 base64 chars (age-encryption's own armor
// format), independent of and in addition to the base64-of-the-whole-file
// wrapping GitHub itself does (see BLOB_CONTENT below) -- so decoding this
// round-trip exercises newline-stripping at both layers, not a contrived
// single one.
const ARMORED_FIXTURE =
  "-----BEGIN AGE ENCRYPTED FILE-----\n" +
  "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IHNjcnlwdCBFc243dXJlUU1YNnFQdzRN\n" +
  "c0xyY0ZRIDE4CmZMN2dpV3hMNGpuTkRWRXV6WXdNRnpReWNBaHBkSVIwbGxvVDRi\n" +
  "SjdicFUKLS0tIE5iTTFyWVk5TlJ1NFBnRWljVmJZMFU2TjRxaWZwNFhCUGNuTHQ5\n" +
  "Z2cyT0EKJcVM4sFbtPpU6KpAVxhcCnhi6rmvcuy0HJKA0gYxUQGbzyZ0Jpoqbw==\n" +
  "-----END AGE ENCRYPTED FILE-----\n"

/** Wraps a base64 string at GitHub's own observed blob line width (60
 * characters, trailing newline) -- confirmed live against api.github.com
 * on 2026-10-15 (a real blob's `content` field came back wrapped exactly
 * this way), not assumed. Without this wrapping the fixture would never
 * exercise "blob content arrives with embedded newlines" at all -- it
 * would decode fine even if the implementation forgot to strip them. */
function wrapBase64(b64: string, width = 60): string {
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width))
  return lines.join("\n") + "\n"
}

const BLOB_CONTENT = wrapBase64(btoa(ARMORED_FIXTURE))

interface FixtureResponse {
  status: number
  body: unknown
}

/** One fixture per request `readHead` makes on the happy path, keyed by the
 * exact "METHOD /path" string `recordingFetch` below records -- a typo
 * here surfaces as "no fixture response for ..." (recordingFetch's own
 * guard) rather than a silently wrong response. Returns a fresh object
 * (and fresh nested objects/arrays) every call: tests override individual
 * keys via spread and must never share mutable state with each other. */
function baseFixtures(): Record<string, FixtureResponse> {
  return {
    [`GET ${repoPath(`/git/ref/heads/${DATA_BRANCH}`)}`]: {
      status: 200,
      body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "commit1", type: "commit" } },
    },
    [`GET ${repoPath("/git/commits/commit1")}`]: {
      status: 200,
      body: { sha: "commit1", tree: { sha: "tree1" }, message: "save" },
    },
    [`GET ${repoPath("/git/trees/tree1")}`]: {
      status: 200,
      body: {
        sha: "tree1",
        tree: [
          { path: "README.md", mode: "100644", type: "blob", sha: "readme-blob" },
          { path: VAULT_PATH, mode: "100644", type: "blob", sha: "blob1" },
        ],
      },
    },
    [`GET ${repoPath("/git/blobs/blob1")}`]: {
      status: 200,
      body: { sha: "blob1", content: BLOB_CONTENT, encoding: "base64" },
    },
  }
}

interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string>
}

/** A `fetch` that never touches the network: records every call as a plain
 * "METHOD /path" string (what the ordering assertions below compare
 * against) and, when `requests` is supplied, the full method/path/headers
 * too (what the header assertion needs) -- then answers from `responses`,
 * keyed the same way as `calls`. Throws loudly on a call with no matching
 * fixture instead of returning some default, so a GithubStore bug that
 * hits an unexpected endpoint fails with a clear message naming the call,
 * not a confusing downstream assertion failure. */
function recordingFetch(
  calls: string[],
  responses: Record<string, FixtureResponse>,
  requests?: RecordedRequest[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const { pathname, search } = new URL(urlStr)
    const method = init?.method ?? "GET"
    const key = `${method} ${pathname}${search}`
    calls.push(key)
    if (requests) {
      requests.push({ method, path: pathname + search, headers: Object.fromEntries(new Headers(init?.headers)) })
    }
    const fixture = responses[key]
    if (!fixture) throw new Error(`no fixture response for ${key}`)
    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

test("readHead walks ref -> commit -> tree -> blob", async () => {
  const calls: string[] = []
  const store = new GithubStore({ ...opts, fetch: recordingFetch(calls, baseFixtures()) })
  expect(await store.readHead()).toEqual({ sha: "commit1", armored: ARMORED_FIXTURE })
  expect(calls).toEqual([
    "GET /repos/o/r/git/ref/heads/data",
    "GET /repos/o/r/git/commits/commit1",
    "GET /repos/o/r/git/trees/tree1",
    "GET /repos/o/r/git/blobs/blob1",
  ])
})

test("sends the token and the API version header", async () => {
  const requests: RecordedRequest[] = []
  const store = new GithubStore({ ...opts, fetch: recordingFetch([], baseFixtures(), requests) })
  await store.readHead()
  // Four requests on this path (ref, commit, tree, blob) -- every one of
  // them must carry both headers, not just the first.
  expect(requests.length).toBe(4)
  for (const r of requests) {
    expect(r.headers.authorization).toBe(`Bearer ${opts.token}`)
    expect(r.headers["x-github-api-version"]).toBe("2022-11-28")
  }
})

test("a missing data branch raises BranchMissingError", async () => {
  const calls: string[] = []
  const responses = {
    ...baseFixtures(),
    [`GET ${repoPath(`/git/ref/heads/${DATA_BRANCH}`)}`]: { status: 404, body: { message: "Not Found" } },
  }
  const store = new GithubStore({ ...opts, fetch: recordingFetch(calls, responses) })
  await expect(store.readHead()).rejects.toThrow(BranchMissingError)
  // Fails on the very first call -- never walks further down a branch that
  // does not exist.
  expect(calls).toEqual(["GET /repos/o/r/git/ref/heads/data"])
})

test("a 401 raises TokenError", async () => {
  const responses = {
    ...baseFixtures(),
    [`GET ${repoPath(`/git/ref/heads/${DATA_BRANCH}`)}`]: { status: 401, body: { message: "Bad credentials" } },
  }
  const store = new GithubStore({ ...opts, fetch: recordingFetch([], responses) })
  await expect(store.readHead()).rejects.toThrow(TokenError)
})

test("readHead on a tree without vault.age raises BranchMissingError", async () => {
  const responses = {
    ...baseFixtures(),
    [`GET ${repoPath("/git/trees/tree1")}`]: {
      status: 200,
      body: { sha: "tree1", tree: [{ path: "README.md", mode: "100644", type: "blob", sha: "readme-blob" }] },
    },
  }
  const store = new GithubStore({ ...opts, fetch: recordingFetch([], responses) })
  await expect(store.readHead()).rejects.toThrow(BranchMissingError)
})

test("history maps commits to sha/date/message", async () => {
  const calls: string[] = []
  const responses: Record<string, FixtureResponse> = {
    [`GET ${repoPath(`/commits?sha=${DATA_BRANCH}&per_page=10`)}`]: {
      status: 200,
      body: [
        {
          sha: "commit2",
          // author/committer dates deliberately differ, so a mapping that
          // reads the wrong one would be caught, not accidentally pass.
          commit: {
            author: { date: "2026-10-12T09:00:00Z" },
            committer: { date: "2026-10-12T09:05:00Z" },
            message: "second save",
          },
        },
        {
          sha: "commit1",
          commit: {
            author: { date: "2026-10-10T10:00:00Z" },
            committer: { date: "2026-10-10T10:05:00Z" },
            message: "first save",
          },
        },
      ],
    },
  }
  const store = new GithubStore({ ...opts, fetch: recordingFetch(calls, responses) })
  expect(await store.history(10)).toEqual([
    { sha: "commit2", date: "2026-10-12T09:00:00Z", message: "second save" },
    { sha: "commit1", date: "2026-10-10T10:00:00Z", message: "first save" },
  ])
  // Proves `limit` actually drives the request (not hardcoded) and that
  // the branch queried is DATA_BRANCH, not literally "data" by coincidence.
  expect(calls).toEqual(["GET /repos/o/r/commits?sha=data&per_page=10"])
})

test("readAt reads the vault at a specific historical commit, without walking the ref", async () => {
  // Produced by this task, but not covered by any of the 6 tests the brief
  // names -- all of which exercise readHead. Added so a public method
  // this task ships does not go out with zero direct coverage. No ref
  // fixture exists in this map at all: if readAt ever called the ref
  // endpoint by mistake, recordingFetch's "no fixture response" throw
  // would catch that, rather than this test passing for the wrong reason.
  const calls: string[] = []
  const responses: Record<string, FixtureResponse> = {
    [`GET ${repoPath("/git/commits/commit-old")}`]: {
      status: 200,
      body: { sha: "commit-old", tree: { sha: "tree-old" }, message: "old" },
    },
    [`GET ${repoPath("/git/trees/tree-old")}`]: {
      status: 200,
      body: { sha: "tree-old", tree: [{ path: VAULT_PATH, mode: "100644", type: "blob", sha: "blob-old" }] },
    },
    [`GET ${repoPath("/git/blobs/blob-old")}`]: {
      status: 200,
      body: { sha: "blob-old", content: BLOB_CONTENT, encoding: "base64" },
    },
  }
  const store = new GithubStore({ ...opts, fetch: recordingFetch(calls, responses) })
  expect(await store.readAt("commit-old")).toBe(ARMORED_FIXTURE)
  expect(calls).toEqual([
    "GET /repos/o/r/git/commits/commit-old",
    "GET /repos/o/r/git/trees/tree-old",
    "GET /repos/o/r/git/blobs/blob-old",
  ])
})

test("ALL_ERROR_CLASSES lists exactly the five named error classes, each constructible with no arguments", () => {
  // Task 7 amendment: Task 19's failure-recovery UI test enumerates this
  // array to prove every error class renders a visible way forward, so a
  // class silently missing here (or a stray duplicate) would silently
  // narrow -- or pad -- that coverage. Sorted before comparing: this array
  // is "the five classes, as a set", not a promise about declaration
  // order.
  const expected = [StaleWriteError, TokenError, RepoPublicError, BranchMissingError, RateLimitedError]
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  expect([...ALL_ERROR_CLASSES].sort(byName)).toEqual([...expected].sort(byName))

  for (const ErrorClass of ALL_ERROR_CLASSES) {
    // Zero-argument construction is exactly how Task 19's test instantiates
    // each class -- if any constructor required an argument, that test
    // would fail with no clue this array was the cause.
    const instance = new ErrorClass()
    expect(instance).toBeInstanceOf(Error)
    // Catches a copy-paste slip (e.g. two classes' constructors both
    // setting the same this.name) that the sorted-array check above
    // cannot: that check only sees the five constructor *references*,
    // never an instance's own runtime .name.
    expect(instance.name).toBe(ErrorClass.name)
  }
})
