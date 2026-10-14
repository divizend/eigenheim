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

/** Picks the line terminator the conflict markers themselves should use:
 * strict majority CRLF vs. bare LF, counted across all three inputs combined
 * (a tie -- including the no-CRLF-anywhere and all-inputs-empty cases --
 * resolves to `"\n"`). The markers are the one piece of the merged text this
 * module writes itself rather than copying verbatim from an input, so --
 * unlike content lines, which always keep whatever terminator they already
 * had -- they need an explicit choice. Defaulting that choice to `"\n"`
 * unconditionally would hand a Windows/Word user back a document with CRLF
 * content interleaved with LF-only marker lines: technically mergeable, but
 * visibly inconsistent line endings in exactly the conflict view they're
 * asked to read and resolve. */
function dominantTerminator(...texts: string[]): "\r\n" | "\n" {
  const count = (re: RegExp) => texts.reduce((n, t) => n + (t.match(re)?.length ?? 0), 0)
  return count(/\r\n/g) > count(/(?<!\r)\n/g) ? "\r\n" : "\n"
}

// node-diff3's types are reasonably precise here, not `any`: package.json's
// `exports.types` points at `src/diff3.d.ts`, and this project's
// `moduleResolution: "bundler"` resolves through that condition (confirmed:
// `tsc --listFiles` under this project's own tsconfig.app.json loads
// node_modules/node-diff3/src/diff3.d.ts, not the untyped dist/diff3.d.mts
// that a legacy `moduleResolution: "node"` would fall back to instead).
// `src/diff3.d.ts` declares `diff3Merge<T = string>(a, o, b, options?):
// MergeRegion<T>[]`, with `MergeRegion<T> = { ok?: T[]; conflict?: { a: T[];
// aIndex: number; b: T[]; bIndex: number; o: T[]; oIndex: number } }`.
//
// The local `Region` type below isn't rescuing the signature from `any` --
// it exists for a cleaner call site. `MergeRegion` makes `ok`/`conflict` both
// optional on the *same* object (only one is ever actually populated per
// region) and carries `aIndex`/`bIndex`/`o`/`oIndex`, which this module never
// reads. `Region` is a true discriminated union over just the two fields
// used here, so the `"ok" in region` check below narrows precisely.
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
 * lines directly (with their own explicit, {@link dominantTerminator}-chosen
 * line ending, which the library's flattened wrapper output does not carry)
 * instead of needing to pick them back out of a flattened array by matching
 * literal marker text -- which would be ambiguous against vault content that
 * happens to already contain a line that looks like a marker. */
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
  const eol = dominantTerminator(base, mine, theirs)

  let conflicted = false
  const parts: string[] = []
  for (const region of regions) {
    if ("ok" in region) {
      parts.push(...region.ok)
    } else {
      conflicted = true
      parts.push(`<<<<<<< mine${eol}`, ...region.conflict.a, `=======${eol}`, ...region.conflict.b, `>>>>>>> theirs${eol}`)
    }
  }

  // Every pushed element already carries its own line terminator -- either
  // from splitLines (content) or appended explicitly above (markers) -- so
  // the join itself is "", not "\n".
  return { text: parts.join(""), conflicted }
}
