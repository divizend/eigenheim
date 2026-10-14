// Three-way merge: what makes concurrent editing safe rather than
// destructive. Writes to GitHub are conditional (spec §6.4) — a stale write
// is rejected, never clobbered — and on rejection the client decrypts all
// three locally-available versions (the base a draft was built on, the
// current remote head, and the local draft) and merges them here. No edit
// is ever silently lost: a region neither side touched merges cleanly, a
// region only one side touched takes that side, and a region both sides
// touched differently is shown to the user as a conflict (spec §6.5), never
// resolved automatically. This file has no Node types available
// (tsconfig.app.json covers `src/`) and must stay that way.

import { diff3Merge } from "node-diff3"

/** Splits text into lines, keeping each line's own terminator (if any)
 * attached to it -- e.g. `"a\r\nb\n"` -> `["a\r\n", "b\n"]`. A plain
 * `split("\n")` would strand a trailing `"\r"` on every line of CRLF
 * (Windows/Word-pasted) text, producing spurious whole-file conflicts and
 * `"\r"` corruption on merge (Review Focus 1). */
function splitLines(text: string): string[] {
  return text.split(/(?<=\n)/)
}

// node-diff3's own `.d.mts` types every diff3Merge parameter and return value
// as `any` -- this is the precise shape its implementation actually produces
// when given three string arrays (node_modules/node-diff3/src/diff3.mjs):
// stable/resolved regions accumulate into one `ok` block, and a true conflict
// becomes its own block carrying each side's own lines. Narrowed here, at the
// one boundary where the library's looseness enters, rather than letting
// `any` leak into merge3's own signature.
interface ConflictRegion {
  a: string[]
  b: string[]
}
type Region = { ok: string[] } | { conflict: ConflictRegion }

/** Three-way merges `mine` and `theirs`, both derived from `base`.
 *
 * Regions neither side touched, or only one side touched, merge without
 * conflict. A region both sides changed differently is rendered with the
 * conventional two-sided conflict markers -- `<<<<<<< mine`, `=======`,
 * `>>>>>>> theirs` -- for the user to resolve (spec §6.5); `conflicted` is
 * `true` whenever at least one such region exists.
 *
 * Built on `diff3Merge`, the library's lower-level region output, rather
 * than its own `merge`/`mergeDiff3` wrappers: this builds the three marker
 * lines directly (with their own explicit `"\n"`, which the library's
 * flattened wrapper output does not carry) instead of needing to pick them
 * back out of a flattened array by matching literal marker text -- which
 * would be ambiguous against vault content that happens to already contain a
 * line that looks like a marker. */
export function merge3(base: string, mine: string, theirs: string): { text: string; conflicted: boolean } {
  // node-diff3's parameter order is (a, o, b) with the ORIGINAL/BASE in the
  // middle, not first -- mapped here as (mine, base, theirs). Verified
  // empirically, not assumed: swapping to (base, mine, theirs) still passes
  // the non-overlapping/empty-base/identical-sides cases but silently
  // returns "a" instead of "b" for `merge3("a\n", "b\n", "a\n")`, i.e. a
  // one-sided edit on "mine" alone is dropped.
  // diff3Merge only applies its `stringSeparator` option (default /\s+/,
  // which would shred lines on internal whitespace) when an argument's
  // typeof is "string" -- passing already-split arrays, as here, makes that
  // option entirely inapplicable rather than merely overridden.
  const regions = diff3Merge(splitLines(mine), splitLines(base), splitLines(theirs)) as Region[]

  let conflicted = false
  const parts: string[] = []
  for (const region of regions) {
    if ("ok" in region) {
      parts.push(...region.ok)
    } else {
      conflicted = true
      parts.push("<<<<<<< mine\n", ...region.conflict.a, "=======\n", ...region.conflict.b, ">>>>>>> theirs\n")
    }
  }

  // Every pushed element already carries its own line terminator -- either
  // from splitLines (content) or appended explicitly above (markers) -- so
  // the join itself is "", not "\n".
  return { text: parts.join(""), conflicted }
}
