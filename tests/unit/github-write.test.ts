import { GithubStore } from "../../src/store/github"
import { StaleWriteError, RateLimitedError, TokenError } from "../../src/store/errors"
import { VAULT_PATH, DATA_BRANCH } from "../../src/config"

const storeOpts = { owner: "o", repo: "r", token: "test-token" }

// The caller always holds a `baseSha` (the commit its edit started from), the armored
// vault text, and a human-readable commit message -- exactly `write`'s own parameter
// shape (brief "Produces"). Named separately from `storeOpts` above (which constructs
// GithubStore itself) so the two can never be confused at a call site.
const writeOpts = {
  baseSha: "base-sha",
  armored: "-----BEGIN AGE ENCRYPTED FILE-----\nZmFrZQ==\n-----END AGE ENCRYPTED FILE-----\n",
  message: "save from device A",
}

function repoPath(suffix: string): string {
  return `/repos/${storeOpts.owner}/${storeOpts.repo}${suffix}`
}

interface FixtureResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

/** `write`'s happy-path fixtures: one 201 per creation call (blobs/trees/commits all answer
 * "Created" on success), then a 200 on the ref update. Shapes -- which fields exist, which
 * status codes -- are taken from this task's own live verification against a real (private,
 * scratch, deleted immediately after) repo on 2026-10-15 (see src/store/github.ts's `write`
 * doc comment), not guessed. Fresh object every call, like github-read.test.ts's
 * baseFixtures(), so tests overriding one key via spread never share mutable state. */
function writeFixtures(): Record<string, FixtureResponse> {
  return {
    [`POST ${repoPath("/git/blobs")}`]: { status: 201, body: { sha: "blob-sha" } },
    [`POST ${repoPath("/git/trees")}`]: { status: 201, body: { sha: "tree-sha" } },
    [`POST ${repoPath("/git/commits")}`]: { status: 201, body: { sha: "commit-sha" } },
    [`PATCH ${repoPath(`/git/refs/heads/${DATA_BRANCH}`)}`]: {
      status: 200,
      body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "commit-sha" } },
    },
  }
}

/** Same "METHOD /path" call-recording convention as github-read.test.ts's recordingFetch,
 * extended two ways this task needs: it always records each request's parsed JSON body (there
 * was nothing to parse on the read path's GETs) alongside headers, and a fixture may be an
 * *array* of responses for one key, consumed in order and holding on the last entry once
 * exhausted -- that is what drives "fails once, then succeeds" (one retry) and "fails forever"
 * (bounded-retry-gives-up) without either test needing its own bespoke fetch. Throws loudly on
 * an unregistered call, same as the read-path version. */
function recordingFetch(
  calls: string[],
  requests: RecordedRequest[],
  responses: Record<string, FixtureResponse | FixtureResponse[]>,
): typeof fetch {
  const cursor: Record<string, number> = {}
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const { pathname, search } = new URL(urlStr)
    const method = init?.method ?? "GET"
    const key = `${method} ${pathname}${search}`
    calls.push(key)
    requests.push({
      method,
      path: pathname + search,
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })
    const fixture = responses[key]
    if (!fixture) throw new Error(`no fixture response for ${key}`)
    const sequence = Array.isArray(fixture) ? fixture : [fixture]
    const i = cursor[key] ?? 0
    cursor[key] = i + 1
    const picked = sequence[Math.min(i, sequence.length - 1)]
    return new Response(JSON.stringify(picked.body), {
      status: picked.status,
      headers: { "content-type": "application/json", ...picked.headers },
    })
  }) as typeof fetch
}

/** Looks a call string (as recorded in `calls`, e.g. `calls.at(-1)!`) back up in `requests` to
 * return the exact same request's parsed body -- so a test can name one call once and both
 * order- and body-assert on it, matching this task's brief verbatim (`bodyOf(calls[2])`). */
function makeBodyOf(requests: RecordedRequest[]): (call: string) => any {
  return (call: string) => {
    const req = requests.find((r) => `${r.method} ${r.path}` === call)
    if (!req) throw new Error(`no recorded request for ${call}`)
    return req.body
  }
}

