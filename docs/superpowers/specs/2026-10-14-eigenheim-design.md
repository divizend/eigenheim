# eigenheim — design

**Date:** 2026-10-14
**Status:** approved design, pending implementation plan

## 1. Purpose

A personal data store where the hosting provider and the storage provider are
both untrusted. Vercel serves static files and never sees data. GitHub stores
ciphertext and never sees plaintext. All encryption and decryption happens in
the browser.

What the user gets, after setup, is a single monospace text file at their own
domain (`home.nalenz.org`), which they can edit.

The goal is a real step toward digital sovereignty for a non-technical user —
not a demo. The decisive test is not that the app works, but that the data
outlives the app: the stored file is a standard [age](https://age-encryption.org)
file, decryptable forever with `age -d vault.age` and nothing else.

### Intent, as agreed

- **Audience:** a non-technical internet user. First deployment is the author's
  own, at `home.nalenz.org`.
- **One-click deployable from day one** — onboarding is part of v1, not a
  follow-up.
- **Success:** a stranger can deploy their own instance, store text in it, and
  recover that text offline with the `age` CLI alone.

## 2. Decisions taken, and by whom

These were settled during brainstorming and are not open for silent revision
during implementation. Changing any of them is a spec change.

| Decision | Choice | Decided by |
|---|---|---|
| GitHub credential | Fine-grained PAT, created by the user following a screenshot walkthrough, pasted into the app | operator |
| Backend | None. Pure static SPA. No serverless function anywhere. | follows from the above |
| Save model | Autosave to encrypted local draft; explicit commit to GitHub; full history browsing | operator |
| Devices | Multi-device, repo stays **private**, token moved to a second device by QR | operator |
| Key recovery | **Passphrase only. No recovery key, no Shamir, no second door.** Strength floor enforced. | operator |
| Encrypted-side shape | One file, `vault.age`. Git provides history. | operator |
| Project scope | One project, one spec (not split into sub-projects) | operator |
| scrypt work factor | logN=17, not age's default of 18 — memory-bound on phones | author, §5.4 |
| Framework | None. Vite + plain TypeScript. | author, §4 |

## 3. Non-goals

Explicitly out of scope. Each is a deliberate exclusion, not an oversight.

- **Multiple documents, folders, attachments.** One text file. Growing later is
  additive (`vault/<name>.age` plus an encrypted index), not a rewrite.
- **Sharing with other people.** Single-owner store.
- **Any recovery mechanism other than the passphrase.** Rejected explicitly.
- **WebAuthn/passkey identities.** `age-encryption` supports them, and they
  would be a natural unlock improvement — but they constitute a second door to
  the vault, which contradicts §2. Noted here so a future reader knows it was
  considered and ruled out, not missed.
- **Full-text search across history.**
- **Protection against a hostile host serving malicious code on first load.**
  This is the honest limit of browser-delivered cryptography. Mitigated three
  ways in §10; not solved. Stated to the user in the app, not buried here.

## 4. Architecture

A static single-page app in three layers. No server-side code exists in this
project — not one function.

```
┌─ app (L3) ──────────────────────────────────────────────┐
│  setup wizard · unlock · editor · conflict · history    │
│  Vite + TypeScript, no framework                        │
└───────────────┬─────────────────────────┬───────────────┘
                │                         │
┌─ vault-core (L1) ──────────┐  ┌─ github-store (L2) ─────┐
│ age encrypt/decrypt        │  │ read / write / history  │
│ passphrase strength        │  │ conditional writes      │
│ diff3 merge                │  │ setup + guards          │
│ no DOM, no network         │  │ no DOM                  │
└────────────────────────────┘  └─────────────────────────┘
```

**No framework** is a security decision, not minimalism for its own sake. The
integrity of this bundle *is* the product (§10), so every dependency is attack
surface on the one component that must be trustworthy. The UI is a textarea and
three views; React would add far more risk than it removes. Total runtime
dependencies: `age-encryption`, a small pinned diff3, and `qrcode` — plus two
bundled word lists (diceware, common passwords) which are data, not code.

## 5. Cryptography

### 5.1 One library, three files

Everything is a standard age file, produced by
[`age-encryption`](https://github.com/FiloSottile/typage) (typage) — pure JS via
`@noble`, no WASM. There is exactly one crypto library in the project.

| File | Lives | Encrypted to | Why |
|---|---|---|---|
| `vault.age` | GitHub `data` branch | **passphrase** (age scrypt) | so `age -d vault.age` works with the passphrase and nothing else |
| `device.age` | IndexedDB | **passphrase** (age scrypt) | wraps the device identity's private key |
| `draft.age`, `token.age` | IndexedDB | **device identity** (X25519) | no KDF, so per-keystroke autosave is fast |

The device identity is generated locally at setup and never leaves the device.
It is **not** a second door to the vault: `vault.age` is openable only by the
passphrase. The device key only protects local-only artifacts, and is itself
passphrase-wrapped. So the single-secret property of §2 holds: one passphrase,
one door, everywhere.

### 5.2 Vault format

```ts
const e = new Encrypter()
e.setPassphrase(passphrase)
e.setScryptWorkFactor(17)                                  // §5.4
const armored = armor.encode(await e.encrypt(plaintext))   // -> vault.age
```

ASCII-armored, not raw binary. Armor costs ~33% size and buys a real
property: the vault is copy-pasteable out of GitHub's web UI and straight into
`age -d`. For a file of this size the cost is irrelevant and the escape hatch
is worth more.

### 5.3 Unlock is offline-first, and strictly sequential

Two scrypt runs are structurally unavoidable: one for `vault.age` (it must be a
passphrase-only age file, §5.1) and one for `device.age` (local storage must be
passphrase-protected to the same standard, or device theft attacks the weaker of
the two). They **must not** run concurrently — see §5.4 for why.

The last-known `vault.age` **ciphertext** and its commit SHA are cached in
IndexedDB; caching ciphertext is safe by construction. Unlock then runs, in a
Web Worker, in this order:

1. decrypt the cached `vault.age` → **open the editor immediately**
2. then decrypt `device.age` → token, in the background

The ordering matters: the token is needed only to *sync and commit*, never to
read. So perceived unlock cost is **one** scrypt even though two run, and the
user is reading and editing while the second finishes. **Unlock requires no
network at all**, which the PWA story needs anyway.

**First unlock on a new device** has no cached ciphertext, so the order inverts
(token first, then fetch, then vault) and the user waits for both. That happens
once per device, with a progress indicator that says so.

**Background sync** compares the cached SHA against `data` head. If they differ
and the local draft is unmodified, the editor updates to the newer version with
a brief notice. If the draft *is* modified, nothing is overwritten — the
divergence is carried to commit time and handled as a conflict (§6.5).

### 5.4 Work factor: logN=17

age's scrypt uses `r=8, p=1`, so memory is `128·r·N` bytes — **256 MiB at
logN=18**, age's CLI default. That default was chosen for desktops. Two
concurrent runs would peak near 512 MiB, and even one is close to the limit at
which mobile Safari discards a tab. A failed unlock means a user cannot reach
their own data, which is the most damaging outcome this design has; it is not
worth trading against a KDF margin.

**logN=17 (128 MiB, measured 407 ms encrypt / 402 ms decrypt here, ~1.5–2 s on
a phone)** is therefore the write factor, combined with the sequential ordering
in §5.3 so peak memory is one run's worth.

Interop is unaffected: the work factor is recorded in the age header, so every
`age` implementation reads whatever was written, and files written by `age -p`
at logN=18 still open here. (An earlier draft of this spec justified logN=18 on
interop grounds — that was simply wrong; nothing about interop depends on
matching the CLI default.)

The security cost is one halving of attacker cost versus logN=18, against a
default passphrase of ~77 bits where the KDF is irrelevant anyway, and a
floor of ≥20 characters (§5.5) for custom ones. One constant, `SCRYPT_LOG_N`,
in `vault-core`. Measured values for both factors are in §12.

### 5.5 Passphrase floor

Setup prefills a generated 6-word diceware passphrase (~77 bits, memorable,
from a bundled ≥7776-word list using `crypto.getRandomValues`). The user may
replace it with anything that is **≥20 characters** and **not in a bundled list
of the 10 000 most common passwords**. No scoring library (zxcvbn is ~400 KB —
unacceptable per §4); the rule is a rule the user can be told in one sentence.

**Passphrases are full Unicode. There is no character-set restriction.**
Umlauts, CJK, emoji — all accepted. This is not a concession; it is the only
correct behaviour, and it costs nothing: `age` and `age-encryption` both feed
the raw UTF-8 bytes of the passphrase to scrypt, so the two agree byte-for-byte
with no special handling. Confirmed live (§12) with a passphrase mixing German
umlauts, Japanese and an emoji — written in the browser, decrypted by the
official CLI.

Three rules follow, and they are the whole of the passphrase handling:

1. **Length is counted in codepoints**, not UTF-16 units or bytes
   (`[...p].length`), so an emoji counts once and a 20-character Japanese
   passphrase is not rejected for being "too short" or accepted for being
   "long enough" by accident.
2. **Never normalise on write.** The passphrase is encoded UTF-8 and passed
   through untouched, exactly as `age` does. Normalising would mean a passphrase
   that opens the vault in this app but fails under `age -d` — breaking the one
   guarantee §1 rests on.
3. **Be forgiving on read.** A visually identical passphrase can carry two
   encodings (`für` is `66c3bc72` in NFC, `6675cc8872` in NFD) depending on the
   device's input method. Unlock therefore tries the passphrase as typed, then
   its NFC form, then its NFD form, before reporting failure. Writes always use
   the form that worked, so CLI parity is preserved. This is a genuine
   cross-device hazard shared by every passphrase system; it is cheap to absorb
   here and expensive to discover later.

**Surrounding whitespace is stripped**, at setup and at unlock alike. A
passphrase pasted from a notes app with a trailing newline is otherwise
unreproducible by hand in either the app or the CLI — and with no recovery key
(§2) that is permanent, total loss. The cost is that a passphrase cannot begin
or end with a space, which is not a cost.

The passphrase must be re-typed to confirm before setup completes. Setup then
offers a printable sheet carrying the passphrase, the repo name, and the literal
`age -d vault.age` command. That sheet is backup hygiene for the one secret —
**not** a second door.

The user must actively acknowledge, in words, that a forgotten passphrase means
permanent loss. This is the one irreversible property of the system and it is
not softened.

## 6. Storage

### 6.1 Repo layout

One repo — the one the Deploy button creates. Two branches.

- **`main`** — app source, `vercel.json`, docs.
- **`data`** — orphan branch (no shared history with `main`), containing:
  - `vault.age` — the encrypted file.
  - `README.md` — **plaintext**, on purpose. It states that this is an
    age-encrypted file and gives the exact command to decrypt it. Someone
    finding this repo in ten years, with no memory of this app, needs that
    sentence.

Vercel deploys **every** branch push by default, so without configuration every
single save would trigger a preview build. `vercel.json` prevents it:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "git": { "deploymentEnabled": { "data": false } }
}
```

### 6.2 Why the git data API, not the contents API

`github-store` uses the low-level git data API (blobs/trees/commits/refs). The
contents API caps reads at 1 MB; the blobs API allows up to 100 MB, and the
git API gives a proper parent-commit handle, which §6.4 needs.

### 6.3 Read

```
GET /repos/{o}/{r}/git/ref/heads/data      -> commit sha
GET /repos/{o}/{r}/git/commits/{sha}       -> tree sha
GET /repos/{o}/{r}/git/trees/{tree}        -> blob sha for vault.age
GET /repos/{o}/{r}/git/blobs/{blob}        -> base64 content
```

### 6.4 Write — conditional, never clobbering

```
POST  /repos/{o}/{r}/git/blobs             content = armored vault
POST  /repos/{o}/{r}/git/trees             base_tree = current tree
POST  /repos/{o}/{r}/git/commits           parents = [baseSha]
PATCH /repos/{o}/{r}/git/refs/heads/data   { sha, force: false }
```

`force: false` is the whole conflict-safety mechanism. GitHub's documentation:
*"Indicates whether to force the update or to make sure the update is a
fast-forward update. Leaving this out or setting it to false will make sure
you're not overwriting work."* A write based on a stale commit is therefore
**rejected by the server**, never merged and never silently applied.

The rejection surfaces as `StaleWriteError`. GitHub documents 409 and 422 as
possible statuses for this endpoint but does not say which applies to a
non-fast-forward; the implementation treats **both** as stale, and an
integration test (§11) pins the actual observed behaviour.

### 6.5 Conflict resolution

On `StaleWriteError` the client holds everything needed for a true three-way
merge, which is the reason §2 chose a single file:

- **base** — `readAt(draftBaseSha)`, the version the draft was built on
- **theirs** — current `data` head
- **mine** — the local draft

All three are decrypted locally and run through diff3. The user is shown the
merged text with conflict markers and chooses merged / mine / theirs. Nothing
is discarded without being shown first. There is no path on which an edit is
lost.

### 6.6 History

`GET /repos/{o}/{r}/commits?sha=data&per_page=N` lists versions; `readAt(sha)`
fetches one; it is decrypted in-browser, diffed against current, and
restorable as a new commit (never a history rewrite).

### 6.7 Token

A fine-grained PAT, scoped to **only** the deployed repo, with
**`Contents: Read and write`** (GitHub forces `Metadata: Read` alongside it,
which `ensureSetup` also needs). One permission on one repo — which is what
makes the §9 walkthrough short enough for a non-technical user to follow.

## 7. Local persistence

| Item | Storage | At rest |
|---|---|---|
| Passphrase | none — memory only, for the session | n/a |
| Device identity private key | IndexedDB `device.age` | age scrypt, passphrase |
| GitHub token | IndexedDB `token.age` | age, device identity |
| Draft + base SHA | IndexedDB `draft.age` | age, device identity |
| Cached vault ciphertext + SHA | IndexedDB, as-is | already ciphertext |
| Repo owner/name | build-time constant | not secret |

A stolen device yields no plaintext and no write access to the repo.

## 8. Application surfaces

- **Setup wizard** — §9.
- **Unlock** — passphrase only. Progress indicator during scrypt (~0.4 s
  desktop, ~1.5–2 s phone; roughly double on a device's very first unlock, §5.3).
- **Editor** — full-viewport monospace textarea. Autosave to `draft.age` on a
  short debounce. Explicit ⌘/Ctrl+S commits. Persistent indicator of
  local-vs-committed state. Keyboard-first; no chrome competing with the text.
- **Conflict** — §6.5.
- **History** — commit list, view any version, diff, restore.
- **Settings** — show device-transfer QR, replace token, change passphrase
  (re-encrypts and commits; §13), build hash (§10).
- **PWA** — installable; service worker caches the shell for offline use and
  for §10.

## 9. One-click onboarding

1. **Deploy** — a "Deploy to Vercel" button in the public template's README
   creates the user's own repo and deploys it. Whether Vercel's project-creation
   flow offers a visibility choice at this point is **not documented** and must
   not be relied on (§12). The design therefore does not depend on it: the repo
   must end up private, and §13's guard is the mechanism that guarantees it —
   the app refuses to store anything until `GET /repos/{o}/{r}` reports
   `private: true`, walking the user to the setting if needed.
2. **The app knows its own repo.** Vercel exposes `VERCEL_GIT_REPO_OWNER` and
   `VERCEL_GIT_REPO_SLUG` at build time; Vite bakes them in via `define`. The
   user is never asked to type their repo name.
3. **Token walkthrough** — a step-by-step guide *with real screenshots* of
   GitHub's fine-grained-token UI, ending in a paste field. Validated
   immediately by `GET /repos/{o}/{r}`: existence, `private === true`, and push
   permission.
4. **Passphrase** — §5.5.
5. **Initialize** — create the orphan `data` branch: blobs for `vault.age`
   (encrypted empty document) and the plaintext `README.md`, a tree with no
   `base_tree`, a commit with no parents, then `POST git/refs` for
   `refs/heads/data`.
6. **Editor.**

**Second device:** the URL and therefore step 2 are already correct. Settings on
device 1 shows a QR encoding `{owner, repo, token}`; device 2 scans it
(`BarcodeDetector` where available, manual paste otherwise) and asks only for
the passphrase.

**Screenshots** are a maintained asset: they will drift as GitHub changes its
UI. They are captured with Playwright against a real GitHub session and stored
in `docs/onboarding/`, so regenerating them is a scripted task rather than an
archaeology project.

## 10. Supply-chain integrity

Vercel serves the JavaScript that does the decryption. A compromised Vercel
account could serve JavaScript that exfiltrates the passphrase. This is
unavoidable for any browser-delivered crypto app and is listed as a non-goal in
§3. Three mitigations, all shipped:

1. **The service worker pins the code.** It serves the cached shell and
   installs an update only on explicit user approval, so a swapped bundle
   cannot take effect silently on a returning user.
2. **The build hash is published.** CI computes the SHA-256 of the built bundle
   and commits it to the repo; the app footer displays the hash it is actually
   running. A mismatch between footer and repo is visible to the user.
3. **The data does not depend on the app.** `vault.age` is a standard age file.
   If this app ever becomes untrustworthy, the user's data is unaffected and
   still readable with `age`.

The app states this limit to the user in plain language rather than implying
protection it does not have.

## 11. Testing

- **Unit (vitest)** — vault round-trip; armor; passphrase floor (including
  common-password rejection); diff3 cases (clean merge, conflicting hunks,
  one-sided edits, empty base).
- **Interop fixtures, committed to the repo** — files produced by the real
  `age` CLI v1.3.2 that `vault-core` must decrypt, including one at logN=18 to
  prove a differing work factor is read correctly. Locks the inbound direction
  against library drift.
- **A regression test asserting the two scrypt runs are never concurrent.**
  §5.4 exists because concurrent runs peak near 512 MiB and can get a mobile
  tab discarded — a failure that costs a user access to their own data. That
  constraint is invisible in the code and would read like a pointless
  pessimisation to a future optimiser, so it is pinned by a test rather than a
  comment.
- **Interop in CI** — a job that downloads the official `age` binary and
  decrypts a file this library produced. Locks the outbound direction. This is
  the test that defends the central promise of §1, so it runs on every commit.
- **Integration against a real private throwaway GitHub repo** — setup
  including orphan-branch creation; read; write; **a deliberately forced
  concurrent write proving the stale one is rejected and nothing is lost**;
  history; restore; visibility guard.
- **E2E (Playwright)** — full setup wizard against a mocked GitHub API;
  edit/commit/reload; conflict UI; history restore; offline edit then commit on
  reconnect.

## 12. Verified facts this design rests on

Each was confirmed live on 2026-10-14 rather than assumed.

| Claim | Evidence |
|---|---|
| The browser can read *and write* GitHub with no backend | `OPTIONS api.github.com/.../contents/...` → `access-control-allow-origin: *`, `access-control-allow-methods: GET, POST, PATCH, PUT, DELETE`, `Authorization` in allowed headers |
| An OAuth-based design would have needed a backend | `github.com/login/oauth/access_token` returns no CORS headers — a reason the §2 token choice costs nothing architecturally |
| `age-encryption` exposes passphrase encryption | v0.3.1 `Encrypter.setPassphrase` / `setScryptWorkFactor` / `Decrypter.addPassphrase`, pure JS via `@noble` |
| Outbound interop is real | official `age` v1.3.2 CLI decrypted typage's armored output |
| Inbound interop is real | typage decrypted `age -p -a` output; header read `scrypt <salt> 18` |
| Unlock cost and memory, measured not estimated | pure JS, this hardware: logN=16 → 64 MiB / 284 ms enc / 227 ms dec; **logN=17 → 128 MiB / 407 ms / 402 ms**; logN=18 → 256 MiB / 802 ms / 886 ms |
| The chosen non-default work factor stays interoperable | official `age` v1.3.2 CLI decrypted a logN=17 armored file written by typage |
| **Unicode passphrases need no special handling** | passphrase `schlüsselwort-für-mein-eigenheim-日本語-🔐` (38 codepoints, 49 UTF-8 bytes) encrypted by typage, decrypted by the official CLI — both feed raw UTF-8 to scrypt |
| Normalisation is a real cross-device hazard, not an age one | `für` is `66c3bc72` (NFC) vs `6675cc8872` (NFD); `normalize("NFC")` reconciles them — hence §5.5's read-side fallback |
| Stale writes cannot clobber | GitHub docs, `force` parameter, default `false` |
| Data commits would otherwise trigger builds | Vercel docs: *"Vercel for GitHub will deploy every push by default. This includes pushes and pull requests made to branches."* |
| The fix for that is valid config | Vercel docs confirm `git.deploymentEnabled` as an object of branch → boolean, default `true` |

Two things were deliberately **not** confirmed, and the design is built so that
neither can break it:

| Open question | How the design absorbs it |
|---|---|
| Whether Vercel's deploy flow lets the user create the repo as private | Not documented anywhere in Vercel's deploy-button or GitHub-integration docs. Irrelevant by construction: §13's visibility guard blocks until the repo is private, whichever way it got there. |
| Whether a rejected non-fast-forward returns 409 or 422 | GitHub documents both as possible for the endpoint without saying which applies. The client treats both as `StaleWriteError`; an integration test (§11) records the real behaviour. |

## 13. Error handling — every state has a visible way forward

No state may dead-end. For each failure, the app shows the cause *where the
problem is visible* and an action that resolves it.

| Failure | What the user sees |
|---|---|
| Invalid/expired token | Inline error, the §9 walkthrough again, a direct link to create a replacement |
| **Repo is public** | Blocking warning (ciphertext should not be world-readable and offline-grindable), a direct link to the repo's settings, and a re-check button |
| `data` branch missing | Offer to create it, inline |
| Stale write | Conflict view (§6.5) |
| Vault will not decrypt | Not a blank screen: offer to download the raw ciphertext, browse history for an earlier version, or retry with a different passphrase |
| Offline | Banner; editing continues; commit queues and retries on reconnect |
| Passphrase change | Re-encrypts and commits a new version. Stated honestly: **earlier commits remain decryptable with the old passphrase**, because git history is immutable. A user who needs that history gone must delete the repo. |

## 14. Definition of Done

One acceptance script, run for real, with captured output for every step. A
stranger — simulated in a fresh browser profile, with a GitHub account that has
never seen this project — can:

1. Click Deploy and get their own instance on a Vercel URL.
2. Follow the screenshot walkthrough, create a fine-grained token, and paste it.
3. Set a passphrase that passes the floor, re-type it, print the sheet.
4. Type text, commit, reload the page, and see the text.
5. Confirm on github.com that the repo contains only an armored age blob and a
   plaintext README.
6. **Download that blob and decrypt it with the official `age` CLI using only
   the passphrase.**
7. Open the same vault on a second device via QR, entering only the passphrase.
8. Edit on both devices concurrently, hit the conflict, and resolve it with
   nothing lost.
9. Go offline, edit, reconnect, and commit.
10. Restore an earlier version from history.
11. Point `home.nalenz.org` at the deployment and repeat step 4 there.

Step 6 is the one that matters most: it is the difference between sovereignty
and a slogan.
