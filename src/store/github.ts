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
import { TokenError, BranchMissingError } from "./errors"

const API_BASE = "https://api.github.com"
const API_VERSION = "2022-11-28"

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

  constructor(opts: { owner: string; repo: string; token: string; fetch?: typeof fetch }) {
    this.owner = opts.owner
    this.repo = opts.repo
    this.token = opts.token
    this.fetchFn = opts.fetch ?? fetch
  }

  private repoPath(suffix: string): string {
    return `/repos/${this.owner}/${this.repo}${suffix}`
  }

  /** Sends one GitHub API request, with the token and API version header
   * always attached. Maps the one status every endpoint agrees on (401 ->
   * {@link TokenError}) generically; a 404 is only ever endpoint-specific
   * (e.g. "branch missing" on the ref endpoint, but something else
   * entirely on another), so it is translated by the caller-supplied
   * `on404`, not guessed at here. Any other non-2xx -- or a 404 with no
   * `on404` supplied -- throws a plain, honestly labelled Error: never
   * silently swallowed, but also never forced into a taxonomy this method
   * doesn't own (e.g. rate-limit retry is a later task's concern, against
   * the write path). */
  private async request<T>(method: string, path: string, on404?: () => Error): Promise<T> {
    const res = await this.fetchFn(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
    })
    if (res.status === 401) throw new TokenError()
    if (res.status === 404 && on404) throw on404()
    if (!res.ok) {
      throw new Error(`GitHub API error: ${method} ${path} -> ${res.status} ${res.statusText}`)
    }
    return res.json() as Promise<T>
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
    const ref = await this.request<RefResponse>(
      "GET",
      this.repoPath(`/git/ref/heads/${DATA_BRANCH}`),
      () => new BranchMissingError(`the "${DATA_BRANCH}" branch does not exist yet`),
    )
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
}
