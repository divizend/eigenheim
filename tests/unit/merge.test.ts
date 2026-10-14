import { merge3 } from "../../src/vault/merge"

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
test("a two-sided CRLF conflict keeps the markers CRLF too, not mixed with bare LF", () => {
  // Review Focus 1, conflict path: the test above never reaches a conflict
  // (theirs is byte-identical to base), so it can't catch marker lines
  // defaulting to "\n" while CRLF content lines merge in around them.
  const r = merge3("a\r\n", "mine\r\n", "theirs\r\n")
  expect(r.conflicted).toBe(true)
  expect(r.text).toBe("<<<<<<< mine\r\nmine\r\n=======\r\ntheirs\r\n>>>>>>> theirs\r\n")
})
