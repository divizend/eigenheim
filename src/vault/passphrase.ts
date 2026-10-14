// Passphrase generation and the strength floor (spec §5.5). There is no
// recovery key and no password reset anywhere in this project (spec §2) —
// the passphrase is the only door into the vault, forever — so this file is
// the one thing standing between a user and a vault that is either
// trivially crackable or permanently lost. This file has no Node types and
// must stay that way (tsconfig.app.json covers `src/` with DOM libs only):
// crypto.getRandomValues, Uint32Array, Set, String -- nothing beyond what a
// browser provides.

import dicewareRaw from "./wordlists/diceware.txt?raw"
import commonPasswordsRaw from "./wordlists/common-passwords.txt?raw"

/** Splits a vendored wordlist's raw text into a frozen array of non-empty,
 * whitespace-trimmed lines. Shared by both bundled lists below so a stray
 * CRLF or trailing blank line can never silently become a list entry. */
function linesOf(raw: string): readonly string[] {
  return Object.freeze(
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  )
}

/** The EFF long wordlist (`eff_large_wordlist.txt`), numeric dice-roll
 * prefixes stripped, one word per line: 7776 words -- diceware's full 6^5
 * roll space. Exported, not just used internally, because
 * passphrase.test.ts asserts every generated word is drawn from exactly
 * this list (ruling R8). Source:
 * https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt */
export const DICEWARE: readonly string[] = linesOf(dicewareRaw)

/** A filtered slice of SecLists' `Pwdb_top-10000.txt` (the current
 * equivalent of the "top 10 000 common passwords" list the design spec
 * names -- the originally-named `10-million-password-list-top-10000.txt`
 * no longer exists in that repo): entries of length >=4 only, 9641 of the
 * original 10000.
 *
 * The plan's original filter was >=20 characters -- the length floor below
 * already rejects anything shorter, so the reasoning went that bundling
 * shorter entries was dead weight. Measured against the real list that
 * filter leaves only 5 of 10000 entries (two of them hash-like garbage),
 * which can never catch the realistic weak-but-long passphrase: a common
 * word with digits padded on to clear the length floor (e.g.
 * "password1234567890123").
 *
 * The threshold below that (>=6) turned out to still be wrong, the same
 * way: it excluded "zorro" (5 characters, a genuine top-10000 entry), so
 * "zorro" + 15 digits (20 codepoints total) cleared the length floor,
 * matched no bundled entry via stripNonLetterEnds, and had enough distinct
 * digits to clear the distinct-codepoint floor too -- `checkPassphrase`
 * returned `{ ok: true }` for it. Confirmed live before lowering the
 * threshold (see passphrase.test.ts's regression test for this exact
 * string). >=4 is the floor, not >=1: a 1-3 character stripped core
 * ("i", "the", "car") would start matching common short words/function
 * words far too eagerly, and a passphrase reduced to that short a core is
 * already very likely to also trip the distinct-codepoint floor on its
 * padding alone -- so >=4 is where real coverage gain stops and false-positive
 * risk starts outweighing it. Do not raise this back to >=6 (or further)
 * without re-reading this comment: that reopens the exact hole above.
 * Source:
 * https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/Pwdb_top-10000.txt */
const COMMON_PASSWORDS: readonly string[] = linesOf(commonPasswordsRaw)

/** Lowercased once at module load for O(1) case-insensitive membership
 * checks, rather than re-lowercasing the whole list on every
 * checkPassphrase call. Casing in the vendored file itself is left exactly
 * as SecLists ships it (e.g. "password", "Password" and "PASSWORD" all
 * appear as separate lines) -- folding happens only here, at comparison
 * time, never on the passphrase that gets returned or stored. */
const COMMON_PASSWORDS_LOWER: ReadonlySet<string> = new Set(COMMON_PASSWORDS.map((w) => w.toLowerCase()))

const MIN_LENGTH = 20
const MIN_DISTINCT_CODEPOINTS = 8

/** Strips surrounding whitespace and nothing else. Every passphrase entry
 * point (generation's own output, setup, unlock) must route through this
 * function so the form generated, judged, encrypted and compared is always
 * the same one.
 *
 * This must NEVER apply Unicode normalisation (spec §5.5 rule 2): a
 * passphrase is encoded UTF-8 and passed through untouched, exactly as
 * `age` does. Normalising on write would mean a passphrase that opens the
 * vault in this app but fails under the real `age -d` CLI -- breaking the
 * one guarantee this project rests on. `.trim()` only removes whitespace
 * (per the ECMAScript "WhiteSpace"/"LineTerminator" definitions) and does
 * not recompose or decompose any character, so it carries no normalisation
 * risk. */
export function normalizePassphrase(p: string): string {
  return p.trim()
}