function storeRejectingRefWith(status: number): GithubStore {
  const responses: Record<string, FixtureResponse> = {
    ...writeFixtures(),
    [`PATCH ${repoPath(`/git/refs/heads/${DATA_BRANCH}`)}`]: { status, body: { message: "not a fast forward" } },
  }
  return new GithubStore({ ...storeOpts, fetch: recordingFetch([], [], responses) })
}

/** Builds a store whose ref-update call answers from `sequence` (in order, holding the last
 * entry), with normal fixtures on the other three calls -- the shape every rate-limit test
 * below needs. `sleep` is injected to *record* the requested delay and resolve immediately,
 * never actually waiting: this is this task's "make the retry test deterministic" requirement,
 * done the same way this project already injects `fetch` (a constructor option, defaulting to
 * a real implementation) rather than real-timer juggling (`vi.useFakeTimers`) that nothing else
 * in this codebase uses yet. */
function storeWith(
  sequence: FixtureResponse[],
  onRetry?: (info: { attempt: number; delayMs: number }) => void,
): { store: GithubStore; calls: string[]; requests: RecordedRequest[]; sleeps: number[] } {
  const calls: string[] = []
  const requests: RecordedRequest[] = []
  const responses: Record<string, FixtureResponse | FixtureResponse[]> = {
    ...writeFixtures(),
    [`PATCH ${repoPath(`/git/refs/heads/${DATA_BRANCH}`)}`]: sequence,
  }
  const sleeps: number[] = []
  const store = new GithubStore({
    ...storeOpts,
    fetch: recordingFetch(calls, requests, responses),
    onRetry,
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
  })
  return { store, calls, requests, sleeps }
}

test("write creates blob, tree, commit, then fast-forwards the ref", async () => {
  const calls: string[] = []
  const requests: RecordedRequest[] = []
  const store = new GithubStore({ ...storeOpts, fetch: recordingFetch(calls, requests, writeFixtures()) })
  expect(await store.write(writeOpts)).toEqual({ sha: "commit-sha" })
  expect(calls).toEqual([
    "POST /repos/o/r/git/blobs",
    "POST /repos/o/r/git/trees",
    "POST /repos/o/r/git/commits",
    "PATCH /repos/o/r/git/refs/heads/data",
  ])
})

test("the ref update always carries force: false", async () => {
  // the entire conflict-safety guarantee, spec §6.4 — pinned, not assumed
  const calls: string[] = []
  const requests: RecordedRequest[] = []
  const store = new GithubStore({ ...storeOpts, fetch: recordingFetch(calls, requests, writeFixtures()) })
  await store.write(writeOpts)
  const bodyOf = makeBodyOf(requests)
  expect(bodyOf(calls.at(-1)!).force).toBe(false)
})

test("the commit's parent is the base the edit was made on", async () => {
  const calls: string[] = []
  const requests: RecordedRequest[] = []
  const store = new GithubStore({ ...storeOpts, fetch: recordingFetch(calls, requests, writeFixtures()) })
  await store.write(writeOpts)
  const bodyOf = makeBodyOf(requests)
  expect(bodyOf(calls[2]).parents).toEqual(["base-sha"])
})

test("a rejected non-fast-forward raises StaleWriteError on 409 AND on 422", async () => {
  // GitHub's docs don't say which of these a non-fast-forward rejection returns (spec §12).
  // This task's own live reproduction (a genuine second-device-style conflict against a real,
  // scratch, private repo, 2026-10-15) got 422 ("Update is not a fast forward") -- which
  // confirms 422 is real, not which is exhaustive, so both stay mapped exactly as required.
  for (const status of [409, 422]) {
    await expect(storeRejectingRefWith(status).write(writeOpts)).rejects.toThrow(StaleWriteError)
  }
})

test("a secondary rate limit is retried after Retry-After, not reported as failure", async () => {
  // Review Focus 5
  const { store } = storeWith([
    { status: 403, body: { message: "secondary rate limit" }, headers: { "retry-after": "1" } },
    { status: 200, body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "commit-sha" } } },
  ])
  await expect(store.write(writeOpts)).resolves.toMatchObject({ sha: expect.any(String) })
})

