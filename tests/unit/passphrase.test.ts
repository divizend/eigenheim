import { generatePassphrase, checkPassphrase, normalizePassphrase, DICEWARE } from "../../src/vault/passphrase"

// 20 distinct single-codepoint emoji, U+1F510 (🔐) through U+1F523 (🔣),
// each a UTF-16 surrogate pair (2 code units) -- used below to prove
// codepoint counting, not UTF-16-unit or byte counting, decides the length
// floor (spec §5.5 rule 1), without colliding with the distinct-codepoint
// floor (rule 4, see "rejects long passphrases that repeat too few
// distinct characters"): a single repeated emoji would trip rule 4 instead
// of isolating rule 1.
const TWENTY_DISTINCT_EMOJI = "🔐🔑🔒🔓🔔🔕🔖🔗🔘🔙🔚🔛🔜🔝🔞🔟🔠🔡🔢🔣"

test("generates six words from the bundled list", () => {
  const w = generatePassphrase().split(" ")
  expect(w).toHaveLength(6)
  w.forEach((word) => expect(DICEWARE).toContain(word))
})
test("generated passphrases pass the floor and differ from each other", () => {
  expect(checkPassphrase(generatePassphrase())).toEqual({ ok: true })
  expect(generatePassphrase()).not.toBe(generatePassphrase())
})
test("every generated passphrase passes the floor, not just by chance", () => {
  // The single check above only touches 6 of 7776 words, so it would not
  // reliably catch one malformed wordlist entry (e.g. one starting or
  // ending in a non-letter, which would let rule 3's stripping fire
  // unexpectedly on a generated passphrase). This repeats it enough to
  // exercise a meaningful slice of the list instead of trusting one draw.
  for (let i = 0; i < 500; i++) {
    expect(checkPassphrase(generatePassphrase())).toEqual({ ok: true })
  }
})
test("rejects anything under 20 characters", () => {
  // spec §5.5
  expect(checkPassphrase("short").ok).toBe(false)
  expect(checkPassphrase("x".repeat(19)).ok).toBe(false)
  // Deliberately not "x".repeat(20) here: under ruling R11's rule 4, one
  // character repeated to clear the length floor IS the length-padding
  // attack that rule exists to catch (see the "too few distinct
  // characters" test below) -- so "x".repeat(20) would now be ok:false,
  // for a different reason than the one this test isolates. A real
  // 20-character, >=8-distinct-codepoint, non-dictionary string is used
  // instead, so this test proves the length rule alone.
  expect(checkPassphrase("abcdefghijklmnopqrst").ok).toBe(true)
})
test("rejects a common password even when long enough", () => {
  // stripped-core match (rule 3): the whole 21-character string is not
  // itself a bundled entry, but stripping the trailing digits leaves
  // "password", which is in the bundled list (verified directly against it).
  expect(checkPassphrase("password1234567890123").ok).toBe(false)
})
test("rejects a short common password padded with digits — the case that set the >=4 bundling floor", () => {
  // "zorro" is a genuine top-10000 entry at 5 characters. It was originally
  // excluded by a >=6 bundling floor, which meant "zorro" + 15 digits (20
  // codepoints total, matching rule 1's floor exactly) stripped down to
  // "zorro" via rule 3, matched nothing in the (too-narrow) bundled list,
  // and had 13 distinct codepoints -- comfortably clearing rule 4 too. This
  // is exactly the hole that motivated lowering the floor to >=4: do not
  // raise COMMON_PASSWORDS' bundling threshold back toward >=6 without
  // re-reading that comment in passphrase.ts, or this regresses silently.
  expect(checkPassphrase("zorro123456789012345").ok).toBe(false)
})
test("rejects a common password matched exactly, not just as a stripped core", () => {
  // "1q2w3e4r5t6y7u8i9o0p" is a real, >=20-character entry in the bundled
  // list (SecLists Pwdb_top-10000.txt) -- this exercises whole-string
  // membership (rule 2) directly, distinct from the stripped-core rule
  // (rule 3) the test above exercises.
  expect(checkPassphrase("1q2w3e4r5t6y7u8i9o0p").ok).toBe(false)
})
test("rejects long passphrases that repeat too few distinct characters", () => {
  // ruling R11 rule 4 -- catches length-padding a dictionary check cannot:
  // a repeated character (or two) clears the 20-character floor and
  // matches no dictionary entry, but carries far less entropy than its
  // length suggests.
  expect(checkPassphrase("a".repeat(22)).ok).toBe(false)
  expect(checkPassphrase("ab".repeat(11)).ok).toBe(false) // 22 chars, still only 2 distinct
})
test("accepts full Unicode — umlauts, CJK, emoji", () => {
  // spec §5.5. There is no character-set restriction: age and age-encryption
  // both hash the raw UTF-8 bytes, so no special handling is needed.
  expect(checkPassphrase("schlüsselwort-für-mein-eigenheim-日本語-🔐")).toEqual({ ok: true })
})
test("counts length in codepoints, not UTF-16 units or bytes", () => {
  expect([...TWENTY_DISTINCT_EMOJI]).toHaveLength(20) // sanity on the fixture itself: 40 UTF-16 units, 20 codepoints
  expect(checkPassphrase(TWENTY_DISTINCT_EMOJI).ok).toBe(true)
  expect(checkPassphrase([...TWENTY_DISTINCT_EMOJI].slice(0, 19).join("")).ok).toBe(false)
})
test("strips surrounding whitespace before judging or using it", () => {
  // Review Focus 2 — a pasted trailing newline is otherwise unreproducible
  // by hand, in this app or in the CLI, and there is no recovery key.
  expect(normalizePassphrase("  my-long-enough-passphrase\n")).toBe("my-long-enough-passphrase")
  expect(checkPassphrase("  short  ").ok).toBe(false) // judged on the stripped form
})
test("uses rejection sampling, not modulo, over the word list", () => {
  // every index must be reachable; a modulo fold silently biases the tail
  const seen = new Set<string>()
  for (let i = 0; i < 20000; i++) seen.add(generatePassphrase(1))
  expect(seen.size).toBeGreaterThan(DICEWARE.length * 0.9)
})
test("each rejection reason names which rule fired, in words a non-technical user can act on", () => {
  const tooShort = checkPassphrase("short")
  const exactCommon = checkPassphrase("1q2w3e4r5t6y7u8i9o0p")
  const paddedCommon = checkPassphrase("password1234567890123")
  const tooFewDistinct = checkPassphrase("a".repeat(22))

  expect(tooShort).toEqual({ ok: false, reason: expect.stringMatching(/character/i) })
  expect(exactCommon).toEqual({ ok: false, reason: expect.stringMatching(/common/i) })
  expect(paddedCommon).toEqual({ ok: false, reason: expect.stringMatching(/common/i) })
  expect(tooFewDistinct).toEqual({ ok: false, reason: expect.stringMatching(/distinct/i) })

  // the four reasons must be distinguishable from each other, not a single
  // generic "invalid passphrase" string reused everywhere
  const reasons = new Set([tooShort, exactCommon, paddedCommon, tooFewDistinct].map((r) => (r.ok ? "" : r.reason)))
  expect(reasons.size).toBe(4)
})
