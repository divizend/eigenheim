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
 * `"\r"` corruption on merge (Review Focus 1). Only the last element of the
 * result can ever lack a trailing terminator -- every earlier split happens
 * right after a `"\n"` by construction. */
function splitLines(text: string): string[] {
  return text.split(/(?<=\n)/)
}

/** Counts, among already-split lines, how many end in `"\r\n"` vs. a bare
 * `"\n"`. A line with no terminator at all (only ever possible as the last
 * element of a {@link splitLines} result) contributes to neither count,
 * rather than being forced into one. */
function countTerminators(lines: string[]): { crlf: number; lf: number } {
  let crlf = 0
  let lf = 0
  for (const line of lines) {
    if (line.endsWith("\r\n")) crlf++
    else if (line.endsWith("\n")) lf++
  }
  return { crlf, lf }
}

/** Strict-majority CRLF vs. bare LF from a {@link countTerminators} result.
 * `undefined` when there's nothing to go on (no terminated lines at all) --
 * deliberately not defaulted here, so each caller picks its own fallback
 * rather than this function silently picking one for every caller. */
function pickTerminator(counts: { crlf: number; lf: number }): "\r\n" | "\n" | undefined {
  if (counts.crlf === 0 && counts.lf === 0) return undefined
  return counts.crlf > counts.lf ? "\r\n" : "\n"
}

/** Appends a conflict-marker line to `parts`, first inserting `eol` if the
 * content immediately before it doesn't already end in a newline.
 *
 * A conflict region's content comes straight from an input, verbatim --
 * including, possibly, a final line with no trailing terminator at all (the
 * document's own last line, mid-conflict). Pushing a marker string directly
 * after that would concatenate the two with nothing in between (e.g.
 * `"mine" + "======="` reads as one glued line, `mine=======`) -- not a
 * conflict a person can read, let alone resolve. This is the one place a
 * terminator is inserted that didn't come from splitting an input or from
 * the marker's own trailing `eol`. */
function pushMarker(parts: string[], marker: string, eol: "\r\n" | "\n"): void {
  if (parts.length > 0 && !parts[parts.length - 1].endsWith("\n")) parts.push(eol)
  parts.push(marker + eol)
}

// node-diff3's types are reasonably precise here, not `any`: package.json's
// `exports.types` points at `src/diff3.d.ts`, and this project's
// `moduleResolution: "bundler"` resolves through that condition (confirmed:
// `tsc --listFiles` under this project's own tsconfig.app.json loads
// node_modules/node-diff3/src/diff3.d.ts). `src/diff3.d.ts` declares
// `diff3Merge<T = string>(a, o, b, options?): MergeRegion<T>[]`, with
// `MergeRegion<T> = { ok?: T[]; conflict?: { a: T[]; aIndex: number; b: T[];
// bIndex: number; o: T[]; oIndex: number } }`.
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
 * lines directly (with their own explicit, per-region line ending -- see
 * {@link pickTerminator}/{@link pushMarker} -- which the library's flattened
 * wrapper output does not carry) instead of needing to pick them back out of
 * a flattened array by matching literal marker text -- which would be
 * ambiguous against vault content that happens to already contain a line
 * that looks like a marker. */
export function merge3(base: string, mine: string, theirs: string): { text: string; conflicted: boolean } {
  const mineLines = splitLines(mine)
  const baseLines = splitLines(base)
  const theirsLines = splitLines(theirs)

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
  const regions = diff3Merge(mineLines, baseLines, theirsLines) as Region[]

  // Fallback for a conflict region whose own lines carry no terminator to
  // read a convention from at all (e.g. a single-line document with no
  // trailing newline anywhere) -- the document-wide convention one level up,
  // defaulting to "\n" if even that comes up empty. Deriving this per
  // conflict region (below), rather than once for the whole document, matters
  // for a document that isn't uniformly CRLF or LF throughout: a CRLF
  // conflict region in an otherwise-LF document still needs CRLF markers, not
  // the document's own majority.
  const documentEol = pickTerminator(countTerminators([...mineLines, ...baseLines, ...theirsLines])) ?? "\n"

  let conflicted = false
  const parts: string[] = []
  for (const region of regions) {
    if ("ok" in region) {
      parts.push(...region.ok)
    } else {
      conflicted = true
      const eol = pickTerminator(countTerminators([...region.conflict.a, ...region.conflict.b])) ?? documentEol
      pushMarker(parts, "<<<<<<< mine", eol)
      parts.push(...region.conflict.a)
      pushMarker(parts, "=======", eol)
      parts.push(...region.conflict.b)
      pushMarker(parts, ">>>>>>> theirs", eol)
    }
  }

  // Every pushed element already carries its own line terminator -- either
  // from splitLines (content), appended explicitly by pushMarker (markers,
  // and the content immediately before one when it lacked one of its own) --
  // so the join itself is "", not "\n".
  return { text: parts.join(""), conflicted }
}
