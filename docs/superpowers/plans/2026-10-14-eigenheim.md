# eigenheim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A static web app, deployable to Vercel in one click, that stores one monospace text file as an ASCII-armored age file in the user's own private GitHub repo, encrypted and decrypted only in the browser under a single passphrase.

**Architecture:** Three layers with no server component anywhere. `src/vault/` is pure computation (age encryption, passphrase rules, three-way merge) with no DOM and no network. `src/store/` talks to GitHub's git data API and to IndexedDB. `src/ui/` renders five views over those two. The browser holds the only key; GitHub holds only ciphertext; Vercel holds only static assets.

**Tech Stack:** Vite, TypeScript, vitest, Playwright, `age-encryption` (typage), `node-diff3`, `qrcode`, `fake-indexeddb` (dev), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-14-eigenheim-design.md` — read it before Task 1. The plan argues from it and does not restate it.

## Global Constraints

Every task's requirements implicitly include these. Violating one is a spec change, not an implementation choice.

- **No backend.** No serverless function, no API route, no server-side code. Build output is static assets only.
- **`SCRYPT_LOG_N = 17`** (spec §5.4), defined once in `src/config.ts` and imported everywhere.
- **The two scrypt runs must never be concurrent** (spec §5.4 — concurrent runs peak near 512 MiB and get mobile tabs discarded).
- **Runtime dependencies are exactly** `age-encryption`, `node-diff3`, `qrcode`, plus two wordlists as data files. Adding another runtime dependency is a spec change (spec §4).
- **`vault.age` is an ASCII-armored age file with a passphrase (scrypt) recipient and nothing else.** Never add a second recipient — it would be a second door (spec §2, §5.1).
- **Every write to `data` passes `force: false`** (spec §6.4).
- **The passphrase is never persisted** to IndexedDB, localStorage, sessionStorage, a cookie, or a URL (spec §7).
- **Passphrases are full Unicode. No character-set restriction, ever.** Encoded UTF-8 and passed through untouched on write — never Unicode-normalised, or the vault would open here and fail under `age -d`. Surrounding whitespace is stripped; nothing else is (spec §5.5).
- **Nothing is stored until the repo is confirmed `private: true`** (spec §9.1, §13).
- **Every failure state offers a visible way forward** (spec §13). A thrown error with no UI affordance is an incomplete task.

## Review Focus

Five input classes the spec implies but does not enumerate, ordered by how likely they are to bite a real person. Each has a test in the task that owns the code.

1. **Windows line endings (CRLF).** Text pasted from Word or a Windows editor round-trips through age unchanged, then `node-diff3` splits on `\n` and leaves `\r` on every line — producing spurious whole-file conflicts and `\r` corruption on merge. Expected: CRLF text round-trips byte-identically, and a CRLF document edited on one side merges cleanly. → Task 5.
2. **A passphrase pasted with surrounding whitespace.** Users paste from a notes app or password manager and bring a trailing newline or space with them. The passphrase is then unreproducible by hand in either the app or the CLI, and with no recovery key that is permanent total loss. Expected: stripped at setup and at unlock alike, so the two can never disagree. → Task 4. (Related, same task: a passphrase that is *visually* the same but differs in Unicode normalisation across devices — handled by a read-side fallback in Task 11, never by restricting the character set.)
3. **A token pasted with surrounding whitespace, or the wrong kind of token.** Users paste with a trailing newline, or paste a classic `ghp_` token, or paste the token's *name*. Expected: trimmed before use, and a wrong/insufficient token produces a specific message naming what is wrong — never a silent retry loop. → Task 9.
4. **Two tabs open on the same device.** Both hold the same vault and write the same `draft.age` in the same IndexedDB. Expected: the second tab does not clobber the first tab's newer draft; last-write-wins on identical content is fine, losing keystrokes is not. → Task 6.
5. **Rapid repeated commits.** Holding ⌘S, or an autosave bug, hits GitHub's secondary rate limits. Expected: `403`/`429` with `Retry-After` is surfaced as "retrying in Ns", backed off, and retried — not reported as a failed save. → Task 8.

---

### Task 1: Scaffold, config, and the build-time repo identity

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vercel.json`, `index.html`, `src/config.ts`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `src/config.ts` exporting `SCRYPT_LOG_N: 17`, `VAULT_PATH: "vault.age"`, `DATA_BRANCH: "data"`, `repoOwner(): string`, `repoSlug(): string`, `BUILD_HASH: string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/config.test.ts
import { SCRYPT_LOG_N, VAULT_PATH, DATA_BRANCH, repoOwner, repoSlug } from "../../src/config"

test("scrypt work factor is 17, not age's default of 18", () => {
  expect(SCRYPT_LOG_N).toBe(17)          // spec §5.4 — memory-bound on phones
})
test("paths match the spec's repo layout", () => {
  expect(VAULT_PATH).toBe("vault.age")
  expect(DATA_BRANCH).toBe("data")
})
test("repo identity comes from the build, not from user input", () => {
  expect(repoOwner()).toBe("test-owner")  // injected by vite define in test env
  expect(repoSlug()).toBe("test-repo")
})

test("runtime dependencies are exactly the three the spec allows", () => {
  // spec §4 — bundle size IS a security property here, so this is a guard,
  // not housekeeping. A fourth runtime dep is a spec change.
  expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["age-encryption", "node-diff3", "qrcode"])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: FAIL — cannot resolve `../../src/config`

- [ ] **Step 3: Scaffold the project and implement `src/config.ts`**

`npm create vite@latest` with the vanilla-ts template, then add vitest. `vite.config.ts` uses `define` to inject `VERCEL_GIT_REPO_OWNER` and `VERCEL_GIT_REPO_SLUG` (spec §9.2) as compile-time constants, falling back to `"test-owner"`/`"test-repo"` when unset so tests and local dev work. `BUILD_HASH` is injected the same way from an env var, defaulting to `"dev"`.

`vercel.json` is exactly the spec §6.1 snippet — `$schema` plus `git.deploymentEnabled: { "data": false }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: scaffold vite project with build-time repo identity"
```

---

### Task 2: Vault encryption, and the interop fixtures that defend it

**Files:**
- Create: `src/vault/crypto.ts`, `scripts/make-fixtures.sh`
- Create: `tests/fixtures/cli-logn17.age`, `tests/fixtures/cli-logn18.age`, `tests/fixtures/PASSPHRASE`
- Test: `tests/unit/crypto.test.ts`

**Interfaces:**
- Consumes: `SCRYPT_LOG_N` from Task 1.
- Produces:
  - `encryptVault(plaintext: string, passphrase: string): Promise<string>` — armored
  - `decryptVault(armored: string, passphrase: string): Promise<string>`
  - `encryptToRecipient(plaintext: string, recipient: string): Promise<string>`
  - `decryptWithIdentity(armored: string, identity: string): Promise<string>`
  - `class WrongPassphraseError extends Error`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/crypto.test.ts
test("vault round-trips, armored", async () => {
  const a = await encryptVault("# notes\nline two\n", "a-sufficiently-long-passphrase")
  expect(a).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/)
  expect(await decryptVault(a, "a-sufficiently-long-passphrase")).toBe("# notes\nline two\n")
})

test("writes at the configured work factor", async () => {
  const a = await encryptVault("x", "a-sufficiently-long-passphrase")
  // armor body decodes to a header whose scrypt stanza ends in the work factor
  expect(headerOf(a)).toMatch(new RegExp(`scrypt \\S+ ${SCRYPT_LOG_N}\\b`))
})

test("decrypts files written by the real age CLI at a DIFFERENT work factor", async () => {
  // spec §11 — proves the header's factor is honoured, not assumed
  const pass = (await readFixture("PASSPHRASE")).trim()
  expect(await decryptVault(await readFixture("cli-logn18.age"), pass)).toBe("interop\n")
  expect(await decryptVault(await readFixture("cli-logn17.age"), pass)).toBe("interop\n")
})

test("a wrong passphrase raises WrongPassphraseError, not a generic failure", async () => {
  const a = await encryptVault("secret", "a-sufficiently-long-passphrase")
  await expect(decryptVault(a, "a-different-long-passphrase")).rejects.toThrow(WrongPassphraseError)
})

test("a Unicode passphrase round-trips and is NOT normalised", async () => {
  // spec §5.5. Verified live against the real CLI with this exact passphrase.
  const p = "schlüsselwort-für-mein-eigenheim-日本語-🔐"
  expect(await decryptVault(await encryptVault("ok\n", p), p)).toBe("ok\n")
  // NFC and NFD are different passphrases, by design — normalising on write
  // would open the vault here but fail under `age -d`.
  const nfd = p.normalize("NFD")
  expect(nfd).not.toBe(p)
  await expect(decryptVault(await encryptVault("ok\n", p), nfd)).rejects.toThrow(WrongPassphraseError)
})

test("text containing age armor delimiters survives a round trip", async () => {
  const nasty = "-----BEGIN AGE ENCRYPTED FILE-----\nnot really\n-----END AGE ENCRYPTED FILE-----\n"
  expect(await decryptVault(await encryptVault(nasty, "a-sufficiently-long-passphrase"), "a-sufficiently-long-passphrase")).toBe(nasty)
})
```

