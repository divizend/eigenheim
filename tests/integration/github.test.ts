// The only place GithubStore meets the real GitHub API (api.github.com) -- every other test in
// this project (tests/unit/github-{read,write,setup}.test.ts) drives it through an injected fake
// fetch instead. This file's output is evidence, not code any later task consumes (task 10
// brief, "Produces: nothing consumed by later tasks"). The single most important thing it proves:
// a write based on a stale commit is genuinely refused by GitHub, and the earlier version
// survives -- the project's central promise that no edit is ever silently lost (spec §1, §6.4)
// rests on `force: false` behaving as documented, and until this suite ran, that rested on
// GitHub's own docs alone (spec §12's "stale writes cannot clobber" row).
//
// Gated on EIGENHEIM_IT_TOKEN -- a classic GitHub PAT with rights to create/delete repos in the
// target account. Absent in CI and for any contributor without repo-creation rights, so:
//   - vite.config.ts's own `test.include` is scoped to tests/unit/** alone, so a bare
//     `vitest run`/`npm test` never even discovers this file, let alone runs it.
//   - `npm run test:integration` (this project's own dedicated script, see package.json) targets
//     this file via a separate config (vitest.integration.config.ts) -- and even then, every test
//     below individually no-ops via `itif` (test.skipIf(!token)) if the token is still missing,
//     logging an explicit reason once at module load.
//
// Every repo this suite creates is named `eigenheim-it-<random>` -- obviously throwaway, so any
// leftover is instantly recognisable as test debris -- and is deleted both immediately after its
// own test (try/finally) and, as an unconditional backstop, in `afterAll` (which sweeps every
// name this run ever created, tolerating an already-deleted 404, and *fails loudly* -- throwing,
// not swallowing -- if any delete genuinely fails, so a leaked repo is never silent). Nothing this
// suite doesn't itself create is ever touched.
//
// Classic-PAT limitation (ruled on in this task's own dispatch, not discovered here): this box's
// only available GitHub credential is a classic `ghp_` token. `ensureSetup()` rejects any classic
// token before any network call at all (task 9's `CLASSIC_TOKEN_PREFIX` guard), so its happy path
// (`{ready: false, needsDataBranch: true}` for a freshly-initialized repo) can never be exercised
// live from here -- that branch is already covered by tests/unit/github-setup.test.ts's injected
// fetch. What this suite proves instead, as a real integration assertion, is that ensureSetup
// really does reject this box's real, live token this way -- not just a synthetic fixture string.

import { GithubStore } from "../../src/store/github"
import { StaleWriteError, RepoPublicError, TokenError } from "../../src/store/errors"
import { encryptVault, decryptVault } from "../../src/vault/crypto"
import { VAULT_PATH, DATA_BRANCH } from "../../src/config"

const token = process.env.EIGENHEIM_IT_TOKEN
if (!token) {
  console.warn(
    "[tests/integration/github.test.ts] EIGENHEIM_IT_TOKEN is not set -- skipping the real-GitHub " +
      "integration suite. Set it to a classic PAT with rights to create/delete repos in the " +
      "target account, then run `npm run test:integration`.",
  )
}

/** Every test below is wrapped in this, not a bare `test(...)` -- the whole suite gates on the
 * token individually, per test, not just at the file-discovery level (vite.config.ts and
 * vitest.integration.config.ts handle keeping this file out of a bare `vitest run`; this is the
 * second, independent layer: even a direct, deliberate invocation of this exact file with no
 * token set must still no-op cleanly rather than throw on a `string | undefined` token). */
const itif = test.skipIf(!token)

/** Throws instead of silently sending `Authorization: Bearer undefined`. Should be unreachable
 * given `itif` above -- a cheap, explicit guard beats a confusing network error if it ever isn't. */
function requireToken(): string {
  if (!token) throw new Error("EIGENHEIM_IT_TOKEN is unset -- this should never run (see itif)")
  return token
}

const PASS = "a throwaway passphrase for a throwaway repo, forty-plus chars"
const API_BASE = "https://api.github.com"

interface CreatedRepo {
  owner: string
  repo: string
}

/** Every repo this run creates, tracked the moment creation succeeds (before the caller does
 * anything else with it) so `afterAll` can sweep all of them unconditionally, independent of
 * whether the test that created one went on to pass, throw, or fail an assertion. */
const createdRepos: CreatedRepo[] = []

/** Plain, direct `fetch` against GitHub's REST API -- deliberately independent of `GithubStore`,
 * which has no whole-repo-lifecycle surface at all (by design: it only ever operates on a repo
 * that already exists). This task owns repo creation/deletion; `GithubStore` owns everything
 * inside one. */
async function githubApi(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireToken()}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

/** `githubApi` plus "parse the JSON body, or throw with the real status and body if it didn't
 * come back 2xx" -- used only for calls in this file that are never *meant* to fail (repo
 * creation, the raw blob/tree/commit calls in the stale-write reproduction below). The one call
 * that's deliberately expected to fail (the raw ref-update PATCH) calls `githubApi` directly
 * instead, specifically so it can inspect a non-ok status rather than throw on it. */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await githubApi("POST", path, body)
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

