import { generatePassphrase, checkPassphrase, normalizePassphrase, DICEWARE, randomIndex } from "../../src/vault/passphrase"

// 20 distinct single-codepoint emoji, stepping by 2 codepoints from U+1F510
// (so U+1F510, U+1F512, U+1F514, ... U+1F536 -- never two adjacent
// codepoints), each a UTF-16 surrogate pair (2 code units) -- used below to
// prove codepoint counting, not UTF-16-unit or byte counting, decides the
// length floor (spec §5.5 rule 1), without colliding with either the
// distinct-codepoint floor (rule 4: 20 distinct values, well over the
// 8-codepoint floor) or the sequential-run floor (rule 5: stepping by 2
// means no two adjacent characters are ever +-1 apart, verified below).
// An earlier version of this fixture stepped by 1 (U+1F510 through
// U+1F523, consecutively) -- which satisfied rule 4 but, after rule 5 was
// added, turned out to be a textbook 20-long ascending sequential run,
// exactly the pattern rule 5 exists to reject.
const TWENTY_DISTINCT_EMOJI = "🔐🔒🔔🔖🔘🔚🔜🔞🔠🔢🔤🔦🔨🔪🔬🔮🔰🔲🔴🔶"

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
  //
  // This also now covers rule 5 (sequential runs), the newest rule and the
  // one most likely to collide with generation by chance -- a long phrase
  // has many adjacent same-word letter pairs. A space never continues a
  // run (checked directly: the codepoint step from any letter to " " and
  // back is dozens, never +-1), so the true worst case across any
  // generated phrase is bounded by the single longest run inside any one
  // bundled word -- exhaustively computed over all 7776 words (not
  // sampled): exactly 4, uniquely in "overstuff" ("rstu"), 2 codepoints
  // under this rule's threshold of 6. That makes this loop a redundant
  // belt-and-braces check for rule 5 specifically, by construction, rather
  // than this test's only evidence for it -- which is deliberate: the
  // exhaustive proof is about the bundled *data*, this loop is about the
  // *code path* actually agreeing with it.
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
  // for a different reason than the one this test isolates. And
  // deliberately not "abcdefghijklmnopqrst" (used here previously) either:
  // once rule 5 (sequential runs) existed, the plain alphabet turned out to
  // BE a 20-long sequential run -- see "rejects long sequential runs" below,
  // which uses that exact string as one of its two cases. A shuffled
  // 20-letter string is used instead: 20 codepoints, 20 distinct, and (per
  // the same rule-5 algorithm) no run longer than 1, so this test proves
  // the length rule alone.
  expect(checkPassphrase("akblcmdneofpgqhrisjt").ok).toBe(true)
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
test("rejects long sequential runs, even with 8+ distinct characters", () => {
  // rule 5 -- the reviewer's own demonstrated hole in rules 1-4: a
  // sequence accumulates 8+ distinct codepoints long before 20 characters
  // (10 digits, or 20 letters here), so the distinct-codepoint floor (rule
  // 4) alone does not catch it.
  expect(checkPassphrase("01234567890123456789").ok).toBe(false) // ascending digit run
  expect(checkPassphrase("abcdefghijklmnopqrst").ok).toBe(false) // ascending letter run, the whole alphabet a-t
  // a descending run must be caught too -- direction-agnostic, not just ascending
  expect(checkPassphrase("tsrqponmlkjihgfedcba").ok).toBe(false)
  // but a direction REVERSAL must not be, however long the string: treating
  // every +-1 step as continuing one run (ignoring direction) would flag
  // "monopoly"'s internal "onop" as a run, which must not happen -- a
  // passphrase built from genuine alternating steps stays accepted.
  expect(checkPassphrase("abababababababababab-ok-long-enough-to-pass-length").ok).toBe(true)
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
test("every word index in the bundled list is reachable", () => {
  // This proves only reachability (every index can come up across many
  // draws) -- NOT unbiasedness. A naive `draw % 7776` fold over 32-bit
  // draws would still pass this assertion comfortably: it gives 2560 of
  // the 7776 indices (2^32 mod 7776) one extra draw out of ~552336
  // (floor(2^32/7776)) each -- only a ~0.00018% relative gap between the
  // most- and least-likely word's selection probability, invisible at any
  // sample size a unit test can afford. Proving the mechanism itself does
  // not fold with modulo is what the deterministic test below does
  // instead; this one is renamed from "uses rejection sampling, not
  // modulo" because it never actually demonstrated that, only
  // reachability.
  const seen = new Set<string>()
  for (let i = 0; i < 20000; i++) seen.add(generatePassphrase(1))
  expect(seen.size).toBeGreaterThan(DICEWARE.length * 0.9)
})
test("rejection sampling redraws on an out-of-range value instead of folding it with modulo", () => {
  // A plain `draw % exclusiveMax` would derive an index from the very
  // first draw, however large. This feeds a first draw of the maximum
  // possible Uint32 value -- guaranteed to be >= randomIndex's internal
  // rejection limit for exclusiveMax=7776, since 7776 does not evenly
  // divide 2^32 (floor(2^32/7776)*7776 is therefore strictly less than
  // 2^32, i.e. <= 0xffffffff) -- followed by a small, unambiguously valid
  // second draw. A modulo-only implementation would read the random source
  // exactly once and derive some index from 0xffffffff; this asserts both
  // that a second draw was actually requested, and that the returned index
  // came from it, not the first -- something a modulo fold cannot satisfy
  // no matter how many samples are taken.
  let calls = 0
  const draws = [0xffffffff, 42]
  const index = randomIndex(7776, (buf) => {
    buf[0] = draws[calls]
    calls += 1
  })
  expect(calls).toBe(2)
  expect(index).toBe(42)

  // The other half of the same property: a first draw that is already in
  // range must NOT trigger a second draw. Without this, an implementation
  // that unconditionally draws twice and uses only the second value would
  // also satisfy the two assertions above -- an unrealistic mutant, not a
  // live risk, but closing the test's own logic rather than leaving it
  // open.
  let singleCalls = 0
  const singleDrawIndex = randomIndex(7776, (buf) => {
    buf[0] = 100
    singleCalls += 1
  })
  expect(singleCalls).toBe(1)
  expect(singleDrawIndex).toBe(100)
})
test("each rejection reason names which rule fired, in words a non-technical user can act on", () => {
  const tooShort = checkPassphrase("short")
  const exactCommon = checkPassphrase("1q2w3e4r5t6y7u8i9o0p")
  const paddedCommon = checkPassphrase("password1234567890123")
  const tooFewDistinct = checkPassphrase("a".repeat(22))
  const sequentialRun = checkPassphrase("abcdefghijklmnopqrst")

  expect(tooShort).toEqual({ ok: false, reason: expect.stringMatching(/character/i) })
  expect(exactCommon).toEqual({ ok: false, reason: expect.stringMatching(/common/i) })
  expect(paddedCommon).toEqual({ ok: false, reason: expect.stringMatching(/common/i) })
  expect(tooFewDistinct).toEqual({ ok: false, reason: expect.stringMatching(/distinct/i) })
  expect(sequentialRun).toEqual({ ok: false, reason: expect.stringMatching(/sequential/i) })

  // the five reasons must be distinguishable from each other, not a single
  // generic "invalid passphrase" string reused everywhere
  const reasons = new Set(
    [tooShort, exactCommon, paddedCommon, tooFewDistinct, sequentialRun].map((r) => (r.ok ? "" : r.reason)),
  )
  expect(reasons.size).toBe(5)
})
