// GitHub storage backend, read half (spec §6.3, §6.6). Talks to the
// low-level git data API (blobs/trees/commits/refs), not the contents API
// -- the contents API caps reads at 1 MB while the blobs API allows up to
// 100 MB, and the git API yields a proper parent-commit handle that the
// conditional write (a later task, same class) needs (spec §6.2).
//
// This file has no Node types available (tsconfig.app.json covers `src/`
// with DOM libs only) and must stay that way: fetch/atob/URL are real
// browser globals -- no `Buffer`, no `node:*`. (They are also real globals
// under this project's Node 24.18.0 test runtime, which is what lets
// vitest exercise this module directly with no polyfill.)
//
// Every method goes through the single private `request` helper, which
// always attaches the bearer token and GitHub's versioned-API header --
// confirmed live against api.github.com on 2026-10-15 that both schemes
// are honoured as documented: `Authorization: Bearer <token>` against a
// real (if deliberately invalid) token yielded "Bad credentials" rather
// than being ignored the way an unrecognised scheme (tried: `Basic ...`)
// silently was (that request came back 200, treated as anonymous); and an
// `X-GitHub-Api-Version: 2022-11-28` request header came back echoed as
// `x-github-api-version-selected: 2022-11-28` in the response. `fetch` is
// an injectable constructor option (default: the global), which is how
// every test in this and later tasks drives this class without network.

import { VAULT_PATH, DATA_BRANCH } from "../config"
import { TokenError, BranchMissingError, StaleWriteError, RateLimitedError } from "./errors"

const API_BASE = "https://api.github.com"
const API_VERSION = "2022-11-28"

/** Bounded retry budget for GitHub's secondary rate limits (spec §6.4, Review Focus 5 in the
 * plan: "rapid repeated commits... hits GitHub's secondary rate limits"). Five attempts, each
 * capped at 30s, is "do not retry forever" -- generous enough that a human-triggered autosave
 * burst recovers on its own, bounded enough that a save never hangs indefinitely. */
const MAX_RATE_LIMIT_RETRIES = 5
const DEFAULT_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 30_000

/** How long to wait before retrying a 403/429. Reads `Retry-After` when GitHub sends it --
 * confirmed by reading GitHub's own rate-limit docs directly
 * (docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api): "If the
 * retry-after response header is present, you should not retry your request until after that
 * many seconds has elapsed" -- a plain integer count of seconds, never an HTTP-date. Falls back
 * to capped exponential backoff when the header is absent or unparseable: this task's own brief
 * says Retry-After arrives "often", not always, and a rate-limited response with no header must
 * still back off rather than busy-loop.
 *
 * `header` is checked for truthiness, not just non-null (fix round 1, review finding 2):
 * `res.headers.get(...)` returns `null` when the header is absent, but an empty or
 * whitespace-only *value* is still a non-null string, and `Number("")`/`Number("   ")` are both
 * `0` -- finite and `>= 0` -- which previously made either case compute a bogus 0ms delay
 * instead of falling back to exponential backoff. Confirmed live in this project's own Node
 * runtime before fixing: `Number("")` -> `0`, `Number.isFinite(0)` -> `true`. Not a realistic
 * GitHub response (GitHub either omits the header or sends a real integer), but the guard is
 * one extra `?.trim()` and closes the whole class of "present but content-free" values, not
 * just the literal empty string the review named. */
function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after")?.trim()
  const seconds = header ? Number(header) : NaN
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
  return Math.min(DEFAULT_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS)
}