// Everything below is additional coverage added during self-review, not named by the brief --
// each closes a gap the five tests above leave open, named explicitly rather than left silent
// (task 7's own precedent for this exact situation).

test("every call in write sends the token and the API version header", async () => {
  // Mirrors github-read.test.ts's equivalent test for the read path -- `request`'s header
  // attachment is shared code, but nothing yet proved it still fires on POST/PATCH, only GET.
  const calls: string[] = []
  const requests: RecordedRequest[] = []
  const store = new GithubStore({ ...storeOpts, fetch: recordingFetch(calls, requests, writeFixtures()) })
  await store.write(writeOpts)
  expect(requests.length).toBe(4)
  for (const r of requests) {
    expect(r.headers.authorization).toBe(`Bearer ${storeOpts.token}`)
    expect(r.headers["x-github-api-version"]).toBe("2022-11-28")
  }
})

test("the blob carries the real vault content, and the tree is based on baseSha", async () => {
  // Closes the biggest gap the brief's own three shape assertions leave open: none of them
  // check that the *content* being saved is the caller's real armored text (a bug that sent a
  // constant string would still pass "force: false" and "parents: [baseSha]"), and none check
  // `base_tree` at all. `base_tree: baseSha` is this implementation's own load-bearing choice,
  // confirmed live (see src/store/github.ts) to make GitHub inherit every other entry in the
  // base commit's tree (e.g. README.md) into the new one -- so this is pinned here, not left
  // to accidentally keep working.
  const calls: string[] = []
  const requests: RecordedRequest[] = []
  const store = new GithubStore({ ...storeOpts, fetch: recordingFetch(calls, requests, writeFixtures()) })
  await store.write(writeOpts)
  const bodyOf = makeBodyOf(requests)
  expect(bodyOf(calls[0])).toEqual({ content: writeOpts.armored, encoding: "utf-8" })
  expect(bodyOf(calls[1])).toEqual({
    base_tree: "base-sha",
    tree: [{ path: VAULT_PATH, mode: "100644", type: "blob", sha: "blob-sha" }],
  })
  expect(bodyOf(calls[2]).message).toBe(writeOpts.message)
})

test("a rate limit that never clears eventually raises RateLimitedError, not an infinite retry", async () => {
  // The brief requires bounded backoff ("do not retry forever"); the brief's own named test
  // only proves one retry succeeds, which a that-never-gives-up loop would also pass. A fixed
  // single-element sequence repeats forever (see storeWith/recordingFetch), so this can only
  // pass if the implementation actually stops on its own.
  const { store, calls } = storeWith([{ status: 403, body: { message: "secondary rate limit" }, headers: { "retry-after": "1" } }])
  await expect(store.write(writeOpts)).rejects.toThrow(RateLimitedError)
  const refCalls = calls.filter((c) => c.endsWith(`/git/refs/heads/${DATA_BRANCH}`))
  expect(refCalls.length).toBeGreaterThan(1) // it did retry at least once...
  expect(refCalls.length).toBeLessThan(20) // ...but gave up well short of "forever"
})

test("onRetry reports the attempt number and the Retry-After-derived delay", async () => {
  // The brief requires onRetry "so the UI can say 'retrying in Ns'" -- its own named rate-limit
  // test never passes one, so nothing would catch onRetry being unwired entirely without this.
  const retries: Array<{ attempt: number; delayMs: number }> = []
  const { store } = storeWith(
    [
      { status: 403, body: { message: "secondary rate limit" }, headers: { "retry-after": "2" } },
      { status: 200, body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "commit-sha" } } },
    ],
    (info) => retries.push(info),
  )
  await store.write(writeOpts)
  expect(retries).toEqual([{ attempt: 1, delayMs: 2000 }])
})