/** Draws a uniform random integer in [0, exclusiveMax) from
 * crypto.getRandomValues using rejection sampling -- never modulo on its
 * own, which would silently bias the result whenever exclusiveMax does not
 * evenly divide the random source's range (2^32 is not a multiple of 7776,
 * the diceware list's length). The accepted range below (`limit`) is the
 * largest multiple of exclusiveMax that fits in a Uint32, so every draw
 * that survives rejection maps onto [0, exclusiveMax) with exactly equal
 * probability per index; draws at or above it are redrawn, never folded. */
function randomIndex(exclusiveMax: number): number {
  const limit = Math.floor(0x1_0000_0000 / exclusiveMax) * exclusiveMax
  const draw = new Uint32Array(1)
  let value: number
  do {
    crypto.getRandomValues(draw)
    value = draw[0]
  } while (value >= limit)
  return value % exclusiveMax
}

/** Generates a fresh diceware-style passphrase: `words` entries drawn
 * independently and uniformly at random from {@link DICEWARE}, joined with
 * single spaces (default 6 words, ~77 bits of entropy at 7776 words/slot --
 * spec §5.5). Setup prefills this; the user may keep it or replace it with
 * anything that clears {@link checkPassphrase}. */
export function generatePassphrase(words = 6): string {
  const picked: string[] = []
  for (let i = 0; i < words; i++) {
    picked.push(DICEWARE[randomIndex(DICEWARE.length)])
  }
  return picked.join(" ")
}

/** Strips leading and trailing runs of non-letter characters -- digits,
 * punctuation, symbols, emoji, whitespace, using Unicode's own letter
 * property (`\p{L}`, not an ASCII-only guess, and matched with the `u` flag
 * so astral-plane characters are treated as one codepoint each rather than
 * as lone surrogate halves) -- leaving interior characters untouched. This
 * is what catches a common word with padding bolted on to clear the length
 * floor, e.g. "password1234567890123" -> "password". A string with no
 * letters at all (e.g. all digits, or all emoji) strips down to "", which
 * matches no bundled entry (the shortest is 6 characters). */
function stripNonLetterEnds(p: string): string {
  return p.replace(/^[^\p{L}]+/u, "").replace(/[^\p{L}]+$/u, "")
}

/** The passphrase strength floor (spec §5.5, extended by ruling R11 -- see
 * `.superpowers/sdd/2026-10-14-eigenheim/progress.md`). Always runs
 * {@link normalizePassphrase} first, so the form judged here can never
 * disagree with the form that gets encrypted. Rejects on the first of these
 * that holds, each with a `reason` naming the rule in plain language:
 *
 *   1. fewer than 20 codepoints (`[...p].length`, not `.length` -- an emoji
 *      or a CJK character must count once, never per UTF-16 unit)
 *   2. the whole passphrase, case-insensitively, is one of the bundled
 *      common passwords
 *   3. the passphrase with leading/trailing non-letters stripped is,
 *      case-insensitively, one of those same common passwords -- catches
 *      length-padding built around a common word
 *   4. fewer than 8 distinct codepoints -- catches length-padding built
 *      from one or two repeated characters (e.g.
 *      "aaaaaaaaaaaaaaaaaaaaaa"), which rule 3 cannot catch: there is no
 *      letter run to strip it down to, since the whole string is already
 *      one repeated letter
 *
 * There is no character-set restriction anywhere here, by design -- full
 * Unicode is accepted (spec §5.5). No rule inspects *which* characters are
 * used, only *how many* there are and *whether* the result matches a
 * known-weak list. */
export function checkPassphrase(p: string): { ok: true } | { ok: false; reason: string } {
  const normalized = normalizePassphrase(p)
  const codepoints = [...normalized]

  if (codepoints.length < MIN_LENGTH) {
    return {
      ok: false,
      reason: `Too short: this passphrase has ${codepoints.length} characters, but at least ${MIN_LENGTH} are required.`,
    }
  }

  const lower = normalized.toLowerCase()
  if (COMMON_PASSWORDS_LOWER.has(lower)) {
    return {
      ok: false,
      reason: "This is one of the most common passwords in the world. Choose something that is not a well-known password.",
    }
  }

  const strippedLower = stripNonLetterEnds(normalized).toLowerCase()
  if (COMMON_PASSWORDS_LOWER.has(strippedLower)) {
    return {
      ok: false,
      reason:
        "This is a common password with extra characters added to the front or back. Choose something that is not just a well-known word with padding.",
    }
  }

  const distinctCodepoints = new Set(codepoints).size
  if (distinctCodepoints < MIN_DISTINCT_CODEPOINTS) {
    return {
      ok: false,
      reason: `This passphrase repeats only ${distinctCodepoints} distinct characters. Use a passphrase with more variety, not one character repeated to reach the length requirement.`,
    }
  }

  return { ok: true }
}