/** Does this 403/429 carry a positive, GitHub-documented signal that it is actually a rate
 * limit, rather than some other reason for the same status code? This distinction matters
 * because 403 (unlike 429) is GitHub's general "forbidden" status, also used for a fine-grained
 * PAT or GitHub App token that is syntactically valid and unexpired but lacks the specific
 * permission an endpoint needs -- precisely the mistake a non-technical user following this
 * app's one-click token walkthrough will make (wrong permission checkbox, or the wrong
 * repository in the token's access list). Retrying that for up to
 * `MAX_RATE_LIMIT_RETRIES * ~30s` and then reporting `RateLimitedError` ("retrying shortly")
 * would be actively wrong: retrying can never fix a permission problem, and the design already
 * has a recovery flow for exactly this one (the token walkthrough again, task 9's `ensureSetup`
 * guard).
 *
 * `429` is unconditional: GitHub's REST API docs never describe a `429` for any reason other
 * than rate limiting (confirmed by reading both docs.github.com/en/rest/using-the-rest-api/
 * rate-limits-for-the-rest-api, which frames every `429` it mentions as a limit, and
 * docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api, whose own named
 * permission-problem case -- "Resource not accessible by integration" / "Resource not
 * accessible by personal access token" -- is documented as a `403` only). `403` is gated on
 * three positive signals, any one of which is sufficient, each sourced from GitHub's own
 * rate-limit docs rather than assumed:
 * - `retry-after` header present -- secondary limit ("if the header is present...").
 * - `x-ratelimit-remaining: 0` -- primary limit, documented explicitly: "If you exceed your
 *   primary rate limit, you will receive a 403 or 429 response, and the x-ratelimit-remaining
 *   header will be 0."
 * - the response body's `message` names a rate limit -- the docs describe this shape only in
 *   prose ("an error message that indicates that you exceeded a secondary rate limit"), so the
 *   literal substring check here is corroborated rather than directly quoted: real, independent
 *   reports across multiple docs.github.com/orgs/community/discussions threads consistently
 *   show the actual text as e.g. "You have exceeded a secondary rate limit...". The permission
 *   -problem case's own documented message ("Resource not accessible by...") never contains
 *   this substring, so the two remain distinguishable by message alone even with no header at
 *   all.
 *
 * What this function could **not** verify live: the exact response this project's own fetch
 * would get back from a real fine-grained PAT that has repository access but lacks the
 * `Contents: Read and write` permission. Creating such a token has no REST API at all -- GitHub
 * fine-grained PAT creation is web-UI-only, gated on an interactive human approval step, which
 * this box cannot drive -- so this is grounded in GitHub's own official troubleshooting
 * doc (which names the exact message and the status as 403) plus independent, consistent
 * real-world corroboration, not a live reproduction the way the base_tree/422 findings in
 * `write`'s own doc comment were. Flagged here rather than silently presented as equally
 * verified. */
async function isRateLimited(res: Response): Promise<boolean> {
  if (res.status === 429) return true
  if (res.headers.get("retry-after") !== null) return true
  if (res.headers.get("x-ratelimit-remaining") === "0") return true
  return /rate limit/i.test(await bodyMessage(res))
}

/** Best-effort read of a response body's `message` field, for {@link isRateLimited}'s
 * message-based signal. Never throws: a non-JSON or shapeless body just means "no message to
 * check", which is the correct, safe default here -- the two header-based signals above do not
 * depend on this succeeding, so a parse failure can never hide a real rate limit, only fail to
 * find the one extra, headerless signal. */
async function bodyMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
      return body.message
    }
  } catch {
    // not JSON, or no string `message` field -- fall through to "no message", see above.
  }
  return ""
}

interface RefResponse {
  object: { sha: string }
}

interface CommitResponse {
  tree: { sha: string }
}

interface TreeEntry {
  path: string
  sha: string
  type: string
}

interface TreeResponse {
  tree: TreeEntry[]
}

interface BlobResponse {
  content: string
}

interface CommitListItem {
  sha: string
  commit: {
    author: { date: string }
    message: string
  }
}

/** Shared by the three git-data "create" calls `write` makes (blob/tree/commit) -- each
 * response has other fields too, but `write` only ever reads `.sha` off any of them. */
interface ShaResponse {
  sha: string
}