test("the delay actually awaited matches what onRetry reports, not a drifted value", async () => {
  // Distinct from the onRetry test above: that one proves the *reported* info is right, this
  // one proves the *awaited* delay agrees with it -- a copy-paste slip reading the wrong
  // variable into one or the other would pass one test and fail this one. Asserting an exact,
  // small, millisecond value (rather than just "some positive number") is also this suite's
  // check that storeWith's injected sleep is really being hit at all: a real, un-injected timer
  // would make this specific assertion impossible to get right deterministically, since nothing
  // here would control or observe it.
  const { store, sleeps } = storeWith([
    { status: 429, body: { message: "secondary rate limit" }, headers: { "retry-after": "3" } },
    { status: 200, body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "commit-sha" } } },
  ])
  await store.write(writeOpts)
  expect(sleeps).toEqual([3000])
})

// Fix round 1 (review finding 1): a 403 is GitHub's general "forbidden" status, not only its
// rate-limit status -- a syntactically valid, unexpired token that simply lacks the required
// repository permission (the realistic mistake in this app's own one-click fine-grained-PAT
// setup) also gets a 403. The tests above all happen to carry a `retry-after` header, so none
// of them would have caught the original bug (every 403 retried unconditionally, then
// misreported as RateLimitedError once exhausted). These four pin the three positive signals
// individually, and the one negative case, against the real production code path.

test("a 403 with x-ratelimit-remaining: 0 (primary rate limit) is retried, not treated as a permission error", async () => {
  const { store } = storeWith([
    { status: 403, body: { message: "API rate limit exceeded for user ID 1." }, headers: { "x-ratelimit-remaining": "0" } },
    { status: 200, body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "commit-sha" } } },
  ])
  await expect(store.write(writeOpts)).resolves.toMatchObject({ sha: expect.any(String) })
})

test("a 403 with a rate-limit-naming message but no headers at all is still retried", async () => {
  const { store } = storeWith([
    {
      status: 403,
      body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." },
    },
    { status: 200, body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "commit-sha" } } },
  ])
  await expect(store.write(writeOpts)).resolves.toMatchObject({ sha: expect.any(String) })
})

test("a 403 with none of the rate-limit signals raises TokenError immediately, without retrying", async () => {
  // The actively-wrong case this fix closes: GitHub's own documented wording for this ("Resource
  // not accessible by personal access token") never mentions a rate limit, and carries neither
  // `retry-after` nor `x-ratelimit-remaining: 0`.
  const { store, calls } = storeWith([{ status: 403, body: { message: "Resource not accessible by personal access token" } }])
  await expect(store.write(writeOpts)).rejects.toThrow(TokenError)
  // Exactly one request -- proves this raised immediately rather than merely ending in the
  // right error after retrying anyway (which a looser "rejects.toThrow" alone wouldn't catch).
  const refCalls = calls.filter((c) => c.endsWith(`/git/refs/heads/${DATA_BRANCH}`))
  expect(refCalls.length).toBe(1)
})

test("a 429 is always treated as a rate limit, even with none of the 403 signals present", async () => {
  // 429 is unconditional (per the brief's fix and GitHub's own docs, which never document a 429
  // for any reason other than rate limiting) -- a bare 429 with no header and no recognisable
  // message must still retry, not raise TokenError the way an equally bare 403 now does.
  const { store } = storeWith([
    { status: 429, body: { message: "too many requests" } },
    { status: 200, body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "commit-sha" } } },
  ])
  await expect(store.write(writeOpts)).resolves.toMatchObject({ sha: expect.any(String) })
})

test("an empty Retry-After header value falls back to exponential backoff, not a 0ms delay", async () => {
  // Fix round 1, review finding 2: `Number("")` is `0`, which is finite and `>= 0`, so the
  // delay computation previously used a bogus 0ms wait instead of falling back to exponential
  // backoff. An empty (but present) `retry-after` still satisfies isRateLimited's
  // header-presence check -- this test is specifically about what delay gets computed and
  // awaited once that's already decided, not about whether to retry at all.
  const { store, sleeps } = storeWith([
    { status: 403, body: { message: "secondary rate limit" }, headers: { "retry-after": "" } },
    { status: 200, body: { ref: `refs/heads/${DATA_BRANCH}`, object: { sha: "commit-sha" } } },
  ])
  await store.write(writeOpts)
  expect(sleeps).toEqual([1000]) // DEFAULT_RETRY_DELAY_MS * 2**0 -- the fallback, not 0
})