function repoPath(created: CreatedRepo, suffix: string): string {
  return `/repos/${created.owner}/${created.repo}${suffix}`
}

function storeFor(created: CreatedRepo): GithubStore {
  // `fetch` is deliberately omitted -- this is the one place in the whole project GithubStore is
  // ever constructed without an injected fixture, so it falls through to the real global fetch.
  return new GithubStore({ owner: created.owner, repo: created.repo, token: requireToken() })
}

function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10)
}

/** Creates an obviously-throwaway repo (`eigenheim-it-<random>`) and registers it for `afterAll`
 * cleanup *before* returning, so a name is tracked even if the caller throws on its very next
 * line. `auto_init: true` -- not GitHub's own default -- so the repo starts with a real commit on
 * its default branch, matching this app's actual real-world precondition (spec §9 steps 1-4
 * always populate `main` from the deploy template before onboarding ever reaches
 * `initializeDataBranch`): GitHub documents `POST git/refs` as refusing to create any ref at all
 * in a repo with zero branches ("Empty repositories are repositories without branches" --
 * docs.github.com/en/rest/git/refs, also quoted in `initializeDataBranch`'s own doc comment in
 * src/store/github.ts) -- a real restriction this suite must route around with a faithful
 * precondition, since the real app never hits it either. */
