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
import {
  TokenError,
  BranchMissingError,
  StaleWriteError,
  RateLimitedError,
  RepoPublicError,
  AlreadyInitializedError,
} from "./errors"

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

/** The one response shape {@link GithubStore.ensureSetup} reads from -- confirmed live against
 * `GET /repos/{o}/{r}` for two real repos on 2026-10-15 (see that method's own doc comment).
 * `permissions` is optional in this type because an unauthenticated request omits it entirely;
 * not relevant in practice here, since every call this class makes is authenticated, but the
 * type should not claim a guarantee this method doesn't itself provide. */
interface RepoResponse {
  private: boolean
  permissions?: { push?: boolean }
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

/** Classic GitHub tokens this app must refuse, by prefix alone -- confirmed directly from
 * GitHub's own token-format table (docs.github.com/en/authentication/keeping-your-account-and-
 * data-secure/about-authentication-to-github, read 2026-10-15): "Personal access token
 * (classic)" -> `ghp_`, "OAuth access token" -> `gho_`, distinct from "Fine-grained personal
 * access token" -> `github_pat_` (this regex does not match that: its second character is "i",
 * not the required "h" -- `/^gh[po]_/` fails there, one position before the `[po]` class is
 * even reached; checked directly with `/^gh[po]_/.test("github_pat_")` === false in this
 * project's own Node runtime, not assumed). A classic token is a real, working
 * credential -- it would often even pass {@link GithubStore.ensureSetup}'s own push-permission
 * check, since a classic PAT's "repo" scope grants broad, multi-repository access -- which is
 * exactly why this app rejects it on sight rather than letting it "work": spec §6.7's
 * one-permission-one-repo model depends on the token being fine-grained, and that can only be
 * told from the token's own prefix, never from how any API call it makes behaves. `ghu_`/`ghs_`/
 * `ghr_` (GitHub App user/installation/refresh tokens, same docs page) are deliberately not
 * covered: nothing in this app's own one-click onboarding (spec §9.3) ever hands a non-technical
 * user one of those to paste. */
const CLASSIC_TOKEN_PREFIX = /^gh[po]_/

/** The `data` branch's own plaintext explainer (spec §6.1) -- the one artifact on that branch
 * meant to be read without this app, this passphrase, or any memory of either. Fixed copy, not
 * templated: nothing about this particular deployment (owner/repo/build hash) belongs in a file
 * whose entire purpose is to outlive the app that wrote it. Contains the literal `age -d
 * vault.age` command (interpolated from {@link VAULT_PATH}, not hand-typed, so it can never
 * drift from the file it actually names) -- spec §6.1 is explicit that a stranger finding this
 * repo in ten years, with no memory of this project, needs exactly that sentence. */
const DATA_BRANCH_README = `# This is an encrypted vault, not application source

\`${VAULT_PATH}\` is a single file, encrypted with age (https://age-encryption.org)
under one passphrase. There is no account, no recovery email, and no support
desk -- the passphrase is the only key, and nothing but it can decrypt this file.

To read it, install the age CLI and run:

    age -d ${VAULT_PATH}

age will ask for the passphrase, then print the plaintext.

This branch is intentionally orphaned: it shares no history with the
application's own source on \`main\`. This file and ${VAULT_PATH} are the
only two things on it.
`

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
    this.token = GithubStore.normalizeToken(opts.token)
    // `.bind(globalThis)`, not a bare reference to the global `fetch`: every call site below
    // invokes it as `this.fetchFn(...)`, a method-style call that binds `this` to the GithubStore
    // instance -- and a real browser's `fetch` requires its receiver to be the global object
    // (it reads internal slots only `Window`/`WorkerGlobalScope` carry). Calling it unbound
    // throws `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`, confirmed
    // live via Playwright/Chromium while wiring src/main.ts's own production path (the first
    // caller anywhere in this project that uses this default -- every existing
    // tests/unit/github-*.test.ts always injects its own `fetch` stub, so this branch was never
    // exercised before). Node's own global `fetch` (undici) does NOT enforce this -- confirmed
    // live in this project's own Node 24 runtime, `({ f: fetch }).f(url)` resolves fine -- which
    // is exactly why 86+ passing vitest tests never caught it: the bug only manifests in a real
    // browser. No behaviour change for any caller that passes its own `fetch` (a test stub has no
    // such receiver requirement, bound or not).
    this.fetchFn = opts.fetch ?? fetch.bind(globalThis)
    this.onRetry = opts.onRetry
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** Strips surrounding whitespace from a pasted token -- Review Focus 3: a token copied out of
   * a notes app or password manager often brings a trailing newline with it, which (left in)
   * would either break the `Authorization` header outright or silently send a different, wrong
   * credential. Trim only: this does NOT also reject a classic-prefixed token -- confirmed
   * deliberately by this task's own test, which feeds this method a whitespace-wrapped `ghp_...`
   * value and asserts it comes back merely trimmed, not thrown. The classic-token rejection
   * lives in {@link ensureSetup} instead (see {@link CLASSIC_TOKEN_PREFIX}), because it must
   * surface as a rejected Promise from an async call a UI is already awaiting, not as this
   * constructor throwing synchronously before any such Promise exists. */
  static normalizeToken(raw: string): string {
    return raw.trim()
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
        // `no-store` on EVERY request, including GETs. Found by the spec §14 acceptance run
        // against real GitHub, not by inspection: GitHub answers authenticated reads with
        // `Cache-Control: private, max-age=60`, so a browser is entitled to serve a 60-second-old
        // copy of `GET /git/ref/heads/data` -- a MUTABLE pointer. The symptom was a conflict
        // view whose "theirs" pane showed the version before the other device's save, while a
        // direct API read in the same test proved GitHub already held the newer one.
        //
        // Applied to everything rather than only to the mutable paths, deliberately. The
        // alternative is a classification -- refs and commit LISTS are mutable, blobs/trees/
        // commits are content-addressed and immutable -- that has to be re-derived correctly by
        // every future person who adds an endpoint, and silently returns stale data when they
        // get it wrong. The saving it would buy is a few KB of JSON on a view a user opens by
        // hand. Correctness is worth more here than the cache is.
        cache: "no-store",
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
   * ever silently lost. {@link assertRepoWritable} first (fix round 1: this cannot be a save
   * into a repo that turned out to be public, or a token that lacks write access, even if the
   * caller never called {@link ensureSetup}), then four requests in this exact order: blob,
   * tree, commit, ref update -- nothing else reads the branch first, so `baseSha` (the commit
   * the caller's edit actually started from) is trusted as given, not re-derived.
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
   * no separate tree-fetch request, no dependency on task 9's README-creation code.
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
    await this.assertRepoWritable()
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

  /** Decides whether this repo is safe and ready to store a vault in -- spec §13's guard, "the
   * only thing standing between a non-technical user and world-readable ciphertext" (this
   * project's own task dispatch, verbatim). No step here ever issues a POST or PATCH, so a
   * caller can call this repeatedly (e.g. a "re-check" button, spec §13's row for the
   * public-repo case) with no side effects.
   *
   * Checks run in a fixed order, each short-circuiting before any later one: a classic
   * (non-fine-grained) token is rejected before any network call at all, since that problem is
   * knowable purely from the token's own shape (see {@link CLASSIC_TOKEN_PREFIX}) and "never a
   * silent retry loop" means not wasting a doomed-by-design call to find it out. Then
   * {@link assertRepoWritable} -- shared with {@link write} and {@link initializeDataBranch}, see
   * its own doc comment for why this is not just an onboarding-time check -- covers 401 (handled
   * generically by {@link request} before any response body is seen), `private !== true`, and
   * `permissions.push !== true`. Only once all of that passes does this probe whether the `data`
   * ref exists yet, reporting the result as `needsDataBranch` rather than throwing
   * {@link BranchMissingError} -- unlike a *read*, "the branch doesn't exist yet" is the
   * expected, normal state for a brand-new deployment here (spec §9 step 5), not a failure. */
  async ensureSetup(): Promise<{ ready: boolean; needsDataBranch: boolean }> {
    if (CLASSIC_TOKEN_PREFIX.test(this.token)) {
      throw new TokenError(
        `this is a classic GitHub token ("ghp_"/"gho_") -- this app needs a fine-grained personal access token instead, scoped to just this one repository`,
      )
    }
    await this.assertRepoWritable()
    const needsDataBranch = !(await this.dataRefExists())
    return { ready: !needsDataBranch, needsDataBranch }
  }

  /** The shared guard between the user and world-readable ciphertext (spec §13) -- called
   * unconditionally at the top of every method that can put data on the repo ({@link write},
   * {@link initializeDataBranch}), not only from {@link ensureSetup}'s own onboarding-time check.
   * Fix round 1 (review finding, Important): without this, a caller that skips `ensureSetup` --
   * or any future caller nobody has written yet, e.g. task 13's wizard -- could call `write` or
   * `initializeDataBranch` directly and silently succeed against a public repo or a token
   * lacking write access, entirely defeating the one guarantee this task exists to provide.
   *
   * `private`/`permissions.push` shape confirmed live against two real repos on 2026-10-15, not
   * assumed from the design spec's prose alone: `gh api repos/github/docs` (a repo this token
   * can only read) came back `{private: false, permissions: {push: false, pull: true, ...}}`;
   * `gh api repos/sigalor/eudaimon` (a private repo this token administers) came back
   * `{private: true, permissions: {push: true, ...}}`. Both confirm the exact field names, and
   * that `permissions` is populated for an authenticated caller, which is all this method reads.
   *
   * Deliberately NOT memoized on the instance. Considered and rejected: saves are user-initiated,
   * and GitHub's authenticated primary rate limit is 5000/hour, so one extra
   * `GET /repos/{o}/{r}` per write is trivial -- while a cached flag would introduce a staleness
   * question (what invalidates it? a timer? a manual re-check?) that would then need its own
   * documentation and its own tests, for a cost this low. The uncached version also catches a
   * real case a cache would miss entirely: a repo flipped from private to public *during* a
   * session (e.g. by the user, in another tab, on github.com) is caught on the very next write,
   * not only at the next fresh page load. One GET per write, on purpose -- do not "optimise" this
   * into a cached flag without re-reading this reasoning first. */
  private async assertRepoWritable(): Promise<void> {
    const repo = await this.request<RepoResponse>("GET", this.repoPath(""))
    if (repo.private !== true) throw new RepoPublicError()
    if (repo.permissions?.push !== true) {
      throw new TokenError(
        `the token can read this repository but cannot write to it -- check it grants "Contents: Read and write" and is scoped to this repo`,
      )
    }
  }

  /** Whether the `data` branch's ref exists yet -- the same `GET .../git/ref/heads/{DATA_BRANCH}`
   * {@link readHead} uses, but stopping at "does it exist", never walking into the tree:
   * {@link ensureSetup} only needs this one boolean, and a tree-walk would cost two more
   * requests (commit, tree) to answer a question this task was never asked -- its own test
   * fixture for "missing" is an empty `refs` list, i.e. the ref itself absent, not a ref pointing
   * at a tree that happens to lack `vault.age` (that distinct condition is {@link readHead}'s
   * own concern, surfaced as {@link BranchMissingError} there, not here). */
  private async dataRefExists(): Promise<boolean> {
    try {
      await this.request<RefResponse>("GET", this.repoPath(`/git/ref/heads/${DATA_BRANCH}`), {
        errorFor: (status) => (status === 404 ? new BranchMissingError() : undefined),
      })
      return true
    } catch (e) {
      if (e instanceof BranchMissingError) return false
      throw e
    }
  }

  /** Creates the orphan `data` branch (spec §9 step 5, §9.5): a root commit -- no parents, no
   * inherited tree -- holding exactly two files, `vault.age` and a plaintext `README.md`.
   * {@link assertRepoWritable} first (fix round 1: this cannot silently create that commit on a
   * public repo, or with a token lacking write access, even if the caller never called
   * {@link ensureSetup}), then five requests: two blobs (README first, then the vault), a tree
   * naming both, a commit, then `POST git/refs` to point a brand-new
   * `refs/heads/{DATA_BRANCH}` at it -- `POST`, not {@link write}'s `PATCH`, because there is no
   * existing ref to conditionally move yet.
   *
   * Deliberately the mirror image of {@link write}'s own tree/commit calls, not a copy of them
   * -- this task's own dispatch names this as the trap to avoid. `write` passes `base_tree:
   * baseSha` so its tree *inherits* every sibling path from the branch's current tip (that is
   * what keeps this very README from being deleted on every later save); this method has no
   * prior commit to inherit from at all, so it omits `base_tree` entirely and lists both paths
   * itself. `write` passes `parents: [baseSha]`; this method passes `parents: []` -- GitHub's own
   * docs for "Create a commit" (docs.github.com/en/rest/git/commits, read directly 2026-10-15):
   * "The full SHAs of the commits that were the parents of this commit. If omitted or empty, the
   * commit will be written as a root commit" -- `[]`, not omission, so the resulting commit is
   * unambiguously a root commit in the request itself, not merely "a commit that happens to have
   * no parents field".
   *
   * The `POST git/refs` shape (`{ref, sha}`, both required) is likewise read directly from
   * GitHub's own docs (docs.github.com/en/rest/git/refs, 2026-10-15), including the one
   * documented caveat that does not apply here: "You are unable to create new references for
   * empty repositories... Empty repositories are repositories without branches" -- not a concern
   * for this app's repo, which always has `main` already populated by the template's own source
   * before a user ever reaches this step (spec §9 steps 1-4 precede this one).
   *
   * Fix round 1 (review finding, Minor): a `data` branch that already exists is reported as
   * {@link AlreadyInitializedError}, not left to surface as {@link request}'s generic,
   * unclassified `Error` the way it did before this fix -- `write`'s own non-fast-forward
   * rejection gets a named class, so this undocumented-but-real failure mode deserved one too.
   * GitHub's own status-code table for this endpoint (docs.github.com/en/rest/git/refs, read
   * 2026-10-15) lists only generic descriptions for both candidates -- `409`: "Conflict",
   * `422`: "Validation failed, or the endpoint has been spammed" -- neither naming the
   * already-exists case specifically, so which one GitHub actually returns here is exactly as
   * undocumented as `write`'s own 409-vs-422 ambiguity (spec §12). Not independently
   * reproducible read-only: confirming it for real would mean creating a second ref against the
   * same name, which this task may not do (task 10 owns repo/branch lifecycle, deliberately,
   * with cleanup) -- so, as with `write`, both stay mapped, which is correct and sufficient
   * regardless of which one is real. */
  async initializeDataBranch(opts: { armored: string }): Promise<{ sha: string }> {
    await this.assertRepoWritable()
    const readmeBlob = await this.request<ShaResponse>("POST", this.repoPath("/git/blobs"), {
      body: { content: DATA_BRANCH_README, encoding: "utf-8" },
    })
    const vaultBlob = await this.request<ShaResponse>("POST", this.repoPath("/git/blobs"), {
      body: { content: opts.armored, encoding: "utf-8" },
    })
    const tree = await this.request<ShaResponse>("POST", this.repoPath("/git/trees"), {
      body: {
        tree: [
          { path: "README.md", mode: "100644", type: "blob", sha: readmeBlob.sha },
          { path: VAULT_PATH, mode: "100644", type: "blob", sha: vaultBlob.sha },
        ],
      },
    })
    const commit = await this.request<ShaResponse>("POST", this.repoPath("/git/commits"), {
      body: { message: "Initialize data branch", tree: tree.sha, parents: [] },
    })
    await this.request<unknown>("POST", this.repoPath("/git/refs"), {
      body: { ref: `refs/heads/${DATA_BRANCH}`, sha: commit.sha },
      errorFor: (status) => (status === 409 || status === 422 ? new AlreadyInitializedError() : undefined),
    })
    return { sha: commit.sha }
  }
}
