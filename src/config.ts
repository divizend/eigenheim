// Project-wide constants and build-time repo/build identity.
//
// SCRYPT_LOG_N, VAULT_PATH and DATA_BRANCH are spec-mandated literals (design
// spec §5.4, §6.1) kept here as the single source of truth so every later
// module imports them rather than re-stating them.
//
// repoOwner()/repoSlug()/BUILD_COMMIT read values injected by vite.config.ts's
// `define` at build time (see that file) — __REPO_OWNER__, __REPO_SLUG__ and
// __BUILD_COMMIT__ are replaced with string literals before this module is
// ever evaluated, so these are never undefined at runtime.
declare const __REPO_OWNER__: string
declare const __REPO_SLUG__: string
declare const __BUILD_COMMIT__: string

/** scrypt work factor (log2 N). 17, not age's own CLI default of 18 —
 * memory-bound so unlock never risks a mobile tab being discarded (spec §5.4). */
export const SCRYPT_LOG_N = 17

/** Path of the encrypted vault file on the `data` branch (spec §6.1). */
export const VAULT_PATH = "vault.age"

/** Orphan branch holding the encrypted vault and its plaintext README (spec §6.1). */
export const DATA_BRANCH = "data"

/** The GitHub account that owns this deployment's repo. Baked in at build
 * time from Vercel's `VERCEL_GIT_REPO_OWNER`; the user is never asked to
 * type it (spec §9.2). Falls back to "test-owner" when unset. */
export function repoOwner(): string {
  return __REPO_OWNER__
}

/** The GitHub repo slug of this deployment. Baked in at build time from
 * Vercel's `VERCEL_GIT_REPO_SLUG` (spec §9.2). Falls back to "test-repo"
 * when unset. */
export function repoSlug(): string {
  return __REPO_SLUG__
}

/** The git commit SHA this bundle was built from, baked in at build time
 * from Vercel's `VERCEL_GIT_COMMIT_SHA`. Defaults to "dev" for local builds
 * and tests, where no such commit is known pre-build.
 *
 * This is deliberately *not* a hash of the bundle itself — a bundle cannot
 * contain the SHA-256 of itself. The supply-chain integrity display (spec
 * §10.2) instead measures the running bundle's hash at runtime and compares
 * it against a value CI publishes; BUILD_COMMIT only identifies which
 * commit produced this build. */
export const BUILD_COMMIT: string = __BUILD_COMMIT__