async function createThrowawayRepo(opts: { private: boolean }): Promise<CreatedRepo> {
  const name = `eigenheim-it-${randomSuffix()}`
  const res = await githubApi("POST", "/user/repos", {
    name,
    private: opts.private,
    auto_init: true,
    description: "throwaway repo for eigenheim's integration test suite (tests/integration/github.test.ts) -- safe to delete",
  })
  if (!res.ok) {
    throw new Error(`failed to create throwaway repo "${name}": ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { owner: { login: string }; name: string }
  const created: CreatedRepo = { owner: body.owner.login, repo: body.name }
  createdRepos.push(created)
  return created
}

/** Deletes a repo by its exact name. Tolerates 404 (already gone -- e.g. a test's own `finally`
 * already deleted it before `afterAll`'s backstop sweep reaches the same name) so cleanup is
 * idempotent, never throwing merely because something else already finished the job. */
async function deleteRepo(created: CreatedRepo): Promise<void> {
  const res = await githubApi("DELETE", repoPath(created, ""))
  if (!res.ok && res.status !== 404) {
    throw new Error(`failed to delete throwaway repo "${created.repo}": ${res.status} ${await res.text()}`)
  }
}

/** Set by the lifecycle test below, read by the status-code test -- the one deliberate piece of
 * shared state in this file (every other test is fully self-contained). Capturing this needs the
 * exact same now-stale `baseSha` the lifecycle test already establishes, so reproducing it again
 * from scratch in a second test would mean creating a second repo and a second stale-write
 * sequence just to observe the same fact twice. Vitest runs the tests within one file
 * sequentially, in declaration order, by default -- confirmed current behaviour for this file (no
 * `concurrent`/`.each` used anywhere in it) -- which is what makes this safe. */
let observedStaleWriteStatus: number | undefined

afterAll(async () => {
  // Unconditional: runs once after every test in this file finishes, regardless of whether each
  // one passed, threw, or failed an assertion. Every repo this run created gets an independent
  // delete attempt (one failing must never stop the others); if any genuinely fails (not a 404 --
  // already handled inside deleteRepo itself), this throws so a leaked repo is loud, never silent.
  if (createdRepos.length === 0) return
  const results = await Promise.allSettled(createdRepos.map(deleteRepo))
  const failures = results
    .map((r, i) => (r.status === "rejected" ? { created: createdRepos[i], reason: r.reason } : undefined))
    .filter((x): x is { created: CreatedRepo; reason: unknown } => x !== undefined)
  if (failures.length > 0) {
    throw new Error(
      `afterAll cleanup failed for ${failures.length} repo(s): ` +
        failures.map((f) => `${f.created.owner}/${f.created.repo} (${String(f.reason)})`).join("; "),
    )
  }
})

itif(
  "full lifecycle against a throwaway private repo: init, read, write, a forced stale write refused, nothing lost",
  async () => {
    const created = await createThrowawayRepo({ private: true })
    const store = storeFor(created)

    try {
      // ensureSetup()'s happy path ({ready:false, needsDataBranch:true}) is deliberately NOT
      // asserted here -- unreachable with this box's classic token, see this file's own header
      // comment and the last two tests below for what this box proves live instead.

      const initResult = await store.initializeDataBranch({ armored: await encryptVault("", PASS) })

      const head0 = await store.readHead()
      expect(head0.sha).toBe(initResult.sha)
      expect(await decryptVault(head0.armored, PASS)).toBe("")

      const v1 = await store.write({ baseSha: head0.sha, armored: await encryptVault("v1\n", PASS), message: "v1" })

      const head1 = await store.readHead()
      expect(head1.sha).toBe(v1.sha)
      expect(await decryptVault(head1.armored, PASS)).toBe("v1\n")

      // readAt against a real, non-tip commit -- distinct from readHead, which only ever reads
      // the current tip. Reading the ORIGINAL (pre-v1) commit by sha, after the tip has already
      // moved past it, is what actually distinguishes "read this specific commit" from "read
      // whatever's current": asserting readAt(v1's own sha) would pass even if readAt secretly
      // ignored its argument and read head instead.
      expect(await decryptVault(await store.readAt(head0.sha), PASS)).toBe("")

      // The guarantee this whole task exists to prove: a second write from the SAME (now stale)
      // base must be refused, never merged, never silently overwritten.
      const stale = store.write({ baseSha: head0.sha, armored: await encryptVault("v2\n", PASS), message: "v2" })
      await expect(stale).rejects.toThrow(StaleWriteError)

      // Captures the raw HTTP status GitHub actually returns for that same rejection --
      // StaleWriteError deliberately doesn't carry it (both 409 and 422 map to the one error
      // class, spec §12), so this reproduces the identical non-fast-forward ref update one layer
      // down, via plain fetch against the same git-data endpoints `write` itself uses, with the
      // same now-stale `head0.sha` as the base, purely to observe the status code.
      const staleBlob = await postJson<{ sha: string }>(repoPath(created, "/git/blobs"), {
        content: await encryptVault("v2-raw\n", PASS),
        encoding: "utf-8",
      })
      const staleTree = await postJson<{ sha: string }>(repoPath(created, "/git/trees"), {
        base_tree: head0.sha,
        tree: [{ path: VAULT_PATH, mode: "100644", type: "blob", sha: staleBlob.sha }],
      })
      const staleCommit = await postJson<{ sha: string }>(repoPath(created, "/git/commits"), {
        message: "raw reproduction of a non-fast-forward rejection (observing the status code only)",
        tree: staleTree.sha,
        parents: [head0.sha],
      })
      const refRes = await githubApi("PATCH", repoPath(created, `/git/refs/heads/${DATA_BRANCH}`), {
        sha: staleCommit.sha,
        force: false,
      })
      observedStaleWriteStatus = refRes.status

      // And nothing was lost: the branch tip and its content are exactly as `write(v1)` left them.
      const headAfter = await store.readHead()
      expect(headAfter.sha).toBe(v1.sha)
      expect(await decryptVault(headAfter.armored, PASS)).toBe("v1\n")

      const hist = await store.history(10)
      expect(hist.length).toBe(2) // the dangling raw-reproduction commit above was never linked in
      expect(hist.map((h) => h.sha)).toEqual([v1.sha, initResult.sha]) // newest first
    } finally {
      await deleteRepo(created)
    }
  },
)

itif("records which status GitHub actually returns for a non-fast-forward", () => {
  // spec §12 lists this as deliberately unverified; the lifecycle test above resolves it. Logged,
  // not just asserted, because the exact value is this task's whole point -- it belongs in the
  // report (and from there, back into the spec), not only in a pass/fail bit.
  console.log("observed non-fast-forward status:", observedStaleWriteStatus)
  expect([409, 422]).toContain(observedStaleWriteStatus)
})

itif("a public repo is refused, even with a token that can otherwise write to it", async () => {
  // assertRepoWritable (shared by write/initializeDataBranch), not ensureSetup -- ensureSetup
  // would reject this box's classic token first, before ever reaching the visibility check (see
  // this file's own header comment).
  const created = await createThrowawayRepo({ private: false })
  try {
    await expect(storeFor(created).initializeDataBranch({ armored: await encryptVault("", PASS) })).rejects.toThrow(
      RepoPublicError,
    )
  } finally {
    await deleteRepo(created)
  }
})

itif("ensureSetup rejects this box's real classic token, not only a fixture string standing in for one", async () => {
  // Precision note (this project's own discipline about not overstating what a claim covers):
  // this rejection itself never reaches api.github.com -- CLASSIC_TOKEN_PREFIX is checked
  // synchronously, before ensureSetup's first network call (see this file's own header comment)
  // -- so "live" here describes the TOKEN (this box's real EIGENHEIM_IT_TOKEN, read from the
  // environment) and the REPO (a real one, just created) being genuine, not a network round-trip
  // happening for this specific check. The other tests in this file already independently prove
  // this same classic token DOES work at the HTTP layer (initializeDataBranch/write/readHead all
  // succeed against the real API under it) -- so what this test isolates is that ensureSetup
  // refuses it anyway, by this app's own deliberate choice, not because the token is somehow
  // rejected by GitHub itself.
  const created = await createThrowawayRepo({ private: true })
  try {
    await expect(storeFor(created).ensureSetup()).rejects.toThrow(TokenError)
  } finally {
    await deleteRepo(created)
  }
})