/** Strips the embedded newlines GitHub wraps blob `content` at (confirmed
 * live: api.github.com wraps a blob's base64 content at 60 characters per
 * line, trailing newline at the end) before decoding.
 *
 * This strip is defense-in-depth, not load-bearing in this project's own
 * runtime: verified directly (`atob("aGVs\nbG8=")` in this project's Node
 * 24.18.0) that `atob` here already tolerates and silently drops an
 * embedded `\n` on its own, because it implements the WHATWG "forgiving-
 * base64 decode" algorithm, which strips ASCII whitespace before the rest
 * of decoding even runs -- Node aligned `atob` with that spec in Node 18.
 * Kept explicit anyway, both because it costs nothing and because it is
 * not a given that every engine this code might run under implements that
 * same leniency, so this is one less thing to depend on.
 *
 * No TextDecoder step is needed after `atob`: every blob this app ever
 * reads through this path is `vault.age`, and age-encryption's own
 * `armor.encode` (read directly in
 * node_modules/age-encryption/dist/armor.js) only ever emits the two
 * literal `-----BEGIN/END AGE ENCRYPTED FILE-----` header lines plus
 * base64-alphabet (`[A-Za-z0-9+/=]`) body lines -- i.e. the decoded bytes
 * are always plain ASCII, so `atob`'s binary string already equals the
 * real text. */
function decodeBase64Blob(content: string): string {
  return atob(content.replace(/\n/g, ""))
}

export class GithubStore {
  private readonly owner: string
  private readonly repo: string
  private readonly token: string
  private readonly fetchFn: typeof fetch
  /** Called once per rate-limit retry (spec Review Focus 5), so the UI can say "retrying in
   * Ns" instead of reporting a failed save. Optional: a caller that doesn't pass one just gets
   * silent, bounded retrying. */
  private readonly onRetry?: (info: { attempt: number; delayMs: number }) => void
  /** How `request` waits out a rate-limit retry. A real implementation by default; tests inject
   * one that records the requested delay and resolves immediately, which is what keeps the
   * rate-limit tests in tests/unit/github-write.test.ts deterministic and fast instead of
   * genuinely waiting on a real `Retry-After` -- the same injection pattern this class already
   * uses for `fetch`. */
  private readonly sleepFn: (ms: number) => Promise<void>