- [ ] **Step 2: Generate the fixtures, then run the test to verify it fails**

`scripts/make-fixtures.sh` downloads the official `age` binary (pinned v1.3.2) and writes `cli-logn17.age` and `cli-logn18.age` from the plaintext `interop\n` using `age -p -a`, with the work factor set via `-WORKFACTOR`/repeated runs as that version supports; it writes the passphrase it used to `tests/fixtures/PASSPHRASE`. Fixtures are committed — CI must not need network to run unit tests.

Run: `bash scripts/make-fixtures.sh && npx vitest run tests/unit/crypto.test.ts`
Expected: FAIL — `src/vault/crypto.ts` does not exist

- [ ] **Step 3: Implement the four functions in `src/vault/crypto.ts`**

Wraps `age-encryption`'s `Encrypter`/`Decrypter` and `armor` per spec §5.2. `decryptVault` must distinguish "no stanza matched" (wrong passphrase → `WrongPassphraseError`) from malformed input (rethrow) — typage throws for both, so inspect the message rather than mapping everything to one error.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/crypto.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: age vault encryption with real-CLI interop fixtures"
```

---

### Task 3: Device identity

**Files:**
- Create: `src/vault/identity.ts`
- Test: `tests/unit/identity.test.ts`

**Interfaces:**
- Consumes: `encryptVault`, `decryptVault`, `encryptToRecipient`, `decryptWithIdentity` from Task 2.
- Produces:
  - `generateDeviceIdentity(): Promise<{ identity: string; recipient: string }>`
  - `wrapIdentity(identity: string, passphrase: string): Promise<string>` — the `device.age` body
  - `unwrapIdentity(wrapped: string, passphrase: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

```ts
test("a generated identity wraps under the passphrase and unwraps back", async () => {
  const { identity } = await generateDeviceIdentity()
  const w = await wrapIdentity(identity, "a-sufficiently-long-passphrase")
  expect(await unwrapIdentity(w, "a-sufficiently-long-passphrase")).toBe(identity)
})
test("identities are distinct per device", async () => {
  expect((await generateDeviceIdentity()).identity).not.toBe((await generateDeviceIdentity()).identity)
})
test("the wrapped identity is an age file, not plaintext", async () => {
  const { identity } = await generateDeviceIdentity()
  const w = await wrapIdentity(identity, "a-sufficiently-long-passphrase")
  expect(w).not.toContain(identity)
  expect(w).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/)
})
test("content encrypted to the device recipient opens with its identity", async () => {
  const { identity, recipient } = await generateDeviceIdentity()
  expect(await decryptWithIdentity(await encryptToRecipient("draft text", recipient), identity)).toBe("draft text")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/identity.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/vault/identity.ts`**

Use typage's `generateIdentity` and `identityToRecipient`. `wrapIdentity` is `encryptVault` applied to the identity string — same passphrase, same work factor, so local storage is protected to the same standard as the vault (spec §5.3).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/identity.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: passphrase-wrapped device identity for local storage"
```

---

### Task 4: Passphrase generation and the strength floor

**Files:**
- Create: `src/vault/passphrase.ts`, `src/vault/wordlists/diceware.txt`, `src/vault/wordlists/common-passwords.txt`
- Test: `tests/unit/passphrase.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `generatePassphrase(words?: number): string` — default 6, space-separated
  - `checkPassphrase(p: string): { ok: true } | { ok: false; reason: string }`
  - `normalizePassphrase(p: string): string` — strips surrounding whitespace, nothing else. Every passphrase entry point calls it; it must NOT apply Unicode normalisation (spec §5.5 rule 2).

- [ ] **Step 1: Write the failing test**

```ts
test("generates six words from the bundled list", () => {
  const w = generatePassphrase().split(" ")
  expect(w).toHaveLength(6)
  w.forEach(word => expect(DICEWARE).toContain(word))
})
test("generated passphrases pass the floor and differ from each other", () => {
  expect(checkPassphrase(generatePassphrase())).toEqual({ ok: true })
  expect(generatePassphrase()).not.toBe(generatePassphrase())
})
test("rejects anything under 20 characters", () => {       // spec §5.5
  expect(checkPassphrase("short").ok).toBe(false)
  expect(checkPassphrase("x".repeat(19)).ok).toBe(false)
  expect(checkPassphrase("x".repeat(20)).ok).toBe(true)
})
test("rejects a common password even when long enough", () => {
  expect(checkPassphrase("password1234567890123").ok).toBe(false)
})
test("accepts full Unicode — umlauts, CJK, emoji", () => {
  // spec §5.5. There is no character-set restriction: age and age-encryption
  // both hash the raw UTF-8 bytes, so no special handling is needed.
  expect(checkPassphrase("schlüsselwort-für-mein-eigenheim-日本語-🔐")).toEqual({ ok: true })
})
test("counts length in codepoints, not UTF-16 units or bytes", () => {
  expect(checkPassphrase("🔐".repeat(20)).ok).toBe(true)    // 20 codepoints, 40 UTF-16 units
  expect(checkPassphrase("🔐".repeat(19)).ok).toBe(false)
})
test("strips surrounding whitespace before judging or using it", () => {
  // Review Focus 2 — a pasted trailing newline is otherwise unreproducible
  // by hand, in this app or in the CLI, and there is no recovery key.
  expect(normalizePassphrase("  my-long-enough-passphrase\n")).toBe("my-long-enough-passphrase")
  expect(checkPassphrase("  short  ").ok).toBe(false)       // judged on the stripped form
})
test("uses rejection sampling, not modulo, over the word list", () => {
  // every index must be reachable; a modulo fold silently biases the tail
  const seen = new Set<string>()
  for (let i = 0; i < 20000; i++) seen.add(generatePassphrase(1))
  expect(seen.size).toBeGreaterThan(DICEWARE.length * 0.9)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/passphrase.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Vendor the wordlists and implement `src/vault/passphrase.ts`**

`diceware.txt` is the EFF long wordlist (7776 words, one per line, the numeric prefixes stripped). `common-passwords.txt` is the top 10 000 list; filter it to entries of ≥20 characters before bundling — shorter ones are already rejected by the length rule, so shipping them is dead weight in a bundle whose size is a security property (spec §4).

`generatePassphrase` draws indices from `crypto.getRandomValues` with rejection sampling. `checkPassphrase` runs `normalizePassphrase` first, then applies: codepoint length < 20 → reject; membership in the common list → reject. There is no character-set check — do not add one.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/passphrase.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: diceware generation and passphrase floor"
```

---

### Task 5: Three-way merge

**Files:**
- Create: `src/vault/merge.ts`
- Test: `tests/unit/merge.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `merge3(base: string, mine: string, theirs: string): { text: string; conflicted: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
test("non-overlapping edits merge cleanly", () => {
  const r = merge3("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")
  expect(r).toEqual({ text: "A\nb\nC\n", conflicted: false })
})
test("overlapping edits conflict and show both sides", () => {
  const r = merge3("a\n", "mine\n", "theirs\n")
  expect(r.conflicted).toBe(true)
  expect(r.text).toContain("mine")
  expect(r.text).toContain("theirs")
})
test("a one-sided edit takes that side", () => {
  expect(merge3("a\n", "a\n", "b\n")).toEqual({ text: "b\n", conflicted: false })
  expect(merge3("a\n", "b\n", "a\n")).toEqual({ text: "b\n", conflicted: false })
})
test("empty base — the first commit after setup", () => {
  expect(merge3("", "mine\n", "").text).toBe("mine\n")
})
test("identical sides never conflict", () => {
  expect(merge3("a\n", "b\n", "b\n")).toEqual({ text: "b\n", conflicted: false })
})
test("CRLF text merges without \\r corruption or spurious conflict", () => {
  // Review Focus 1: text pasted from Windows/Word
  const r = merge3("a\r\nb\r\n", "A\r\nb\r\n", "a\r\nb\r\n")
  expect(r.conflicted).toBe(false)
  expect(r.text).toBe("A\r\nb\r\n")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/merge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `merge3` in `src/vault/merge.ts`**

Wrap `node-diff3`. Split on a regex that keeps line terminators with their lines (`/(?<=\n)/`) so CRLF survives, rather than `split("\n")` which strands `\r`. Conflict regions render with the conventional `<<<<<<< mine` / `=======` / `>>>>>>> theirs` markers — the user is shown them and chooses (spec §6.5).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/merge.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: three-way merge preserving line terminators"
```

---

### Task 6: Local store (IndexedDB)

**Files:**
- Create: `src/store/local.ts`
- Test: `tests/unit/local.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: `class LocalStore` with
  - `putWrappedIdentity(a: string): Promise<void>` / `getWrappedIdentity(): Promise<string | null>`
  - `putToken(armored: string): Promise<void>` / `getToken(): Promise<string | null>`
  - `putDraft(d: { armored: string; baseSha: string; savedAt: number }): Promise<void>` / `getDraft(): Promise<Draft | null>`
  - `putCachedVault(c: { armored: string; sha: string }): Promise<void>` / `getCachedVault(): Promise<CachedVault | null>`
  - `clear(): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// uses fake-indexeddb
test("each slot round-trips and is absent before first write", async () => { /* all four slots */ })
test("no slot ever holds the passphrase", async () => {
  // write everything via the real setup path, then scan every stored value
  const dump = await dumpAll(db)
  expect(JSON.stringify(dump)).not.toContain(PASSPHRASE)
})
test("a second tab does not overwrite a newer draft with an older one", async () => {
  // Review Focus 4
  const a = new LocalStore(), b = new LocalStore()
  await a.putDraft({ armored: "new", baseSha: "s", savedAt: 2000 })
  await b.putDraft({ armored: "old", baseSha: "s", savedAt: 1000 })
  expect((await a.getDraft())!.armored).toBe("new")
})
test("clear() removes every slot", async () => { /* ... */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/local.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/store/local.ts`**

One IndexedDB database, one object store keyed by slot name. `putDraft` must read the stored `savedAt` inside the same transaction and skip the write if the incoming one is older — that is what makes the two-tab test pass, and a naive `put` will fail it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/local.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: IndexedDB local store with monotonic draft writes"
```

---

### Task 7: GitHub store — read path

**Files:**
- Create: `src/store/github.ts`, `src/store/errors.ts`
- Test: `tests/unit/github-read.test.ts`

**Interfaces:**
- Consumes: Task 1 config.
- Produces:
  - `class GithubStore { constructor(opts: { owner: string; repo: string; token: string; fetch?: typeof fetch }) }`
  - `readHead(): Promise<{ sha: string; armored: string }>`
  - `readAt(commitSha: string): Promise<string>`
  - `history(limit: number): Promise<Array<{ sha: string; date: string; message: string }>>`
  - `src/store/errors.ts`: `StaleWriteError`, `TokenError`, `RepoPublicError`, `BranchMissingError`, `RateLimitedError`

- [ ] **Step 1: Write the failing test**

```ts
test("readHead walks ref -> commit -> tree -> blob", async () => {
  const calls: string[] = []
  const store = new GithubStore({ ...opts, fetch: recordingFetch(calls, FIXTURE_RESPONSES) })
  expect(await store.readHead()).toEqual({ sha: "commit1", armored: "-----BEGIN AGE..." })
  expect(calls).toEqual([
    "GET /repos/o/r/git/ref/heads/data",
    "GET /repos/o/r/git/commits/commit1",
    "GET /repos/o/r/git/trees/tree1",
    "GET /repos/o/r/git/blobs/blob1",
  ])
})
test("sends the token and the API version header", async () => { /* assert Authorization + X-GitHub-Api-Version */ })
test("a missing data branch raises BranchMissingError", async () => { /* ref 404 */ })
test("a 401 raises TokenError", async () => { /* ... */ })
test("readHead on a tree without vault.age raises BranchMissingError", async () => { /* ... */ })
test("history maps commits to sha/date/message", async () => { /* ... */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/github-read.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the read path per spec §6.3 and §6.6**

Blob content arrives base64 with embedded newlines — strip them before decoding. The injectable `fetch` is how every test in Tasks 7–9 drives this class without network.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/github-read.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: GitHub read path over the git data API"
```

---

### Task 8: GitHub store — conditional write

**Files:**
- Modify: `src/store/github.ts`
- Test: `tests/unit/github-write.test.ts`

**Interfaces:**
- Consumes: Task 7.
- Produces: `write(opts: { baseSha: string; armored: string; message: string }): Promise<{ sha: string }>`

- [ ] **Step 1: Write the failing test**

```ts
test("write creates blob, tree, commit, then fast-forwards the ref", async () => {
  expect(calls).toEqual([
    "POST /repos/o/r/git/blobs",
    "POST /repos/o/r/git/trees",
    "POST /repos/o/r/git/commits",
    "PATCH /repos/o/r/git/refs/heads/data",
  ])
})
test("the ref update always carries force: false", async () => {
  // the entire conflict-safety guarantee, spec §6.4 — pinned, not assumed
  expect(bodyOf(calls.at(-1)!).force).toBe(false)
})
test("the commit's parent is the base the edit was made on", async () => {
  expect(bodyOf(calls[2]).parents).toEqual(["base-sha"])
})
test("a rejected non-fast-forward raises StaleWriteError on 409 AND on 422", async () => {
  for (const status of [409, 422]) {
    await expect(storeRejectingRefWith(status).write(opts)).rejects.toThrow(StaleWriteError)
  }
})
test("a secondary rate limit is retried after Retry-After, not reported as failure", async () => {
  // Review Focus 5
  const store = storeWith([{ status: 403, headers: { "retry-after": "1" } }, { status: 200 }])
  await expect(store.write(opts)).resolves.toMatchObject({ sha: expect.any(String) })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/github-write.test.ts`
Expected: FAIL — `write` is not a function

- [ ] **Step 3: Implement `write` per spec §6.4**

Four calls in order. Map both 409 and 422 on the `PATCH` to `StaleWriteError` (spec §12 records that GitHub does not document which applies). Retry `403`/`429` bearing `Retry-After` with bounded backoff, surfacing progress through an optional `onRetry` callback so the UI can say "retrying in Ns" rather than "save failed".

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/github-write.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: conditional write with force:false and rate-limit backoff"
```

---

### Task 9: Setup guards and orphan-branch initialisation

**Files:**
- Modify: `src/store/github.ts`
- Test: `tests/unit/github-setup.test.ts`

**Interfaces:**
- Consumes: Tasks 7–8.
- Produces:
  - `ensureSetup(): Promise<{ ready: boolean; needsDataBranch: boolean }>`
  - `initializeDataBranch(opts: { armored: string }): Promise<{ sha: string }>`
  - `static normalizeToken(raw: string): string`

- [ ] **Step 1: Write the failing test**

```ts
test("a public repo raises RepoPublicError and never writes", async () => {
  // spec §13 — the only guard standing between the user and world-readable ciphertext
  await expect(storeFor({ private: false }).ensureSetup()).rejects.toThrow(RepoPublicError)
  expect(calls.filter(c => c.startsWith("POST") || c.startsWith("PATCH"))).toEqual([])
})
test("a token without push permission raises TokenError", async () => { /* permissions.push false */ })
test("a private repo missing the data branch reports needsDataBranch", async () => {
  expect(await storeFor({ private: true, refs: [] }).ensureSetup()).toEqual({ ready: false, needsDataBranch: true })
})
test("initializeDataBranch creates an orphan commit and both files", async () => {
  // spec §9.5 — no base_tree, no parents, vault.age + plaintext README.md
  expect(bodyOf(treeCall)).not.toHaveProperty("base_tree")
  expect(bodyOf(commitCall).parents).toEqual([])
  expect(pathsIn(treeCall)).toEqual(["README.md", "vault.age"])
  expect(createRefCall.body.ref).toBe("refs/heads/data")
})
test("the data branch README names the decrypt command in plaintext", async () => {
  expect(readmeContentIn(treeCall)).toContain("age -d vault.age")
})
test("tokens are trimmed, and a classic token is named as wrong", async () => {
  // Review Focus 3
  expect(GithubStore.normalizeToken("  ghp_abc\n")).toBe("ghp_abc")
  const r = await storeWithToken("ghp_classic").ensureSetup().catch(e => e)
  expect(r.message).toMatch(/fine-grained/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/github-setup.test.ts`
Expected: FAIL — `ensureSetup` is not a function

- [ ] **Step 3: Implement the guards and the orphan-branch creation**

`ensureSetup` calls `GET /repos/{o}/{r}` once and checks, in order: 401 → `TokenError`; `private !== true` → `RepoPublicError`; `permissions.push !== true` → `TokenError`. Only then does it probe the `data` ref. `normalizeToken` trims; a `ghp_`/`gho_` prefix yields a `TokenError` whose message says a fine-grained token is required, because that is the mistake users will actually make.

The README body is fixed copy and must contain the literal `age -d vault.age`; spec §6.1 is explicit that a stranger finding this repo in ten years needs that sentence.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/github-setup.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: visibility/token guards and orphan data-branch init"
```

---

### Task 10: Integration test against a real private repo

**Files:**
- Create: `tests/integration/github.test.ts`
- Modify: `package.json` (add `test:integration` script)

**Interfaces:**
- Consumes: Tasks 7–9.
- Produces: nothing consumed by later tasks. This task's output is evidence.

- [ ] **Step 1: Write the failing test**

Gated on `EIGENHEIM_IT_TOKEN`; skips with an explicit reason when absent, so neither CI nor a contributor without repo-creation rights is blocked.

```ts
test("full lifecycle against a throwaway private repo", async () => {
  const repo = await createThrowawayPrivateRepo()      // afterAll deletes it
  try {
    expect(await store.ensureSetup()).toEqual({ ready: false, needsDataBranch: true })
    await store.initializeDataBranch({ armored: await encryptVault("", PASS) })
    const { sha } = await store.readHead()
    await store.write({ baseSha: sha, armored: await encryptVault("v1\n", PASS), message: "v1" })

    // the guarantee: a second write from the SAME base must be refused
    const stale = store.write({ baseSha: sha, armored: await encryptVault("v2\n", PASS), message: "v2" })
    await expect(stale).rejects.toThrow(StaleWriteError)

    // and nothing was lost
    expect(await decryptVault((await store.readHead()).armored, PASS)).toBe("v1\n")
    expect((await store.history(10)).length).toBe(2)
  } finally { await deleteRepo(repo) }
})

test("records which status GitHub actually returns for a non-fast-forward", async () => {
  // spec §12 lists this as deliberately unverified; this test resolves it
  console.log("observed non-fast-forward status:", observedStatus)
  expect([409, 422]).toContain(observedStatus)
})

test("a public repo is refused", async () => { /* create public throwaway, expect RepoPublicError */ })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `EIGENHEIM_IT_TOKEN=$GH_TOKEN npx vitest run tests/integration/github.test.ts`
Expected: FAIL — helpers not implemented

- [ ] **Step 3: Implement the repo-lifecycle helpers**

`createThrowawayPrivateRepo` posts to `/user/repos` with `private: true` and a name containing a random suffix; `afterAll` deletes it unconditionally, including on failure, so a crashed run cannot leave repos behind.

- [ ] **Step 4: Run it to verify it passes, and record the observed status in the spec**

Run: `EIGENHEIM_IT_TOKEN=$GH_TOKEN npx vitest run tests/integration/github.test.ts`
Expected: PASS. Then replace the §12 "409 or 422" open-question row in the spec with the observed value and the date.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test: real-repo integration proving stale writes are refused"
```

---

### Task 11: Sequential unlock

**Files:**
- Create: `src/session/unlock.ts`
- Test: `tests/unit/unlock.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 6, 7.
- Produces: `unlock(opts: { passphrase: string; local: LocalStore; onStage?: (s: Stage) => void }): Promise<Session>` where `Session = { text: string; baseSha: string; token: string | null; identity: string }` and `Stage = "vault" | "token" | "fetch"`.

- [ ] **Step 1: Write the failing test**

```ts
test("with a cached vault: decrypts the vault FIRST, token after", async () => {
  // spec §5.3 — the editor must open before the token work begins
  expect(stages).toEqual(["vault", "token"])
})
test("on a device's first unlock: token, then fetch, then vault", async () => {
  expect(stages).toEqual(["token", "fetch", "vault"])
})
test("never runs two scrypt operations concurrently", async () => {
  // spec §11/§5.4 — concurrency here peaks ~512 MiB and gets mobile tabs killed.
  // Invisible in the code and reads like a pointless pessimisation; pinned here.
  let live = 0, peak = 0
  const spy = instrumentScrypt(() => { peak = Math.max(peak, ++live) }, () => live--)
  await unlock({ passphrase: PASS, local })
  expect(peak).toBe(1)
})
test("a wrong passphrase fails before any network call", async () => {
  await expect(unlock({ passphrase: "wrong-but-long-enough-x", local })).rejects.toThrow(WrongPassphraseError)
  expect(fetchCalls).toEqual([])
})
test("opens a vault written in NFC when the passphrase is typed in NFD", async () => {
  // spec §5.5 rule 3 — the same passphrase, a different device's input method.
  // Forgiving on read; still byte-exact on write, so `age -d` keeps working.
  const nfc = "für-mein-eigenheim-passphrase"
  await seedCachedVault(await encryptVault("hallo\n", nfc))
  const s = await unlock({ passphrase: nfc.normalize("NFD"), local })
  expect(s.text).toBe("hallo\n")
})
test("the NFC/NFD fallback is tried in sequence, never concurrently", async () => {
  // the fallback must not reintroduce what Task 11's third test forbids:
  // three 128 MiB scrypt runs at once would be worse than the original bug
  expect(peakConcurrentScrypt).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/unlock.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `unlock` in `src/session/unlock.ts`**

Two branches on whether `getCachedVault()` returns a value, awaiting each stage strictly in sequence. Do not introduce `Promise.all` anywhere in this function; the third test exists to stop exactly that.

Passphrase candidates are tried in order — as typed (after `normalizePassphrase`), then `.normalize("NFC")`, then `.normalize("NFD")`, skipping duplicates — one at a time, awaiting each. The form that succeeded becomes the session's passphrase, so subsequent writes stay byte-identical to what `age -d` expects. Only after all candidates fail is `WrongPassphraseError` raised.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/unlock.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: strictly sequential offline-first unlock"
```

---

### Task 12: Background sync and the commit queue

**Files:**
- Create: `src/session/sync.ts`
- Test: `tests/unit/sync.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 6, 7, 8, 11.
- Produces:
  - `syncFromRemote(s: Session, store: GithubStore, local: LocalStore): Promise<{ updated: boolean; diverged: boolean }>`
  - `commit(s: Session, text: string, store: GithubStore, local: LocalStore): Promise<{ sha: string } | { conflict: Conflict }>` where `Conflict = { base: string; mine: string; theirs: string; merged: string; conflicted: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
test("a newer remote with a clean draft updates the editor", async () => {
  expect(await syncFromRemote(...)).toEqual({ updated: true, diverged: false })
})
test("a newer remote with a dirty draft never overwrites it", async () => {
  const r = await syncFromRemote(sessionWithDirtyDraft, ...)
  expect(r).toEqual({ updated: false, diverged: true })
  expect((await local.getDraft())!.armored).toBe(dirtyArmored)
})
test("commit on a stale base returns a three-way conflict, not an error", async () => {
  const r = await commit(session, "mine\n", staleRejectingStore, local)
  expect("conflict" in r).toBe(true)
  expect((r as any).conflict).toMatchObject({ base: "v0\n", mine: "mine\n", theirs: "v1\n" })
})
test("offline commits queue and replay in order on reconnect", async () => {
  // spec §13 — editing continues offline; commit queues and retries
})
test("a successful commit advances the cached vault and clears the draft", async () => { /* ... */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/sync.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/session/sync.ts`**

`commit` catches `StaleWriteError`, fetches `theirs` (head) and `base` (`readAt(draft.baseSha)`), runs `merge3`, and returns the conflict for the UI to resolve — it never auto-resolves and never discards (spec §6.5). The offline queue is a single pending commit in IndexedDB, replayed on `online`; a queued commit that then conflicts follows the same path.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/sync.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: background sync, conflict detection, offline commit queue"
```

---

### Task 13: Setup wizard

**Files:**
- Create: `src/ui/setup.ts`, `src/ui/views.css`
- Modify: `src/main.ts` (route to setup when no wrapped identity exists)
- Test: `tests/e2e/setup.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 3, 4, 9.
- Produces: `renderSetup(root: HTMLElement, deps: Deps): void`; on completion the app holds a `Session` and routes to the editor.

- [ ] **Step 1: Write the failing test**

Playwright against `vite preview` with GitHub's API stubbed via `page.route`.

```ts
test("the wizard refuses to finish until loss is acknowledged", async ({ page }) => {
  // spec §5.5 — the one irreversible property, not softened
  await expect(page.getByRole("button", { name: /continue/i })).toBeDisabled()
  await page.getByRole("checkbox", { name: /cannot be recovered/i }).check()
  await expect(page.getByRole("button", { name: /continue/i })).toBeEnabled()
})
test("a prefilled six-word passphrase is offered and accepted", async ({ page }) => { /* ... */ })
test("a short passphrase is rejected inline with the reason", async ({ page }) => { /* ... */ })
test("a public repo blocks setup and offers the settings link plus re-check", async ({ page }) => {
  // spec §13
  await expect(page.getByRole("link", { name: /repository settings/i })).toBeVisible()
  await expect(page.getByRole("button", { name: /check again/i })).toBeVisible()
})
test("the printable sheet carries the passphrase, the repo, and the literal recovery command", async ({ page }) => {
  const sheet = page.getByTestId("recovery-sheet")
  await expect(sheet).toContainText(generatedPassphrase)
  await expect(sheet).toContainText("test-owner/test-repo")
  await expect(sheet).toContainText("age -d vault.age")   // spec §5.5
})
test("completing setup creates the data branch and lands in the editor", async ({ page }) => { /* ... */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/e2e/setup.spec.ts`
Expected: FAIL — no setup view rendered

- [ ] **Step 3: Implement the wizard — six steps, exactly spec §9's order**

Welcome + acknowledgement; repo identity shown (never typed, from Task 1); token walkthrough with the paste field and `ensureSetup` validation; passphrase with generation and inline floor feedback and re-type confirmation; printable sheet; initialise and enter the editor. The repo-public and bad-token states render inline where the problem is, with the action that fixes them.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test tests/e2e/setup.spec.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: setup wizard with acknowledgement, floor and visibility guard"
```

---

### Task 14: Unlock view and editor

**Files:**
- Create: `src/ui/unlock.ts`, `src/ui/editor.ts`
- Modify: `src/main.ts`
- Test: `tests/e2e/editor.spec.ts`

**Interfaces:**
- Consumes: Tasks 11, 12.
- Produces: `renderUnlock`, `renderEditor`.

- [ ] **Step 1: Write the failing test**

```ts
test("unlock shows progress and opens the editor on the cached vault", async ({ page }) => { /* ... */ })
test("typing autosaves locally without any network call", async ({ page }) => {
  // spec §2 save model: autosave is local only; GitHub writes are explicit
  expect(apiCalls.filter(c => c.method !== "GET")).toEqual([])
})
test("the state indicator distinguishes local-only from committed", async ({ page }) => { /* ... */ })
test("Ctrl+S commits and the indicator becomes committed", async ({ page }) => { /* ... */ })
test("a reload restores the uncommitted draft, not the committed version", async ({ page }) => { /* ... */ })
test("the editor is monospace and fills the viewport", async ({ page }) => { /* ... */ })
test("going offline shows a banner and editing continues", async ({ page }) => { /* spec §13 */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/e2e/editor.spec.ts`
Expected: FAIL — no editor view

- [ ] **Step 3: Implement the two views**

A single full-viewport `<textarea>`, monospace, no competing chrome (spec §8). Autosave debounced to `draft.age` via Task 6; ⌘/Ctrl+S calls `commit` from Task 12. A persistent indicator with three states — committed, local-only, offline.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test tests/e2e/editor.spec.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: unlock view and autosaving monospace editor"
```

---

### Task 15: Conflict view

**Files:**
- Create: `src/ui/conflict.ts`
- Test: `tests/e2e/conflict.spec.ts`

**Interfaces:**
- Consumes: Task 12's `Conflict`.
- Produces: `renderConflict(root, conflict, onResolve: (text: string) => void): void`

- [ ] **Step 1: Write the failing test**

```ts
test("a stale commit opens the conflict view showing all three versions", async ({ page }) => { /* ... */ })
test("offers merged, mine and theirs, and nothing is discarded unseen", async ({ page }) => {
  // spec §6.5
})
test("choosing a resolution commits it on the new base and returns to the editor", async ({ page }) => { /* ... */ })
test("conflict markers are visible in the merged text", async ({ page }) => { /* ... */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/e2e/conflict.spec.ts`
Expected: FAIL — no conflict view

- [ ] **Step 3: Implement `renderConflict`**

Three labelled panes plus the editable merged result. Resolving re-commits against the new head; if that also conflicts, the same view reopens with fresh inputs rather than failing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test tests/e2e/conflict.spec.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: three-way conflict resolution view"
```

---

### Task 16: History view

**Files:**
- Create: `src/ui/history.ts`
- Test: `tests/e2e/history.spec.ts`

**Interfaces:**
- Consumes: Tasks 7 (`history`, `readAt`), 2, 5.
- Produces: `renderHistory(root, deps): void`

- [ ] **Step 1: Write the failing test**

```ts
test("lists commits newest first with dates", async ({ page }) => { /* ... */ })
test("selecting a version decrypts and shows it with a diff against current", async ({ page }) => { /* ... */ })
test("restoring writes a NEW commit and never rewrites history", async ({ page }) => {
  // spec §6.6
  expect(apiCalls).not.toContainEqual(expect.objectContaining({ body: expect.objectContaining({ force: true }) }))
})
test("a version that will not decrypt is reported without blanking the view", async ({ page }) => { /* spec §13 */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/e2e/history.spec.ts`
Expected: FAIL — no history view

- [ ] **Step 3: Implement `renderHistory`**

Fetch the commit list lazily (the spec sets no retention bound, so page it rather than loading all of history), decrypt a version only when selected, and render the diff against current using the same line-splitting rule as Task 5 so CRLF documents do not show every line as changed. Restore calls `commit` from Task 12 with the restored text — a normal forward commit.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test tests/e2e/history.spec.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: history browsing with restore-as-new-commit"
```

---

### Task 17: Settings — device transfer, token, passphrase change, build hash

**Files:**
- Create: `src/ui/settings.ts`
- Test: `tests/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 4, 8, 12; `BUILD_HASH` from Task 1.
- Produces: `renderSettings(root, deps): void`

- [ ] **Step 1: Write the failing test**

```ts
test("shows a QR encoding owner, repo and token for a second device", async ({ page }) => {
  // spec §9 second-device flow
})
test("the QR is behind an explicit reveal, not shown by default", async ({ page }) => {
  // it is a bearer credential on screen
})
test("a replaced token is validated before being stored", async ({ page }) => { /* ... */ })
test("changing the passphrase re-encrypts, re-wraps the identity, and commits", async ({ page }) => { /* ... */ })
test("the passphrase-change screen states that old commits stay readable with the old passphrase", async ({ page }) => {
  // spec §13 — stated honestly, not hidden
  await expect(page.getByText(/earlier (versions|commits).*old passphrase/i)).toBeVisible()
})
test("displays the running build hash", async ({ page }) => { /* spec §10.2 */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/e2e/settings.spec.ts`
Expected: FAIL — no settings view

- [ ] **Step 3: Implement `renderSettings`**

QR via `qrcode` rendering `{owner, repo, token}` as JSON, behind a reveal. Passphrase change: re-encrypt the current text with the new passphrase, re-wrap the device identity, commit, then update the cache — in that order, so a failure mid-way leaves the old passphrase working rather than bricking the vault.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test tests/e2e/settings.spec.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: settings with device transfer, token and passphrase rotation"
```

---

### Task 18: Second-device onboarding

**Files:**
- Modify: `src/ui/setup.ts`
- Test: `tests/e2e/second-device.spec.ts`

**Interfaces:**
- Consumes: Tasks 13, 17.
- Produces: a branch in the setup wizard for "this vault already exists".

- [ ] **Step 1: Write the failing test**

```ts
test("offers scan-or-paste when the repo already has a data branch", async ({ page }) => { /* ... */ })
test("a pasted transfer payload leaves only the passphrase to enter", async ({ page }) => {
  // spec §9 — the point of the QR
})
test("falls back to manual paste where BarcodeDetector is unavailable", async ({ page }) => { /* ... */ })
test("a malformed transfer payload is rejected with a usable message", async ({ page }) => { /* ... */ })
test("after transfer, the second device decrypts the existing vault", async ({ page }) => { /* ... */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/e2e/second-device.spec.ts`
Expected: FAIL — no second-device branch

- [ ] **Step 3: Implement the branch**

Detect an existing `data` branch during setup and offer transfer instead of initialisation. Use `BarcodeDetector` when present, else the paste field — never block on camera availability.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test tests/e2e/second-device.spec.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: second-device onboarding by QR or paste"
```

---

### Task 19: Recovery surfaces for every failure state

**Files:**
- Create: `src/ui/errors.ts`
- Modify: `src/main.ts`
- Test: `tests/e2e/recovery.spec.ts`

**Interfaces:**
- Consumes: `src/store/errors.ts` from Task 7.
- Produces: `renderFailure(root, err: unknown, deps): void` — one view mapping each spec §13 row to its affordance.

- [ ] **Step 1: Write the failing test**

One test per spec §13 row; the undecryptable-vault row is the one that must not become a blank screen.

```ts
test("an undecryptable vault offers ciphertext download, history, and retry", async ({ page }) => {
  for (const name of [/download/i, /history/i, /try again/i]) {
    await expect(page.getByRole("button", { name })).toBeVisible()
  }
})
test("an expired token offers the walkthrough and a create-token link", async ({ page }) => { /* ... */ })
test("a missing data branch offers to create it inline", async ({ page }) => { /* ... */ })
test("no failure path renders an empty view", async ({ page }) => {
  // asserts a visible way forward for every error class, spec §13
  for (const err of ALL_ERROR_CLASSES) {
    expect(await actionCountFor(err)).toBeGreaterThan(0)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/e2e/recovery.spec.ts`
Expected: FAIL — no failure view

- [ ] **Step 3: Implement `renderFailure`**

A single exhaustive `switch` over the error classes; the default branch still renders the generic actions (download ciphertext, open history, retry) so an unanticipated error cannot produce a dead end.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test tests/e2e/recovery.spec.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: recovery affordances for every failure state"
```

---

### Task 20: PWA with approval-gated updates

**Files:**
- Create: `public/sw.js`, `public/manifest.webmanifest`
- Modify: `index.html`, `src/main.ts`
- Test: `tests/e2e/pwa.spec.ts`

**Interfaces:**
- Consumes: Task 1's `BUILD_HASH`.
- Produces: a registered service worker; an update prompt.

- [ ] **Step 1: Write the failing test**

```ts
test("the app shell loads with the network offline after one visit", async ({ page, context }) => { /* ... */ })
test("a new build does NOT activate silently; it asks first", async ({ page }) => {
  // spec §10.1 — the mitigation against a swapped bundle
  await expect(page.getByRole("button", { name: /update/i })).toBeVisible()
  expect(await runningBuildHash(page)).toBe(OLD_HASH)
})
test("accepting the prompt activates the new build", async ({ page }) => { /* ... */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/e2e/pwa.spec.ts`
Expected: FAIL — no service worker registered

- [ ] **Step 3: Implement the service worker**

Precache the shell; on `install` do **not** `skipWaiting`. Surface the waiting worker to the UI and call `skipWaiting` only on the user's click (spec §10.1).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test tests/e2e/pwa.spec.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: offline PWA shell with user-approved updates"
```

---

### Task 21: CI — unit, real-age interop, and published build hash

**Files:**
- Create: `.github/workflows/ci.yml`, `scripts/publish-build-hash.sh`
- Test: the workflow itself, verified by a real run.

**Interfaces:**
- Consumes: everything.
- Produces: `BUILD_HASH` published into the repo (spec §10.2).

- [ ] **Step 1: Write the failing check**

Add an `interop` job that builds a vault file with this library, downloads the official `age` binary (pinned v1.3.2), and decrypts it with the passphrase from a step output. It must fail loudly if `age -d` cannot read our output — this is the job defending spec §1's central promise, so it runs on every push, not nightly.

- [ ] **Step 2: Run it to verify it fails**

Push the branch with the interop job wired to a deliberately corrupted file; confirm the job fails.
Expected: FAIL in the `interop` job at `age -d`

- [ ] **Step 3: Implement the workflow and the hash publication**

Jobs: `unit` (vitest), `interop` (as above), `e2e` (Playwright), `build` (computes the bundle's SHA-256, writes it to `build-hash.txt`, commits it on `main` only). No test step may require `EIGENHEIM_IT_TOKEN`; the integration suite stays opt-in (Task 10).

- [ ] **Step 4: Run it to verify it passes**

Restore the uncorrupted file and confirm all four jobs pass on a real run.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "ci: unit, e2e, real-age interop and build-hash publication"
```

---

### Task 22: Onboarding assets and the Deploy button

**Files:**
- Create: `README.md`, `scripts/capture-screenshots.ts`, `docs/onboarding/*.png`
- Test: `tests/unit/readme.test.ts`

**Interfaces:**
- Consumes: Task 1 (repo identity), Task 13 (the walkthrough's steps).
- Produces: the public template's front door.

- [ ] **Step 1: Write the failing test**

```ts
test("the README's Deploy button points at this repo", () => {
  expect(README).toContain("https://vercel.com/new/clone?repository-url=")
})
test("every screenshot the walkthrough references exists", () => {
  // a missing image is invisible in review and fatal to a non-technical user
  for (const src of walkthroughImageSources()) expect(existsSync(`docs/onboarding/${src}`)).toBe(true)
})
test("the README states the trust model including what is NOT protected", () => {
  // spec §3, §10 — stated plainly, not buried
  expect(README).toMatch(/hostile|malicious code|first load/i)
})
test("the README gives the offline recovery command", () => {
  expect(README).toContain("age -d vault.age")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/readme.test.ts`
Expected: FAIL — `README.md` does not exist

- [ ] **Step 3: Write the README and capture the screenshots**

`scripts/capture-screenshots.ts` drives Playwright against a real logged-in GitHub session through the fine-grained-token UI, writing numbered PNGs to `docs/onboarding/`. The README carries the Deploy button, the trust model (including the §3 non-goal, in the user's words), and the recovery command.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/readme.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: README with Deploy button, trust model and token walkthrough"
```

---

### Task 23: Acceptance run

**Files:**
- Create: `docs/acceptance-2026-10-14.md`

**Interfaces:**
- Consumes: everything.
- Produces: the evidence that spec §14 is satisfied.

- [ ] **Step 1: Walk spec §14's eleven steps for real**

A fresh browser profile and a GitHub account that has never seen the project. Capture output or a screenshot for each step. Step 6 — downloading the blob and decrypting it with the official `age` CLI using only the passphrase — is the one that matters; capture its terminal output verbatim.

- [ ] **Step 2: Record results**

Write `docs/acceptance-2026-10-14.md` mapping each of the eleven steps to its evidence, and list separately anything that could not be verified. An open item is acceptable; implying coverage that does not exist is not.

- [ ] **Step 3: Fix anything the run surfaced**

Each failure gets a reproducing test in the owning task's file, then the fix, then the full suite.

- [ ] **Step 4: Re-run the affected steps and confirm**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: acceptance run against spec §14"
```