  constructor(opts: {
    owner: string
    repo: string
    token: string
    fetch?: typeof fetch
    onRetry?: (info: { attempt: number; delayMs: number }) => void
    sleep?: (ms: number) => Promise<void>
  }) {
    this.owner = opts.owner
    this.repo = opts.repo
    this.token = opts.token
    this.fetchFn = opts.fetch ?? fetch
    this.onRetry = opts.onRetry
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** `owner`/`repo` come from build-time injection (`repoOwner()`/
   * `repoSlug()`, spec §9.2), never from user input, so there is no
   * injection vector being closed here -- GitHub's current repo/owner
   * naming rules already make a path-breaking character in either
   * impossible today. Encoded anyway: it is free, it is the standard thing
   * to do when interpolating a value into a URL path, and it removes an
   * implicit dependency on those naming rules never changing (or on this
   * class only ever being constructed with values that respect them). */
  private repoPath(suffix: string): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`
  }

  /** Sends one GitHub API request, with the token and API version header always attached, a
   * JSON body when given one, and transparent retry on GitHub's rate limits. Maps the one
   * status every endpoint agrees on (401 -> {@link TokenError}) generically; every other
   * status's meaning is endpoint-specific (a 404 means "branch missing" on the ref endpoint but
   * something else entirely elsewhere; a 409/422 means "stale write" only on the ref-update
   * PATCH), so it is translated by the caller-supplied `errorFor`, not guessed at here --
   * this generalises task 7's single-purpose `on404?: () => Error` into a status -> error
   * factory now that task 8 needs a second, differently-scoped mapping on a different call
   * (task 7's own review flagged this generalisation as expected, not a snuck-in refactor).
   * Any other non-2xx -- or a mapped status with no matching `errorFor` entry -- throws a
   * plain, honestly labelled Error: never silently swallowed, but also never forced into a
   * taxonomy this method doesn't own.
   *
   * A 429 is always a GitHub rate limit (spec Review Focus 5); a 403 is only treated as one
   * when {@link isRateLimited} finds a positive signal for it (fix round 1: a 403 is also
   * GitHub's general "forbidden" status, returned for a token that is valid but lacks the
   * required repository permission -- retrying that is actively wrong, since no amount of
   * waiting fixes a permission problem). A real rate limit is retried with backoff, up to
   * {@link MAX_RATE_LIMIT_RETRIES} times, before giving up with {@link RateLimitedError} --
   * never retried forever. A 403 that isn't a rate limit throws {@link TokenError} immediately,
   * with a message naming the permission problem, never retried. This all runs before
   * `errorFor` is even consulted: nothing in this class ever needs 403/429 to mean anything
   * else (task 9's permission-check guard reads a `permissions` field off a 200 response body,
   * not a 403 status, so there is no real conflict to arbitrate here). */
  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; errorFor?: (status: number) => Error | undefined } = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": API_VERSION,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      })

      if ((res.status === 403 || res.status === 429) && (await isRateLimited(res))) {
        if (attempt >= MAX_RATE_LIMIT_RETRIES) throw new RateLimitedError()
        const delayMs = retryDelayMs(res, attempt)
        this.onRetry?.({ attempt: attempt + 1, delayMs })
        await this.sleepFn(delayMs)
        continue
      }

      // A 403 that reached here carries none of isRateLimited's three signals -- fix round 1,
      // review finding 1. Overwhelmingly, per GitHub's own troubleshooting docs, this is a
      // fine-grained PAT or GitHub App token with insufficient repository permission, not a
      // rate limit: retrying it cannot help, and misreporting it as RateLimitedError ("retrying
      // shortly") would tell the user to wait when waiting can never fix it, instead of routing
      // them to the token walkthrough the design already specifies for exactly this case.
      if (res.status === 403) {
        throw new TokenError(
          `the GitHub token doesn't have the required repository permission ("Contents: Read and write") -- check the token's permissions and repository access list, or create a new one`,
        )
      }

      if (res.status === 401) throw new TokenError()
      const mapped = opts.errorFor?.(res.status)
      if (mapped) throw mapped
      if (!res.ok) {
        throw new Error(`GitHub API error: ${method} ${path} -> ${res.status} ${res.statusText}`)
      }
      return res.json() as Promise<T>
    }
  }

  /** Walks tree -> blob for `vault.age` at a specific commit, and decodes
   * it. Shared by {@link readHead} (which resolves the commit from the
   * branch tip first) and {@link readAt} (given the commit directly) --
   * both need the exact same two requests once a commit sha is in hand. */
  private async readVaultAtCommit(commitSha: string): Promise<string> {
    const commit = await this.request<CommitResponse>("GET", this.repoPath(`/git/commits/${commitSha}`))
    const tree = await this.request<TreeResponse>("GET", this.repoPath(`/git/trees/${commit.tree.sha}`))
    const entry = tree.tree.find((e) => e.path === VAULT_PATH && e.type === "blob")
    if (!entry) {
      throw new BranchMissingError(`"${VAULT_PATH}" not found in the "${DATA_BRANCH}" branch's tree`)
    }
    const blob = await this.request<BlobResponse>("GET", this.repoPath(`/git/blobs/${entry.sha}`))
    return decodeBase64Blob(blob.content)
  }

  /** Reads the current tip of the `data` branch (spec §6.3): ref -> commit
   * -> tree -> blob, four requests in that exact order. */
  async readHead(): Promise<{ sha: string; armored: string }> {
    const ref = await this.request<RefResponse>("GET", this.repoPath(`/git/ref/heads/${DATA_BRANCH}`), {
      errorFor: (status) =>
        status === 404 ? new BranchMissingError(`the "${DATA_BRANCH}" branch does not exist yet`) : undefined,
    })
    const commitSha = ref.object.sha
    const armored = await this.readVaultAtCommit(commitSha)
    return { sha: commitSha, armored }
  }

  /** Reads the vault as of one specific historical commit -- the "base"
   * and "theirs" sides of a three-way merge (spec §6.5) and history
   * browsing (spec §6.6) both need this. Three requests, not four: no ref
   * lookup, since the commit is already known. */
  async readAt(commitSha: string): Promise<string> {
    return this.readVaultAtCommit(commitSha)
  }

  /** Lists recent commits on the `data` branch, newest first -- GitHub's
   * own ordering for this endpoint, confirmed live against a real repo on
   * 2026-10-15 (spec §6.6). */
  async history(limit: number): Promise<Array<{ sha: string; date: string; message: string }>> {
    const commits = await this.request<CommitListItem[]>(
      "GET",
      this.repoPath(`/commits?sha=${DATA_BRANCH}&per_page=${limit}`),
    )
    return commits.map((c) => ({ sha: c.sha, date: c.commit.author.date, message: c.commit.message }))
  }

  /** Writes a new vault revision: a conditional, fast-forward-only push to the `data` branch
   * (spec §6.4) -- the mechanism that guarantees no concurrent edit from a second device is
   * ever silently lost. Four requests, always in this exact order: blob, tree, commit, ref
   * update -- nothing else reads the branch first, so `baseSha` (the commit the caller's edit
   * actually started from) is trusted as given, not re-derived.
   *
   * `base_tree: opts.baseSha` on the tree-creation call -- a *commit* sha, not a separately
   * fetched tree sha -- is this method's own key design choice, and it is verified, not
   * assumed: confirmed live against a real (private, scratch, deleted immediately after)
   * repo on 2026-10-15 that `POST git/trees`'s `base_tree` resolves a commit sha to that
   * commit's tree, the same way `GET git/trees/{sha}` does. A tree built this way, naming only
   * the one changed path (`vault.age`), still inherits every other entry (e.g. `README.md`,
   * created once by task 9's orphan-branch init) from `baseSha`'s own tree unmodified --
   * verified by reading the created tree back and seeing both paths present. This matters
   * because GitHub documents the alternative plainly (https://docs.github.com/en/rest/git/trees
   * -- "Create a tree"): "If you create a new commit pointing to such a tree, then all files
   * which were a part of the parent commit's tree and were not defined in the tree parameter
   * will be listed as deleted by the new commit" -- i.e. omitting `base_tree` here would make
   * every save silently delete README.md from the branch. Using `baseSha` costs nothing extra:
   * no fifth request, no dependency on task 9's README-creation code.
   *
   * The blob is sent as `encoding: "utf-8"` with the armored text as-is, not pre-encoded to
   * base64 -- also confirmed live to round-trip byte-identical through GitHub's base64 `GET`
   * (which is what {@link readVaultAtCommit}'s `decodeBase64Blob` always decodes), including
   * multibyte UTF-8 and embedded newlines, not just the plain-ASCII armor text this project
   * actually ever stores.
   *
   * `parents: [opts.baseSha]` (never the current head) is what makes the ref update
   * meaningfully conditional: GitHub's `force: false` -- sent explicitly, never relied on as a
   * default, so the guarantee is visible in this source rather than inferred from GitHub's docs
   * -- rejects the update unless this commit is a fast-forward of the branch's *actual* current
   * tip. A write based on a stale `baseSha` is therefore refused by the server, never merged
   * and never silently overwritten; task 12 catches the rejection and runs a three-way merge,
   * task 15 shows it to the user. GitHub documents both 409 and 422 as possible statuses for a
   * rejected non-fast-forward update without saying which applies (spec §12); this task's own
   * live reproduction of a genuine non-fast-forward rejection got 422 ("Update is not a fast
   * forward"), which confirms 422 occurs but not that 409 cannot -- both stay mapped to
   * {@link StaleWriteError}, exactly as required. */
  async write(opts: { baseSha: string; armored: string; message: string }): Promise<{ sha: string }> {
    const blob = await this.request<ShaResponse>("POST", this.repoPath("/git/blobs"), {
      body: { content: opts.armored, encoding: "utf-8" },
    })
    const tree = await this.request<ShaResponse>("POST", this.repoPath("/git/trees"), {
      body: {
        base_tree: opts.baseSha,
        tree: [{ path: VAULT_PATH, mode: "100644", type: "blob", sha: blob.sha }],
      },
    })
    const commit = await this.request<ShaResponse>("POST", this.repoPath("/git/commits"), {
      body: { message: opts.message, tree: tree.sha, parents: [opts.baseSha] },
    })
    await this.request<unknown>("PATCH", this.repoPath(`/git/refs/heads/${DATA_BRANCH}`), {
      body: { sha: commit.sha, force: false },
      errorFor: (status) => (status === 409 || status === 422 ? new StaleWriteError() : undefined),
    })
    return { sha: commit.sha }
  }
}
